/**
 * The proof gate: what "ready" means for every model.
 *
 * Before the model codes, Apex has it write a small acceptance test file from the request alone (the behaviour the
 * request states, its edge cases, and nearby behaviour that must not change). The file never goes into the project:
 * it runs on a copy. When the model says it is done, Apex runs the project's tests and these checks; a change is
 * "ready" only when both pass. A failing check goes back to the model (a bounded number of times) with leave to say
 * the check misreads the request; it never holds or reverts the change by itself, so a wrong check costs a label,
 * not the work (Apex's worst case stays the model working alone).
 *
 * Nothing here depends on which model runs: no calibration, no model names.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import fsSync from "node:fs";
import { randomUUID } from "node:crypto";
import type { ModelClient, ModelMessage } from "./model.js";
import type { EngineOptions } from "./options.js";
import type { TaskPackProvider, Workspace } from "./workspace.js";
import { listFiles } from "./workspace.js";
import { compileContext, copyProject, examplesBlock, failures, hasFencedBlock, runTests, streamText, testExamples, CHECKS_INPUTS, expectedLoadError, checkCode, repeatsALine } from "./surgical.js";
import { selfExcludingChecks, SELF_EXCLUSION_HINT } from "./check-screen.js";
import { checksLoadError } from "./check-results.js";
import { namedExports, requestOnly } from "./mechanical.js";
import { checkCommand, detectFramework, frameworkCheckCommand, cargoCrateName, cargoToTap, goPackageOf, goToTap, jestToTap, usesTypeScript, type Framework } from "./test-runner.js";

/** The model the proof gate asks: any `ModelClient` (only `stream` is used). */
export type ProofGateway = Pick<ModelClient, "stream">;

export interface Acceptance {
  /** Where the file sits in the copy the checks run in (never written to the project). */
  path: string;
  code: string;
  /** The command that runs only this file, from the project folder. */
  run: string[];
  py: boolean;
  /** Set when the project's own framework (Vitest or Jest) runs the checks instead of node:test or pytest. */
  framework?: Framework;
  /** The checks on the code as it was before the change. */
  original: { passed: number; failed: number; loadError: string | null };
  tokens: { input: number; output: number };
  calls: number;
}

export interface AcceptanceRun { passed: number; failed: number; loadError: string | null; failures: string; /** The runner's raw output (capped), for callers that parse it. */ output?: string }

const msg = (role: ModelMessage["role"], content: string): ModelMessage => ({ id: randomUUID(), role, content, createdAt: new Date().toISOString() });

/** Where the checks file goes: beside the project's tests. */
export function checkFilePath(files: string[], py: boolean, ts = false, rust = false, go: { dir: string } | null = null): string {
  if (go) return `${go.dir ? go.dir + "/" : ""}apex_task_check_test.go`;
  if (rust) return "tests/apex_task_check.rs";
  const testDir = files.map((f) => /^(.*\/)?tests?\//.exec(f)?.[0]).find(Boolean) ?? (py ? "tests/" : "test/");
  return py ? `${testDir}test_apex_task_check.py` : `${testDir}apex-task-check.test.${ts ? "ts" : "js"}`;
}

/** For an independent checker: also the behaviour standard practice makes certain, which a request leaves unsaid. */
export const STANDARD_CASES_HINT = "\n\nYou are the independent checker: the change was written by someone who handles the cases a request spells out and tends to miss what 'goes without saying'. Besides the stated rules, add at most 3 tests for behaviour that standard practice makes unambiguous for this kind of function even though the task does not mention it (for a text or file parser: Windows CRLF line endings, a last line without a trailing newline, empty input; for a number or date function: negative values, zero, invalid input; for a collection: empty, a single item, duplicates, the caller's input left unchanged; for a token or link: reuse after first use). Only where the correct result is certain; never guess a format or rule the task leaves open.";

/** For an independent checker: use inputs other than the task's own examples, so a change that special-cases the examples fails. */
export const FRESH_INPUTS_HINT = "\n\nWhere the task gives example inputs and outputs, do not use those same literal values as your test inputs. Test the same rule with different values (other numbers, other strings, another order, another size), so a change that only special-cases the task's examples fails your tests. You may keep at most one test that uses the task's own example.";

export function acceptancePrompt(task: string, checkPath: string, py: boolean, standardCases = false, freshInputs = false, framework: Framework | null = null, crate = "", goPkg = ""): string {
  const testDir = path.posix.dirname(checkPath) + "/";
  return `<task>\n${task}\n</task>\n\nDo not solve the task. Write one new test file, ${checkPath}, with ${py ? "pytest (plain assert; import the project's modules the way its code is laid out, adding the project folder to sys.path from the test file's location when needed)" : framework === "vitest" ? "vitest (import { test, expect } from \"vitest\"; import the project's modules the way its existing tests do, without a file extension for TypeScript)" : framework === "go" ? `Go's testing package (package ${goPkg || "main"}, the same package as the code under test so it needs no import; func TestXxx(t *testing.T) with t.Errorf("got %v, want %v", got, want); only the standard library)` : framework === "cargo" ? `Rust's built-in test framework (an integration test: #[test] functions, assert_eq!; import the crate with \`use ${crate || "the_crate"}::...;\` and only its public items; no external crates)` : framework === "jest" ? "jest (use the global test and expect; import the project's modules the way its existing tests do)" : "node:test and node:assert"}, that a correct change must pass. Import with paths relative to ${testDir}.\n` +
    "1. One test for each behaviour the task states (each rule, condition, value, order, format, error).\n" +
    "2. One test for each edge case those rules decide: empty or missing input, boundaries, invalid values, repeated or mixed cases, exact output format where the task states it.\n" +
    "3. One or two tests that pin nearby behaviour that works today and that the task does not change.\n" +
    "Test only what the task states; never a rule it does not state, and never the opposite of one it states. Prefer assertions that need no guessed exact value (an order between two items, a property every item has, a shape, a count, \"does not throw\"); use exact values only where the task or the code fixes them. Use the project's real function and file names." +
    CHECKS_INPUTS + SELF_EXCLUSION_HINT + (standardCases ? STANDARD_CASES_HINT : "") + (freshInputs ? FRESH_INPUTS_HINT : "");
}

async function ask(gw: ProofGateway, model: string, root: string, messages: ModelMessage[], signal: AbortSignal | undefined, t: { input: number; output: number }): Promise<string> {
  // Done at the closing fence (the stream is then read on only for its usage event); a model repeating lines is left at once.
  return streamText(gw.stream({ messages, tools: [], model, temperature: 0.2, maxTokens: 16000, signal, scope: root }), {
    done: hasFencedBlock, loop: (x) => repeatsALine(x, 8),
    onUsage: (u) => { t.input += u.inputTokens; t.output += u.outputTokens; },
  });
}

/** Runs the checks on a copy of `root` as it is now. The project folder itself is never touched. */
export async function runAcceptance(root: string, a: Pick<Acceptance, "path" | "code" | "run" | "py"> & { framework?: Framework }, signal?: AbortSignal, timeoutSec = 120): Promise<AcceptanceRun> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "apex-proof-"));
  try {
    const dir = path.join(scratch, "p");
    await copyProject(root, dir);
    await fs.mkdir(path.dirname(path.join(dir, a.path)), { recursive: true });
    await fs.writeFile(path.join(dir, a.path), a.framework ? a.code : selfExcludingChecks(a.code, a.py));
    const t = await runTests(dir, a.run, signal, timeoutSec);
    const loadError = checksLoadError(t.output) ?? (t.passed + t.failed === 0 ? (t.output.trim().split("\n").find((l) => /Error|error/.test(l)) ?? "no test ran").slice(0, 300) : null);
    const out = a.framework === "jest" ? jestToTap(t.output) : a.framework === "cargo" ? cargoToTap(t.output) : a.framework === "go" ? goToTap(t.output) : t.output;
    return { passed: t.passed, failed: t.failed, loadError, failures: t.failed || loadError ? failures(out, 3000) : "", output: out.slice(0, 60_000) };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Drafts the acceptance checks for a change request, from the request and the code as it is. Returns null when the
 * project has no node or pytest tests, or when the file still does not load after one repair (for a reason the
 * change would not clear: a missing export the request names is expected before the change).
 */
export async function draftAcceptance(o: { gateway: ProofGateway; model: string; root: string; task: string; testCommand: string[]; signal?: AbortSignal; budgetChars?: number; timeoutSec?: number; /** Also test unstated standard-practice behaviour (for an independent checker). */ standardCases?: boolean; /** Use inputs other than the task's own examples. */ freshInputs?: boolean;
  /** Files the AI may not see (ignore rules, secret files): left out of the prompt. */ hidden?: (rel: string) => boolean;
  workspace?: Workspace; taskPack?: TaskPackProvider; engine?: EngineOptions }): Promise<Acceptance | null> {
  const hidden = o.hidden ?? (() => false);
  const files = (await (o.workspace ? o.workspace.list() : listFiles(o.root))).filter((f) => !hidden(f));
  const py = /\bpytest\b|python/.test(o.testCommand.join(" "));
  const fw = py ? null : await detectFramework(o.root);
  const goPkg = fw === "go" ? goPackageOf(files, (rel) => fsSync.readFileSync(path.join(o.root, rel), "utf8")) : null;
  const checkPath = checkFilePath(files, py, fw && fw !== "cargo" && fw !== "go" ? await usesTypeScript(o.root) : false, fw === "cargo", goPkg);
  const crate = fw === "cargo" ? await cargoCrateName(o.root) : "";
  const cmd = fw ? { run: frameworkCheckCommand(fw, checkPath), py: false, native: false } : checkCommand(o.testCommand, checkPath);
  if (!cmd) return null;
  const tokens = { input: 0, output: 0 };
  let calls = 0;
  const context = await compileContext(o.root, o.task, o.budgetChars ?? 24_000, { hidden, workspace: o.workspace, taskPack: o.taskPack, engine: o.engine });
  const examples = await testExamples(o.root, files, o.task, cmd.py, 2, o.workspace);
  const system = msg("system", `You write tests; you never change the project's code. Answer with one \`\`\`${cmd.py ? "python" : fw === "cargo" ? "rust" : fw === "go" ? "go" : "js"} code block holding the whole new test file, and nothing else.`);
  const user = msg("user", `${context}\n\n${acceptancePrompt(o.task, checkPath, cmd.py, o.standardCases, o.freshInputs, fw, crate, goPkg?.pkg)}${examplesBlock(examples, cmd.py)}`);
  const own = requestOnly(o.task);
  const expected = expectedLoadError(namedExports(own), [...new Set(own.match(/[\w-]+(?:\/[\w.-]+)+\.(?:m?[jt]sx?|cjs|py)\b/g) ?? [])].filter((f) => !files.includes(f)));
  let code = "";
  let run: AcceptanceRun | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (o.signal?.aborted) return null;
    calls++;
    const prompt = attempt === 0 ? [system, user] : [system, user, msg("assistant", "```\n" + code + "\n```"), msg("user", `That file does not load on the project as it is now:\n${run?.loadError}\n\n${(run?.failures ?? "").slice(0, 1500)}\n\nWrite the whole file again so it loads (fix imports, paths and syntax); keep the same tests.`)];
    const text = await ask(o.gateway, o.model, o.root, prompt, o.signal, tokens).catch(() => "");
    const next = checkCode(text);
    const tests = (next.match(cmd.py ? /^\s*def test_/gm : fw === "cargo" ? /#\[test\]/g : fw === "go" ? /^func Test\w+\(/gm : /(?:^|[^\w.])(?:test|it|t)\s*\(\s*["'`]/gm) ?? []).length;
    if (!next || !tests || (!cmd.py && !(fw === "cargo" ? /#\[test\]/.test(next) : fw === "go" ? /^func Test\w+\(/m.test(next) : fw ? /\b(?:test|it)\(/.test(next) : /node:test/.test(next)))) { if (attempt === 0) { code = next; run = { passed: 0, failed: 0, loadError: "no tests in the answer", failures: "" }; continue; } return null; }
    code = next.endsWith("\n") ? next : next + "\n";
    run = await runAcceptance(o.root, { path: checkPath, code, run: cmd.run, py: cmd.py, ...(fw ? { framework: fw } : {}) }, o.signal, o.timeoutSec);
    if (!run.loadError || expected(run.loadError)) break;
  }
  if (!run || !code || (run.loadError && !expected(run.loadError))) return null;
  return { path: checkPath, code, run: cmd.run, py: cmd.py, ...(fw ? { framework: fw } : {}), original: { passed: run.passed, failed: run.failed, loadError: run.loadError }, tokens, calls };
}

/** What the model is told when the checks fail after it said it was done. */
export function acceptanceFeedback(r: AcceptanceRun, a: Pick<Acceptance, "path" | "code">): string {
  return [
    `Apex ran acceptance checks written from the request (before you started, on a copy; they are not in the project) against your change: ${r.loadError ? `the checks could not load: ${r.loadError}` : `${r.passed} passed, ${r.failed} failed`}.`,
    "",
    r.failures.slice(0, 3000),
    "",
    `The checks (${a.path}):`,
    "```",
    a.code.slice(0, 5000),
    "```",
    "",
    "For each failing check: if it tests what the request asks, fix the code (read it first, then edit_file) and run the project's tests. If a check contradicts the request or tests something the request does not ask, leave the code as it is and say which check and why. Do not create or copy this check file into the project. Then tell me what you changed.",
  ].join("\n");
}

/** The checks' verdict on a finished change, for the reply. */
export function acceptanceNote(r: AcceptanceRun | null, drafted: boolean): string {
  if (!drafted) return "Apex could not write acceptance checks for this request, so only the project's tests judged the change.";
  if (!r) return "";
  if (r.loadError) return `Apex's acceptance checks could not load on the change (${r.loadError}), so it is not marked ready.`;
  return r.failed ? `${r.failed} of ${r.passed + r.failed} acceptance checks written from your request still fail, so the change is not marked ready. Review it, or undo it from the checkpoint.` : `${r.passed} acceptance checks written from your request pass.`;
}

/**
 * Graph policy: the project's tests that cover what the change touched and what depends on it (graph imports, then
 * test-file naming), run on a copy. Null when there are none, or when the project's own tests do not run with
 * node:test or pytest (a jest or vitest file run by `node --test` fails to load, which says nothing about the change).
 * `takeOut`: files to put back to what they were before the change in the copy, for the count before the change.
 */
export async function runDependentTests(root: string, testCommand: string[], tests: string[], signal?: AbortSignal, timeoutSec = 120, takeOut?: Array<{ path: string; before: string | null }>): Promise<AcceptanceRun & { files: string[] } | null> {
  if (!tests.length) return null;
  const files = tests.slice(0, 12);
  const one = checkCommand(testCommand, files[0]);
  if (!one || !one.native) return null;
  const run = [...one.run.slice(0, -1), ...files];
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "apex-deps-"));
  try {
    const dir = path.join(scratch, "p");
    await copyProject(root, dir);
    for (const c of takeOut ?? []) {
      const f = path.resolve(dir, c.path);
      if (!f.startsWith(dir + path.sep)) continue;
      if (c.before === null) await fs.rm(f, { force: true });
      else { await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, c.before); }
    }
    const t = await runTests(dir, run, signal, timeoutSec);
    const loadError = t.passed + t.failed === 0 ? (t.output.trim().split("\n").find((l) => /Error|error/.test(l)) ?? "no test ran").slice(0, 300) : null;
    return { files, passed: t.passed, failed: t.failed, loadError, failures: t.failed ? failures(t.output, 3000) : "" };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** What the model is told when tests covering the change's dependents fail. */
export function dependentsFeedback(r: AcceptanceRun & { files: string[] }, dependents: string): string {
  return `Apex ran the tests that cover the code your change touches and the code that depends on it (${r.files.join(", ")}): ${r.passed} passed, ${r.failed} failed.\n\n${r.failures.slice(0, 3000)}\n\n${dependents ? `${dependents}\n\n` : ""}Fix what your change broke in its dependents (read the failing code first), run the tests, then tell me what you changed.`;
}
