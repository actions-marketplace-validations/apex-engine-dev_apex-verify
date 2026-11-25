import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { openAiClient } from "./openai-client.js";
import { PRESETS } from "./providers.js";
import { cliClient, pickCli, type CliKind } from "./cli-client.js";
import { exitCode, renderBadge, renderBadgeSvg, renderMarkdown, renderSarif, renderText } from "./report.js";
import { signReport } from "./sign.js";
import { verify, type VerifyReport } from "./verify.js";
import type { ModelClient } from "apex-verify-engine";

export const VERIFY_USAGE = `apex verify "<what the change should do>" [options]

  Checks whether a change an AI agent (or a person) already made is really done.
  Works on a copy: nothing in your project is changed.

  Try it first:   apex verify --demo        (5 seconds, no key, nothing sent anywhere)

What to check
  --dir <project>      the project folder (default: the current folder)
  --base <git ref>     compare your working copy with this ref (default HEAD; in a pull request: the base commit)
  --diff <file>        or judge a unified diff instead of a git change
  --test "<command>"   your test command, when it is not detected
  --timeout <seconds>  time limit for each test run (default 90)

The checker (the model that writes checks from your task; use a different one than your agent's)
  --provider <name>    gemini (default), openai, anthropic, openrouter; claude-cli or gemini-cli use that CLI you are signed in to (no key; picked automatically when no key is set); or --base-url <url> for any OpenAI-compatible endpoint
  --model <id>         the checker model
  --no-model           no model: only your tests and the cheating scan (needs no key; the verdict is at most unknown)

Output
  --format <f>         text (default), json (full report), markdown (for a pull request comment), sarif (code scanning)
  --out <file>         write the chosen format to a file
  --markdown-out / --sarif-out / --json-out <file>   also write those formats (one run)
  --badge-out <file>   write a badge with the verdict: shields.io endpoint JSON, or a static SVG when the file ends in .svg
  --quiet              no progress lines, just the report

Harder to fool
  --lock-tests         run your tests with the base versions of test files the change edited or deleted
  (shared defaults: a committed .apex-verify.json with provider, model, testCommand, timeout, lockTests; flags win)
  --sign-key <file>    sign the report (Ed25519). Make a key: --gen-key <file>. Check one: --check-report <file> --pub-key <base64>

Other ways to run it
  --hook               as an agent's stop hook (Claude Code, Gemini CLI, Codex): hook JSON on stdin, blocks "done" while not ready
  --mcp                as an MCP server exposing the verify_change tool
  --version            print the version

Experimental (measured, no gain so far; see docs/EXPERIMENTS.md)
  --second-model <id> [--second-provider <name>]   a second checker: NOT READY only when both object
  --standard-cases     also ask for unstated standard-practice checks
  --fresh-inputs       ask the checker to avoid the task's own example values

Exit codes: 0 ready, 1 not ready, 3 unknown (not enough to say), 2 usage or setup error.
Keys: GEMINI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / OPENROUTER_API_KEY (or --api-key-env NAME). Environment equivalents of the flags, for hooks and CI: APEX_CHECKER_MODEL, APEX_PROVIDER, APEX_BASE_URL, APEX_API_KEY_ENV.
Docs: https://github.com/apex-engine-dev/apex-verify`;

const isCli = (p: string): p is CliKind => p === "claude-cli" || p === "gemini-cli";

export interface VerifyCliArgs {
  task: string; dir: string; base?: string; diffFile?: string; model?: string; baseUrl: string; apiKey?: string; noModel: boolean; cli?: CliKind;
  format: "text" | "json" | "markdown" | "sarif"; out?: string; markdownOut?: string; sarifOut?: string; jsonOut?: string; testCommand?: string[]; timeoutSec: number; quiet: boolean; standardCases: boolean; freshInputs: boolean; badgeOut?: string; lockTests: boolean; signKey?: string;
  secondModel?: string; secondBaseUrl?: string; secondApiKey?: string; secondCli?: CliKind;
}

const BOOL_FLAGS = new Set(["no-model", "quiet", "json", "standard-cases", "fresh-inputs", "lock-tests", "demo", "hook", "mcp", "help", "version", "any-key"]);
const VALUE_FLAGS = new Set(["task", "dir", "base", "diff", "model", "provider", "base-url", "api-key-env", "format", "out", "markdown-out", "sarif-out", "json-out", "test", "timeout", "second-model", "second-provider", "badge-out", "sign-key", "gen-key", "check-report", "pub-key"]);

/** `--flag=value` becomes `--flag value` (split at the FIRST "="), `--boolean=false` is dropped, and everything after a bare `--` is the task. */
export function normalizeArgv(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") { const task = argv.slice(i + 1).join(" "); if (task) out.push("--task", task); break; }
    const m = /^--([A-Za-z][A-Za-z0-9-]*)=([\s\S]*)$/.exec(a);
    if (!m) { out.push(a); if (a.startsWith("--") && VALUE_FLAGS.has(a.slice(2)) && i + 1 < argv.length) out.push(argv[++i]!); continue; }
    const [, k, v] = m;
    if (BOOL_FLAGS.has(k!)) { if (!/^(false|0|no|off)$/i.test(v!)) out.push("--" + k); }
    else out.push("--" + k, v!);
  }
  return out;
}

const CONFIG_KEYS: Record<string, "string" | "number" | "boolean"> = { provider: "string", model: "string", testCommand: "string", timeout: "number", lockTests: "boolean" };
const CONFIG_FLAG: Record<string, string> = { provider: "provider", model: "model", testCommand: "test", timeout: "timeout", lockTests: "lock-tests" };
/** The project's committed settings as flag values. In a git repository the file comes from the base commit; with --diff (or outside git) from the folder itself, which is the original project. */
export function readProjectConfig(dir: string, base: string | undefined, diffMode: boolean): Record<string, string | true> {
  let text: string | null = null;
  const file = path.join(dir, ".apex-verify.json");
  if (!diffMode) {
    try {
      const prefix = execFileSync("git", ["-C", dir, "rev-parse", "--show-prefix"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      try { text = execFileSync("git", ["-C", dir, "show", `${base ?? "HEAD"}:${prefix}.apex-verify.json`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { text = null; }
    } catch { if (fs.existsSync(file)) text = fs.readFileSync(file, "utf8"); }
  } else if (fs.existsSync(file)) text = fs.readFileSync(file, "utf8");
  if (text === null) return {};
  let cfg: unknown;
  try { cfg = JSON.parse(text); } catch (e) { throw new Error(`.apex-verify.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`); }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error(".apex-verify.json must be a JSON object");
  const out: Record<string, string | true> = {};
  for (const [k, v] of Object.entries(cfg as Record<string, unknown>)) {
    const want = CONFIG_KEYS[k];
    if (!want) throw new Error(`.apex-verify.json: unknown setting "${k}" (allowed: ${Object.keys(CONFIG_KEYS).join(", ")}; keys never go in this file)`);
    if (typeof v !== want) throw new Error(`.apex-verify.json: "${k}" must be a ${want}`);
    if (want === "boolean") { if (v) out[CONFIG_FLAG[k]!] = true; } else out[CONFIG_FLAG[k]!] = String(v);
  }
  return out;
}

/** Whether a flag is present as a flag, not as the value of another flag (a task text of "--version" is a task, not a request for the version). `argv` is normalized. */
export function hasFlag(argv: string[], name: string): boolean {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === name) return true;
    if (a.startsWith("--") && VALUE_FLAGS.has(a.slice(2))) i++;
  }
  return false;
}

export function parseVerifyArgs(rawArgv: string[], env: NodeJS.ProcessEnv = process.env): VerifyCliArgs {
  const argv = normalizeArgv(rawArgv);
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const k = a.slice(2);
      if (BOOL_FLAGS.has(k)) flags.set(k, true);
      else if (VALUE_FLAGS.has(k)) flags.set(k, argv[++i] ?? "");
      else throw new Error(`unknown option --${k} (see apex --help). To start the task text with "--", put it after a bare "--".`);
    } else rest.push(a);
  }
  // A committed .apex-verify.json sets a team's defaults. It is read from the base commit, not from the working copy, so a change cannot rewrite the rules it is judged by. Flags win over it; it never holds keys.
  const cfgDir = path.resolve(String(flags.get("dir") || process.cwd()));
  for (const [k, v] of Object.entries(readProjectConfig(cfgDir, typeof flags.get("base") === "string" ? String(flags.get("base")) : undefined, flags.has("diff")))) if (!flags.has(k)) flags.set(k, v);
  const task = (typeof flags.get("task") === "string" ? String(flags.get("task")) : rest.join(" ")).trim() || env.APEX_TASK?.trim() || "";
  if (!task) throw new Error('say what the change should do: apex verify "<task>"');
  const noModel = flags.get("no-model") === true;
  const envBase = env.APEX_BASE_URL?.trim();
  const chosen = String(flags.get("provider") || env.APEX_PROVIDER || "");
  let provider = chosen || (flags.get("base-url") || envBase ? "" : "gemini");
  // No provider chosen and no Gemini key: use an AI CLI the person is already signed in to, so no key is needed.
  if (!noModel && !chosen && provider === "gemini" && !env.GEMINI_API_KEY && !flags.get("api-key-env") && !env.APEX_API_KEY_ENV) {
    const found = pickCli(env);
    if (found) provider = found;
  }
  const cli = isCli(provider) ? provider : undefined;
  const preset = PRESETS[provider];
  if (provider && !preset && !cli) throw new Error(`unknown provider ${provider}`);
  const baseUrl = String(flags.get("base-url") || envBase || preset?.baseUrl || "");
  const keyEnv = String(flags.get("api-key-env") || env.APEX_API_KEY_ENV || preset?.keyEnv || "");
  const apiKey = keyEnv ? env[keyEnv] : undefined;
  const model = String(flags.get("model") || env.APEX_CHECKER_MODEL || (provider === "gemini" ? "gemini-3.1-pro-preview" : cli ?? "")) || undefined;
  if (!noModel && !cli) {
    if (!baseUrl) throw new Error("give --provider or --base-url (or --no-model)");
    if (keyEnv && !apiKey) throw new Error(`set ${keyEnv} (the key of the model that writes the checks), or use --no-model`);
    if (!model) throw new Error("--model is required: the model that writes the checks");
  }
  // An optional second, independent checker (ideally from another company): a change is NOT READY only when both object.
  const secondModel = flags.get("second-model") ? String(flags.get("second-model")) : env.APEX_SECOND_MODEL?.trim() || undefined;
  let secondBaseUrl = baseUrl, secondApiKey = apiKey;
  const sp = String(flags.get("second-provider") || env.APEX_SECOND_PROVIDER || "");
  if (secondModel && !noModel) {
    if (isCli(sp)) secondBaseUrl = "";
    else if (sp) {
      const p2 = PRESETS[sp]; if (!p2) throw new Error(`unknown provider ${sp}`);
      secondBaseUrl = p2.baseUrl; secondApiKey = p2.keyEnv ? env[p2.keyEnv] : undefined;
      if (p2.keyEnv && !secondApiKey) throw new Error(`set ${p2.keyEnv} (the key of the second checker), or drop --second-model`);
    }
  }
  const fmt = String(flags.get("format") || (flags.get("json") ? "json" : "text"));
  if (!["text", "json", "markdown", "sarif"].includes(fmt)) throw new Error(`unknown --format ${fmt}`);
  const test = flags.get("test");
  return {
    task, noModel, baseUrl, apiKey, model, ...(cli && !noModel ? { cli } : {}), ...(isCli(sp) && secondModel && !noModel ? { secondCli: sp } : {}), format: fmt as VerifyCliArgs["format"],
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

/** Colour only for a person at a terminal: never when piped, never with NO_COLOR, and only on the default output. */
export const useColor = (): boolean => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";
export function colorize(text: string): string {
  const c = (code: number, s: string) => `\x1b[${code}m${s}\x1b[0m`;
  return text.split("\n").map((l) => {
    if (/^apex verify: READY/.test(l)) return c(1, c(32, l));
    if (/^apex verify: NOT READY/.test(l)) return c(1, c(31, l));
    if (/^apex verify: UNKNOWN/.test(l)) return c(1, c(33, l));
    if (/^\s+expected:/.test(l)) return c(32, l);
    if (/^\s+actual:/.test(l)) return c(31, l);
    if (/^\s+fix:/.test(l)) return c(33, l);
    if (/^\s+(tests|checks|change|sandbox|note):/.test(l) || /proof sha256:/.test(l)) return c(2, l);
    return l;
  }).join("\n");
}

export const renderFormat = (r: VerifyReport, f: VerifyCliArgs["format"]) => (f === "json" ? JSON.stringify(r, null, 2) : f === "markdown" ? renderMarkdown(r) : f === "sarif" ? renderSarif(r) : renderText(r));

/** The checker(s) the arguments describe. */
export function checkersFrom(a: VerifyCliArgs, client?: ModelClient): { checker: { client: ModelClient; model: string; cacheSecret?: string } | null; secondChecker: { client: ModelClient; model: string; cacheSecret?: string } | null } {
  if (a.noModel) return { checker: null, secondChecker: null };
  return {
    checker: { client: client ?? (a.cli ? cliClient({ kind: a.cli }) : openAiClient({ baseUrl: a.baseUrl, apiKey: a.apiKey })), model: a.model!, cacheSecret: a.apiKey || undefined },
    secondChecker: a.secondModel && !client ? { client: a.secondCli ? cliClient({ kind: a.secondCli }) : openAiClient({ baseUrl: a.secondBaseUrl ?? a.baseUrl, apiKey: a.secondApiKey ?? a.apiKey }), model: a.secondModel, cacheSecret: (a.secondApiKey ?? a.apiKey) || undefined } : null,
  };
}

/** Runs the check and prints the result in the chosen format. Returns the exit code. */
export async function runVerify(a: VerifyCliArgs, out: (s: string) => void = console.log, err: (s: string) => void = console.error, client?: ModelClient): Promise<number> {
  if (!fs.existsSync(a.dir) || !fs.statSync(a.dir).isDirectory()) throw new Error(`directory not found: ${a.dir}`);
  const { checker, secondChecker } = checkersFrom(a, client);
  // Ctrl-C (or a terminated CI job) stops the run and lets it clean up its scratch copy instead of leaving it behind.
  const ac = new AbortController();
  const onSignal = () => ac.abort();
  process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
  let report: Awaited<ReturnType<typeof verify>>;
  try { report = await verify({ signal: ac.signal, dir: a.dir, task: a.task, base: a.base, diffFile: a.diffFile, checker, secondChecker, testCommand: a.testCommand, timeoutSec: a.timeoutSec, standardCases: a.standardCases, freshInputs: a.freshInputs, lockTests: a.lockTests, onProgress: a.quiet ? undefined : (l) => err(l) }); } finally { process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal); }
  if (ac.signal.aborted) throw new Error("interrupted");
  if (a.signKey) report.signature = signReport(report, a.signKey);
  if (a.markdownOut) fs.writeFileSync(a.markdownOut, renderMarkdown(report) + "\n");
  if (a.sarifOut) fs.writeFileSync(a.sarifOut, renderSarif(report) + "\n");
  if (a.badgeOut) fs.writeFileSync(a.badgeOut, (a.badgeOut.toLowerCase().endsWith(".svg") ? renderBadgeSvg(report) : renderBadge(report)) + "\n");
  if (a.jsonOut) fs.writeFileSync(a.jsonOut, JSON.stringify(report, null, 2) + "\n");
  const text = renderFormat(report, a.format);
  if (a.out) fs.writeFileSync(a.out, text + "\n");
  if (!a.out || a.format === "text") out(a.format === "text" && !a.out && useColor() ? colorize(text) : text);
  return exitCode(report.verdict);
}
