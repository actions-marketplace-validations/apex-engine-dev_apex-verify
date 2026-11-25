import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { ModelClient, ModelEvent, ModelRequest } from "apex-verify-engine";
import { modelSignal } from "./openai-client.js";

/**
 * A checker that runs an AI coding CLI the person is already signed in to (Claude Code or Gemini CLI), so no API key is
 * needed. The CLI is asked one question with every tool turned off where the CLI allows it, in a fresh empty folder, so
 * it cannot read or change the project: it only sees the prompt Apex verify sends, as with an API checker.
 */
export type CliKind = "claude-cli" | "gemini-cli";

export const CLI_COMMAND: Record<CliKind, string> = { "claude-cli": "claude", "gemini-cli": "gemini" };

/** Whether an executable is on PATH (no shell, nothing is run). */
export function onPath(cmd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD").split(";") : [""];
  return (env.PATH ?? "").split(path.delimiter).some((d) => d && exts.some((e) => existsSync(path.join(d, cmd + e))));
}

/**
 * Whether Gemini CLI can answer without a key: it is set to sign in with a Google account (or Cloud Shell / the machine's
 * own Google credentials). Set to "gemini-api-key" or "vertex-ai", it needs a key in the environment too.
 */
export function geminiCliSignedIn(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const home = env.GEMINI_CLI_HOME || env.HOME || env.USERPROFILE || homedir();
    const j = JSON.parse(readFileSync(path.join(home, ".gemini", "settings.json"), "utf8"));
    const t = j.security?.auth?.selectedType ?? j.selectedAuthType;
    return t === "oauth-personal" || t === "cloud-shell" || t === "compute-default-credentials";
  } catch { return false; }
}

/** The CLI checker to use when no provider and no key are given: Gemini CLI if signed in with Google, else Claude Code. */
export function pickCli(env: NodeJS.ProcessEnv = process.env): CliKind | undefined {
  if (onPath("gemini", env) && geminiCliSignedIn(env)) return "gemini-cli";
  if (onPath("claude", env)) return "claude-cli";
  return undefined;
}

export interface CliClientOptions {
  kind: CliKind;
  /** Override the executable (tests). */
  command?: string;
  /** Override how the child is started (tests). */
  spawnImpl?: typeof spawn;
}

/** The prompt as one text: the CLIs take a single prompt, so earlier turns are labelled. */
export function flattenPrompt(req: ModelRequest): { system: string; prompt: string } {
  const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const rest = req.messages.filter((m) => m.role !== "system");
  const prompt = rest.length === 1 ? rest[0]!.content : rest.map((m) => `[${m.role === "assistant" ? "assistant" : "user"}]\n${m.content}`).join("\n\n");
  return { system, prompt };
}

export function cliArgs(kind: CliKind, model: string | undefined, system: string): string[] {
  if (kind === "claude-cli") {
    return ["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence",
      ...(system ? ["--system-prompt", system] : []), ...(model ? ["--model", model] : [])];
  }
  // Gemini CLI has no switch to remove its built-in tools. Headless, it does not run tools that need approval, and its
  // file tools are limited to the working folder, which is a new empty one.
  return ["-p", "", "-o", "json", "-e", "none", "--allowed-mcp-server-names", "none", ...(model ? ["-m", model] : [])];
}

/** The answer text and token counts from the CLI's JSON output. */
export function parseCliOutput(kind: CliKind, stdout: string): { text: string; inputTokens?: number; outputTokens?: number; error?: string } {
  let j: any;
  try { j = JSON.parse(stdout.slice(stdout.indexOf("{"))); } catch { return { text: "", error: `could not read the ${CLI_COMMAND[kind]} output: ${stdout.slice(0, 200)}` }; }
  if (kind === "claude-cli") {
    if (j.is_error || typeof j.result !== "string") return { text: "", error: `claude: ${String(j.result ?? j.subtype ?? "error").slice(0, 300)}` };
    const u = j.usage ?? {};
    return { text: j.result, inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), outputTokens: u.output_tokens };
  }
  if (j.error || typeof j.response !== "string") return { text: "", error: `gemini: ${String(j.error?.message ?? j.error ?? "no response").slice(0, 300)}` };
  let inputTokens = 0, outputTokens = 0;
  for (const m of Object.values<any>(j.stats?.models ?? {})) { inputTokens += m.tokens?.prompt ?? 0; outputTokens += m.tokens?.candidates ?? 0; }
  return { text: j.response, inputTokens, outputTokens };
}

export function cliClient(o: CliClientOptions): ModelClient {
  const run = o.spawnImpl ?? spawn;
  return {
    async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
      const { system, prompt } = flattenPrompt(req);
      const cwd = mkdtempSync(path.join(tmpdir(), "apex-checker-"));
      // Gemini CLI has no system-prompt flag; GEMINI_SYSTEM_MD replaces its own coding-agent prompt with ours, so it
      // answers as a check writer instead of acting as an agent.
      const extraEnv: Record<string, string> = {};
      if (o.kind === "gemini-cli") { const f = path.join(cwd, "system.md"); writeFileSync(f, system || "Answer the request."); extraEnv.GEMINI_SYSTEM_MD = f; }
      const input = prompt;
      const signal = modelSignal(req.signal);
      try {
        const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
          const child = run(o.command ?? CLI_COMMAND[o.kind], cliArgs(o.kind, req.model && req.model !== o.kind ? req.model : undefined, o.kind === "claude-cli" ? system : ""), { cwd, stdio: ["pipe", "pipe", "pipe"], signal, env: { ...process.env, APEX_IN_CHECKER: "1", ...extraEnv }, shell: process.platform === "win32" });
          let stdout = "", stderr = "";
          child.stdout!.on("data", (d) => (stdout += d));
          child.stderr!.on("data", (d) => (stderr += d));
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, stdout, stderr }));
          child.stdin!.end(input);
        });
        // Gemini CLI prints its errors as JSON on stderr, with nothing on stdout.
        const r = parseCliOutput(o.kind, out.stdout.includes("{") ? out.stdout : out.stderr);
        if (r.error || (out.code !== 0 && !r.text)) {
          yield { type: "error", message: r.error ?? `${CLI_COMMAND[o.kind]} exited ${out.code}: ${out.stderr.slice(0, 300)}` };
          return;
        }
        yield { type: "text-delta", text: r.text };
        yield { type: "usage", inputTokens: r.inputTokens, outputTokens: r.outputTokens };
        yield { type: "message-complete", message: { content: r.text } };
        yield { type: "done" };
      } catch (e: any) {
        yield { type: "error", message: e?.code === "ENOENT" ? `${CLI_COMMAND[o.kind]} is not installed or not on PATH` : e instanceof Error ? e.message : String(e) };
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  };
}
