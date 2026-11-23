import fs from "node:fs";
import path from "node:path";
import { openAiClient } from "./openai-client.js";
import { PRESETS } from "./providers.js";
import { exitCode, renderBadge, renderMarkdown, renderSarif, renderText } from "./report.js";
import { signReport } from "./sign.js";
import { verify, type VerifyReport } from "./verify.js";
import type { ModelClient } from "apex-verify-engine";

export const VERIFY_USAGE = `apex verify "<what the change should do>" [--dir <project>] [--base <git ref> | --diff <file>] [--model <checker model>] [--provider gemini|openai|anthropic|openrouter | --base-url <url>] [--no-model] [--format text|json|markdown|sarif] [--out <file>] [--test "<command>"]
  Checks whether a change an AI agent (or a person) already made is really done. Nothing in your project is changed.
  --base       compare your working copy with this git ref (default HEAD; in a pull request: the base commit)
  --diff       or judge a unified diff instead of a git change
  --model      the model that writes the checks from your task: use a different, ideally stronger one than the agent that made the change
  --standard-cases   also ask for unstated standard-practice checks (CRLF, empty input); measured no gain, off by default
  --second-model <id> [--second-provider p]   a second, independent checker: NOT READY only when both object; one objection alone is UNKNOWN
  --fresh-inputs   ask the checker to use inputs other than the task's own examples (off by default; see benchmark/results)
  --demo           a 30-second demonstration on a built-in project: no key, nothing sent anywhere
  --lock-tests     run your tests with the base versions of any test files the change edited or deleted (an agent cannot edit its way to green)
  --sign-key <file>   sign the report (Ed25519; make a key with --gen-key <file>); check one with --check-report <file> [--pub-key <base64>]
  --badge-out <file>   write a shields.io endpoint badge (JSON) with the verdict
  --no-model   only the deterministic parts: the project's tests and the cheating scan (needs no key)
  --markdown-out / --sarif-out / --json-out <file>   also write those formats to a file (one run)
  --format     text (default), json (full report), markdown (for a pull request comment), sarif (code scanning)
  --hook       run as an agent's stop hook (Claude Code, Codex): reads the hook JSON on stdin, blocks "done" while the change is not ready
  --mcp        run as an MCP server exposing the verify_change tool
Exit codes: 0 ready, 1 not ready, 3 unknown (not enough to say), 2 usage or setup error.
Keys: GEMINI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / OPENROUTER_API_KEY (or --api-key-env NAME). Environment equivalents of the flags, for hooks and CI: APEX_CHECKER_MODEL, APEX_PROVIDER, APEX_BASE_URL, APEX_API_KEY_ENV.`;

export interface VerifyCliArgs {
  task: string; dir: string; base?: string; diffFile?: string; model?: string; baseUrl: string; apiKey?: string; noModel: boolean;
  format: "text" | "json" | "markdown" | "sarif"; out?: string; markdownOut?: string; sarifOut?: string; jsonOut?: string; testCommand?: string[]; timeoutSec: number; quiet: boolean; standardCases: boolean; freshInputs: boolean; badgeOut?: string; lockTests: boolean; signKey?: string;
  secondModel?: string; secondBaseUrl?: string; secondApiKey?: string;
}

export function parseVerifyArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): VerifyCliArgs {
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) flags.set(k!, v);
      else if (["no-model", "quiet", "json", "standard-cases", "fresh-inputs", "lock-tests"].includes(k!)) flags.set(k!, true);
      else flags.set(k!, argv[++i] ?? "");
    } else rest.push(a);
  }
  const task = (typeof flags.get("task") === "string" ? String(flags.get("task")) : rest.join(" ")).trim() || env.APEX_TASK?.trim() || "";
  if (!task) throw new Error('say what the change should do: apex verify "<task>"');
  const noModel = flags.get("no-model") === true;
  const envBase = env.APEX_BASE_URL?.trim();
  const provider = String(flags.get("provider") || env.APEX_PROVIDER || (flags.get("base-url") || envBase ? "" : "gemini"));
  const preset = PRESETS[provider];
  if (provider && !preset) throw new Error(`unknown provider ${provider}`);
  const baseUrl = String(flags.get("base-url") || envBase || preset?.baseUrl || "");
  const keyEnv = String(flags.get("api-key-env") || env.APEX_API_KEY_ENV || preset?.keyEnv || "");
  const apiKey = keyEnv ? env[keyEnv] : undefined;
  const model = String(flags.get("model") || env.APEX_CHECKER_MODEL || (provider === "gemini" ? "gemini-3.1-pro-preview" : "")) || undefined;
  if (!noModel) {
    if (!baseUrl) throw new Error("give --provider or --base-url (or --no-model)");
    if (keyEnv && !apiKey) throw new Error(`set ${keyEnv} (the key of the model that writes the checks), or use --no-model`);
    if (!model) throw new Error("--model is required: the model that writes the checks");
  }
  // An optional second, independent checker (ideally from another company): a change is NOT READY only when both object.
  const secondModel = flags.get("second-model") ? String(flags.get("second-model")) : env.APEX_SECOND_MODEL?.trim() || undefined;
  let secondBaseUrl = baseUrl, secondApiKey = apiKey;
  const sp = String(flags.get("second-provider") || env.APEX_SECOND_PROVIDER || "");
  if (secondModel && !noModel) {
    if (sp) {
      const p2 = PRESETS[sp]; if (!p2) throw new Error(`unknown provider ${sp}`);
      secondBaseUrl = p2.baseUrl; secondApiKey = p2.keyEnv ? env[p2.keyEnv] : undefined;
      if (p2.keyEnv && !secondApiKey) throw new Error(`set ${p2.keyEnv} (the key of the second checker), or drop --second-model`);
    }
  }
  const fmt = String(flags.get("format") || (flags.get("json") ? "json" : "text"));
  if (!["text", "json", "markdown", "sarif"].includes(fmt)) throw new Error(`unknown --format ${fmt}`);
  const test = flags.get("test");
  return {
    task, noModel, baseUrl, apiKey, model, format: fmt as VerifyCliArgs["format"],
    dir: path.resolve(String(flags.get("dir") || process.cwd())),
    ...(flags.get("base") ? { base: String(flags.get("base")) } : {}),
    ...(flags.get("diff") ? { diffFile: String(flags.get("diff")) } : {}),
    ...(flags.get("out") ? { out: String(flags.get("out")) } : {}),
    ...(flags.get("markdown-out") ? { markdownOut: String(flags.get("markdown-out")) } : {}),
    ...(flags.get("sarif-out") ? { sarifOut: String(flags.get("sarif-out")) } : {}),
    ...(flags.get("json-out") ? { jsonOut: String(flags.get("json-out")) } : {}),
    ...(typeof test === "string" && test ? { testCommand: test.split(/\s+/) } : {}),
    ...(secondModel && !noModel ? { secondModel, secondBaseUrl, secondApiKey } : {}), lockTests: flags.get("lock-tests") === true, ...(flags.get("sign-key") ? { signKey: String(flags.get("sign-key")) } : {}), ...(flags.get("badge-out") ? { badgeOut: String(flags.get("badge-out")) } : {}), freshInputs: flags.get("fresh-inputs") === true, timeoutSec: Number(flags.get("timeout")) || 90, quiet: flags.get("quiet") === true || fmt !== "text", standardCases: flags.get("standard-cases") === true,
  };
}

export const renderFormat = (r: VerifyReport, f: VerifyCliArgs["format"]) => (f === "json" ? JSON.stringify(r, null, 2) : f === "markdown" ? renderMarkdown(r) : f === "sarif" ? renderSarif(r) : renderText(r));

/** The checker(s) the arguments describe. */
export function checkersFrom(a: VerifyCliArgs, client?: ModelClient): { checker: { client: ModelClient; model: string } | null; secondChecker: { client: ModelClient; model: string } | null } {
  if (a.noModel) return { checker: null, secondChecker: null };
  return {
    checker: { client: client ?? openAiClient({ baseUrl: a.baseUrl, apiKey: a.apiKey }), model: a.model! },
    secondChecker: a.secondModel && !client ? { client: openAiClient({ baseUrl: a.secondBaseUrl ?? a.baseUrl, apiKey: a.secondApiKey ?? a.apiKey }), model: a.secondModel } : null,
  };
}

/** Runs the check and prints the result in the chosen format. Returns the exit code. */
export async function runVerify(a: VerifyCliArgs, out: (s: string) => void = console.log, err: (s: string) => void = console.error, client?: ModelClient): Promise<number> {
  if (!fs.existsSync(a.dir) || !fs.statSync(a.dir).isDirectory()) throw new Error(`directory not found: ${a.dir}`);
  const { checker, secondChecker } = checkersFrom(a, client);
  const report = await verify({ dir: a.dir, task: a.task, base: a.base, diffFile: a.diffFile, checker, secondChecker, testCommand: a.testCommand, timeoutSec: a.timeoutSec, standardCases: a.standardCases, freshInputs: a.freshInputs, lockTests: a.lockTests, onProgress: a.quiet ? undefined : (l) => err(l) });
  if (a.signKey) report.signature = signReport(report, a.signKey);
  if (a.markdownOut) fs.writeFileSync(a.markdownOut, renderMarkdown(report) + "\n");
  if (a.sarifOut) fs.writeFileSync(a.sarifOut, renderSarif(report) + "\n");
  if (a.badgeOut) fs.writeFileSync(a.badgeOut, renderBadge(report) + "\n");
  if (a.jsonOut) fs.writeFileSync(a.jsonOut, JSON.stringify(report, null, 2) + "\n");
  const text = renderFormat(report, a.format);
  if (a.out) fs.writeFileSync(a.out, text + "\n");
  if (!a.out || a.format === "text") out(text);
  return exitCode(report.verdict);
}
