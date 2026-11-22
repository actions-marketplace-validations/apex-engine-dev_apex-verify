import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { testSandboxAvailable, checksOnlyRunner, copyProject, parseTestOutcomes, runCommand, detectTestRunner, draftAcceptance, judgeFailingChecks, readTestOutput, runAcceptance, runTests, type ModelClient, type TestRunner } from "apex-verify-engine";
import { detectCheats, type Cheat, type FileChange } from "./cheats.js";

/**
 * apex verify: given a change somebody (usually an AI agent) already made, decide whether it is really done.
 *
 * ready      the tests still pass, nothing was weakened, and checks written from the task by an independent model fail on
 *            the old code and pass on the new.
 * not_ready  a proven problem: a test that used to pass now fails, a test was deleted or skipped, or a check written from
 *            the task fails on the new code.
 * unknown    not enough to say: no checks could be written, the checks cannot tell the old code from the new, or the
 *            failing checks look wrong. Never a silent pass.
 */
export type Verdict = "ready" | "not_ready" | "unknown";

/** The project's own type check, when it has one: the `typecheck` script, or `tsc --noEmit` with a tsconfig. A dangling import or a type error can leave every test green and still break the build. */
async function typecheckCommand(dir: string): Promise<{ file: string; args: string[]; label: string } | null> {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
    if (typeof pkg?.scripts?.typecheck === "string") return { file: "npm", args: ["run", "--silent", "typecheck"], label: "npm run typecheck" };
  } catch { /* no package.json */ }
  const tsc = path.join(dir, "node_modules", ".bin", "tsc");
  try { await fs.access(path.join(dir, "tsconfig.json")); await fs.access(tsc); return { file: tsc, args: ["--noEmit", "-p", "."], label: "tsc --noEmit" }; } catch { return null; }
}
/** Whether a path is one of the project's own test files (tests/ or test/ folders, *.test.* / *.spec.*, test_*.py, *_test.go / .py, __tests__). */
export function isTestPath(p: string): boolean {
  return /(^|\/)(tests?|__tests__|spec)\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)test_[^/]*\.py$/.test(p) || /_test\.(py|go)$/.test(p);
}
export interface Reason { kind: "regression" | "cheat" | "check_failed" | "checks_suspect" | "checkers_disagree" | "no_checks" | "checks_unproven" | "no_change" | "no_tests"; summary: string; evidence?: string; hint?: string }

export interface VerifyReport {
  schema: 1;
  verdict: Verdict;
  reasons: Reason[];
  warnings: string[];
  task: string;
  change: { mode: "git" | "patch"; base: string; files: Array<{ path: string; status: "added" | "modified" | "deleted" }> };
  tests: { command: string | null; before: { passed: number; failed: number } | null; after: { passed: number; failed: number } | null; newlyFailing: string[] };
  /** The second checker's own result, when two checkers were used. */
  secondChecks?: { writtenBy: string | null; written: boolean; passed: number; failed: number; failedOnOldCode: boolean; failures: string; failedChecks: Array<{ name: string; expected?: string; actual?: string; message?: string }> };
  checks: { writtenBy: string | null; written: boolean; passed: number; failed: number; failedOnOldCode: boolean; failures: string; failedChecks: Array<{ name: string; expected?: string; actual?: string; message?: string }> };
  cheats: Cheat[];
  /** What isolated the tests and generated checks on this machine. */
  sandbox: string;
  usage: { modelCalls: number; seconds: number };
  proof: string;
  /** With --lock-tests: the project's own test files that the change edited or deleted, restored from the base before the tests ran. */
  lockedTests?: string[];
  /** With --sign-key: an Ed25519 signature over verdict, task and proof (see sign.ts). */
  signature?: { alg: "ed25519"; publicKey: string; value: string };
}

export interface VerifyOptions {
  /** Run the project's tests with the base versions of the test files the change edited or deleted (an agent cannot edit its way to green). New test files are kept. */
  lockTests?: boolean;
  dir: string;
  task: string;
  /** Compare the working copy with this git ref (default HEAD). */
  base?: string;
  /** Or: a unified diff to apply on a copy of `dir`. */
  diffFile?: string;
  /** The independent model that writes the checks. Without it only the deterministic parts run. */
  checker?: { client: ModelClient; model: string } | null;
  /** A second, independent checker. A change is NOT READY only when both checkers object; if only one does the verdict is UNKNOWN (they disagree). */
  secondChecker?: { client: ModelClient; model: string } | null;
  /** Ask the checker to use inputs other than the task's own examples (default false). */
  freshInputs?: boolean;
  testCommand?: string[];
  timeoutSec?: number;
  /** How many times to try writing the checks when a try gives none. Default 2. */
  attempts?: number;
  /** Reuse checks written earlier for the same task and starting code (default true). */
  cache?: boolean;
  /** Ask the checker for unstated standard-practice cases too (CRLF, empty input, ...). Default false: measured, no gain (docs/EXPERIMENTS.md). */
  standardCases?: boolean;
  /** One short call decides whether failing checks or the change is at fault (default true). */
  secondLook?: boolean;
  onProgress?: (line: string) => void;
  signal?: AbortSignal;
}

const SKIP = new Set([".git", ".apex", "node_modules", ".venv", "venv", ".next", ".turbo", ".cache", "coverage", "target", ".parcel-cache", "__pycache__", "dist", "build"]);
const MAX_FILE = 1_000_000;

async function readTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    let ents: import("node:fs").Dirent[] = [];
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (SKIP.has(e.name)) continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) await walk(f);
      else if (e.isFile()) {
        try { const st = await fs.stat(f); if (st.size <= MAX_FILE) { const buf = await fs.readFile(f); if (!buf.includes(0)) out.set(path.relative(root, f).split(path.sep).join("/"), buf.toString("utf8")); } } catch { /* unreadable */ }
      }
    }
  }
  await walk(root);
  return out;
}

export interface Collected { orig: string; next: string; mode: "git" | "patch"; base: string; changes: FileChange[]; cleanup: () => Promise<void> }

const git = (dir: string, args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });

/** Two trees (before, after) in scratch folders; the project itself is never touched. */
export async function collectChange(o: { dir: string; base?: string; diffFile?: string }): Promise<Collected> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "apex-"));
  const orig = path.join(scratch, "before"), next = path.join(scratch, "after");
  const cleanup = () => fs.rm(scratch, { recursive: true, force: true });
  try {
    let mode: "git" | "patch" = "patch", base = "diff";
    if (o.diffFile) {
      await copyProject(o.dir, orig);
      await copyProject(o.dir, next);
      const diff = path.resolve(o.diffFile);
      let applied = false;
      for (const p of ["-p1", "-p0"]) {
        try { execFileSync("patch", [p, "--quiet", "-i", diff], { cwd: next, stdio: "pipe" }); applied = true; break; } catch { /* try git apply (no `patch` on Windows), then the other strip level */ }
        try { execFileSync("git", ["apply", p, "--unsafe-paths", "--whitespace=nowarn", diff], { cwd: next, stdio: "pipe" }); applied = true; break; } catch { /* try the other strip level */ }
      }
      if (!applied) throw new Error(`could not apply ${o.diffFile} to ${o.dir} (tried -p1 and -p0)`);
    } else {
      let inside = false;
      try { inside = git(o.dir, ["rev-parse", "--is-inside-work-tree"]).trim() === "true"; } catch { /* not a repo */ }
      if (!inside) throw new Error(`${o.dir} is not a git repository: run inside one, or pass --diff <file>`);
      base = o.base ?? "HEAD";
      try { git(o.dir, ["rev-parse", "--verify", `${base}^{commit}`]); } catch { throw new Error(`git ref not found: ${base}${o.base ? "" : " (a repository with no commits has nothing to compare with; pass --diff <file>)"}`); }
      const prefix = git(o.dir, ["rev-parse", "--show-prefix"]).trim();
      await fs.mkdir(orig, { recursive: true });
      const tar = execFileSync("git", ["-C", o.dir, "archive", "--format=tar", prefix ? `${base}:${prefix.replace(/\/$/, "")}` : base], { maxBuffer: 1024 * 1024 * 1024 });
      execFileSync("tar", ["-x", "-C", orig], { input: tar });
      await copyProject(o.dir, next);
      mode = "git";
    }
    const [a, b] = await Promise.all([readTree(orig), readTree(next)]);
    const changes: FileChange[] = [];
    for (const p of new Set([...a.keys(), ...b.keys()])) {
      const x = a.get(p) ?? null, y = b.get(p) ?? null;
      // A file that differs only in line endings is not a change (Windows checkouts with autocrlf are CRLF, git archive is LF).
      if (x !== y && (x === null || y === null || x.replace(/\r\n/g, "\n") !== y.replace(/\r\n/g, "\n"))) changes.push({ path: p, before: x, after: y });
    }
    changes.sort((m, n) => m.path.localeCompare(n.path));
    return { orig, next, mode, base, changes, cleanup };
  } catch (e) { await cleanup(); throw e; }
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

type Draft = NonNullable<Awaited<ReturnType<typeof draftAcceptance>>>;
const cacheDir = () => path.join(process.env.APEX_CACHE_DIR || path.join(os.homedir(), ".cache", "apex-verify"), "checks");
/** The same task on the same starting code with the same model gets the same checks: stable while an agent retries, and one model call, not one per attempt. */
async function readDraft(key: string): Promise<Draft | null> {
  try { return JSON.parse(await fs.readFile(path.join(cacheDir(), key + ".json"), "utf8")) as Draft; } catch { return null; }
}
async function writeDraft(key: string, d: Draft): Promise<void> {
  try { await fs.mkdir(cacheDir(), { recursive: true }); await fs.writeFile(path.join(cacheDir(), key + ".json"), JSON.stringify(d)); } catch { /* best effort */ }
}
const trim = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

export async function verify(o: VerifyOptions): Promise<VerifyReport> {
  const t0 = Date.now();
  const say = (l: string) => o.onProgress?.(l);
  const timeout = o.timeoutSec ?? 90;
  const c = await collectChange({ dir: o.dir, base: o.base, diffFile: o.diffFile });
  try {
    const reasons: Reason[] = [], warnings: string[] = [];
    const files = c.changes.map((x) => ({ path: x.path, status: (x.before === null ? "added" : x.after === null ? "deleted" : "modified") as "added" | "modified" | "deleted" }));
    const report: VerifyReport = {
      schema: 1, verdict: "unknown", reasons, warnings, task: o.task,
      change: { mode: c.mode, base: c.base, files },
      tests: { command: null, before: null, after: null, newlyFailing: [] },
      checks: { writtenBy: o.checker?.model ?? null, written: false, passed: 0, failed: 0, failedOnOldCode: false, failures: "", failedChecks: [] },
      cheats: [], sandbox: (await testSandboxAvailable().catch(() => false)) ? (process.platform === "darwin" ? "macOS Seatbelt (best effort)" : process.platform === "linux" ? "Linux bubblewrap" : "sandbox") : "none (run in CI or a container for code you do not trust)", usage: { modelCalls: 0, seconds: 0 }, proof: "",
    };
    const finish = (verdict: Verdict, checksCode = ""): VerifyReport => {
      report.verdict = verdict;
      report.usage.seconds = Math.round((Date.now() - t0) / 100) / 10;
      report.proof = "sha256:" + sha(JSON.stringify({ task: o.task, files: c.changes.map((x) => [x.path, x.before && sha(x.before), x.after && sha(x.after)]), checksCode, tests: report.tests, checks: report.checks, verdict }));
      return report;
    };

    if (!c.changes.length) {
      reasons.push({ kind: "no_change", summary: c.mode === "git" ? `nothing changed compared with ${c.base}` : "the diff changes nothing", hint: "Make the change first, then verify it." });
      return finish("unknown");
    }
    say(`change: ${files.length} file${files.length === 1 ? "" : "s"} (${files.map((f) => f.path).slice(0, 4).join(", ")}${files.length > 4 ? ", ..." : ""})`);

    // 0. locked tests: put the base's version of every edited or deleted test file back before anything runs
    const locked = new Set<string>();
    if (o.lockTests) {
      for (const x of c.changes) {
        if (x.before === null || !isTestPath(x.path)) continue;
        await fs.mkdir(path.dirname(path.join(c.next, x.path)), { recursive: true });
        await fs.writeFile(path.join(c.next, x.path), x.before);
        locked.add(x.path);
      }
      if (locked.size) { report.lockedTests = [...locked].sort(); say(`locked tests: restored ${locked.size} file${locked.size === 1 ? "" : "s"} from ${c.base}`); }
    }

    // 1. cheating: deterministic
    report.cheats = detectCheats(c.changes, o.task);
    for (const ch of report.cheats) {
      if (locked.has(ch.file)) warnings.push(`${ch.file}: ${ch.detail} (restored from ${c.base} by --lock-tests, so it does not count)`);
      else if (ch.severity === "high") reasons.push({ kind: "cheat", summary: `${ch.file}: ${ch.detail}`, hint: "Do not delete, skip or weaken tests to make a change pass. Restore them and fix the code instead." });
      else warnings.push(`${ch.file}: ${ch.detail}`);
    }

    // 2. the project's own tests, before and after
    const runner: TestRunner | null = await detectTestRunner(c.next, o.testCommand?.join(" ")).catch(() => null);
    if (runner) {
      report.tests.command = runner.command.join(" ");
      say(`tests: ${report.tests.command}`);
      const after = await runTests(c.next, runner.command, o.signal, Math.max(timeout, runner.timeoutSec ?? 0));
      const aOut = readTestOutput(after.output, after.exitCode !== 0);
      report.tests.after = { passed: after.passed, failed: after.failed };
      if (after.failed > 0 || (after.exitCode !== 0 && after.passed === 0)) {
        const before = await runTests(c.orig, runner.command, o.signal, Math.max(timeout, runner.timeoutSec ?? 0));
        const bOut = readTestOutput(before.output, before.exitCode !== 0);
        report.tests.before = { passed: before.passed, failed: before.failed };
        const was = new Set(bOut.failedNames);
        const fresh = aOut.failedNames.filter((n) => !was.has(n));
        report.tests.newlyFailing = fresh;
        const couldNotRun = after.passed + after.failed === 0 && before.passed > 0;
        if (fresh.length || after.failed > before.failed || couldNotRun) {
          reasons.push({
            kind: "regression",
            summary: couldNotRun ? "the project's tests no longer run" : `${fresh.length || after.failed - before.failed} test${(fresh.length || after.failed - before.failed) === 1 ? "" : "s"} that passed before now fail${fresh.length ? `: ${fresh.slice(0, 3).join(", ")}` : ""}`,
            evidence: trim(after.output.split("\n").filter((l) => /not ok|fail|error|assert/i.test(l)).slice(0, 12).join("\n"), 1500),
            hint: "The change broke behaviour that worked before. Fix the change; do not edit the tests.",
          });
        } else warnings.push(`${after.failed} test${after.failed === 1 ? "" : "s"} failed before the change too (not counted against it)`);
      }
    } else warnings.push("no test runner found: only the checks written from the task can prove anything (pass --test \"<command>\" to use your own)");

    // 2b. the project's type check, if it has one: only errors the change introduced count
    const tc = await typecheckCommand(c.next);
    if (tc) {
      const after = await runCommand(tc.file, tc.args, { cwd: c.next, timeoutMs: timeout * 1000, signal: o.signal }).catch(() => null);
      if (after && after.exitCode !== 0 && !after.timedOut) {
        const before = await runCommand(tc.file, tc.args, { cwd: c.orig, timeoutMs: timeout * 1000, signal: o.signal }).catch(() => null);
        const lines = (r: { stdout: string; stderr: string }) => (r.stdout + r.stderr).split("\n").filter((l) => /error/i.test(l));
        const was = new Set(before ? lines(before).map((l) => l.replace(/\(\d+,\d+\)|:\d+:\d+/g, "")) : []);
        const fresh = lines(after).filter((l) => !was.has(l.replace(/\(\d+,\d+\)|:\d+:\d+/g, "")));
        if (fresh.length) reasons.push({ kind: "regression", summary: `${tc.label} reports ${fresh.length} new error${fresh.length === 1 ? "" : "s"} the change introduced`, evidence: trim(fresh.slice(0, 8).join("\n"), 1500), hint: "Fix the type or import errors; they would break the build even though the tests pass." });
      }
    }

    // 3. independent checks written from the task, proven on the old code, run on the new (once per checker)
    type Checker = { client: ModelClient; model: string };
    type ChecksRec = VerifyReport["checks"];
    const checkWith = async (ck: Checker, T: ChecksRec, push: (r: Reason) => void): Promise<string> => {
      let code = "";
      const cr: TestRunner | null = runner ?? (await checksOnlyRunner(c.next).catch(() => null));
      if (!cr) warnings.push("the project has no language Apex verify can write checks for (node:test and pytest are supported)");
      else {
        say(`checks: ${ck.model} writes them from the task (never from the agent's own tests)`);
        let draft: Awaited<ReturnType<typeof draftAcceptance>> = null;
        const key = sha(JSON.stringify([o.task, ck.model, o.standardCases === true, o.freshInputs === true, [...(await readTree(c.orig)).entries()].map(([p, t]) => [p, sha(t)])]));
        if (o.cache !== false) { draft = await readDraft(key); if (draft) say("checks: reused from an earlier run on the same task and code"); }
        for (let i = 0; i < (o.attempts ?? 2) && !draft; i++) {
          draft = await draftAcceptance({ gateway: ck.client, model: ck.model, root: c.orig, task: o.task, testCommand: cr.command, timeoutSec: timeout, signal: o.signal, standardCases: o.standardCases === true, freshInputs: o.freshInputs === true }).catch(() => null);
          report.usage.modelCalls += draft?.calls ?? 1;
          if (draft && o.cache !== false) await writeDraft(key, draft);
        }
        if (!draft) warnings.push("no usable checks could be written for this task");
        else {
          T.written = true;
          code = draft.code;
          T.failedOnOldCode = draft.original.failed > 0 || !!draft.original.loadError;
          const run = await runAcceptance(c.next, { path: draft.path, code: draft.code, run: draft.run, py: draft.py, ...(draft.framework ? { framework: draft.framework } : {}) }, o.signal, timeout);
          T.passed = run.passed;
          T.failed = run.failed + (run.loadError && run.passed + run.failed === 0 ? 1 : 0);
          T.failedChecks = parseTestOutcomes(run.output ?? "").filter((x) => !x.ok && !x.skipped && x.top !== false).slice(0, 8).map((x) => ({ name: x.name.replace(/^\[c\d+\]\s*/, "").replace(/^task:\s*/i, ""), ...(x.failure?.expected ? { expected: trim(String(x.failure.expected), 160) } : {}), ...(x.failure?.actual !== undefined ? { actual: trim(String(x.failure.actual), 160) } : {}), ...(x.failure?.message && !x.failure.expected ? { message: trim(x.failure.message.split("\n").find((l) => l.trim()) ?? "", 200) } : {}) }));
          T.failures = T.failedChecks.length
            ? T.failedChecks.map((x) => `check: ${x.name}${x.expected !== undefined ? `\n  expected: ${x.expected}\n  actual:   ${x.actual ?? "?"}` : `${x.message ? `\n  ${x.message}` : ""}${x.actual !== undefined ? `\n  actual:   ${x.actual}` : ""}`}`).join("\n")
            : trim(run.failures || (run.loadError ?? ""), 2000);
          say(`checks: ${run.passed} passed, ${T.failed} failed (${T.failedOnOldCode ? "they fail on the old code, so they can tell the difference" : "they also pass on the old code"})`);
          if (T.failed > 0) {
            let blame: "test" | "code" | "unknown" = "unknown", why = "";
            if (o.secondLook !== false) {
              const j = await judgeFailingChecks({ gateway: ck.client, model: ck.model, task: o.task, changes: c.changes.map((x) => ({ path: x.path, before: x.before, after: x.after ?? "" })), checksFile: draft.code, failureOutput: T.failures, passed: run.passed, failed: T.failed, signal: o.signal }).catch(() => null);
              if (j) { blame = j.verdict; why = j.reason; report.usage.modelCalls++; }
            }
            if (blame === "test") push({ kind: "checks_suspect", summary: "a check written from the task fails, but on a second look the check itself looks wrong", evidence: trim(`${why}\n${T.failures}`, 1800), hint: "Review the failing check: it may over-reach. If the change is right, this is a false alarm." });
            else push({ kind: "check_failed", summary: `${T.failed} check${T.failed === 1 ? "" : "s"} written from the task ${T.failed === 1 ? "fails" : "fail"} on the new code`, evidence: trim(T.failures, 1800), hint: "Make the change satisfy the behaviour in the task; the failing check output shows what is expected." });
          } else if (!T.failedOnOldCode) {
            push({ kind: "checks_unproven", summary: "the checks pass, but they also pass on the old code, so they cannot show the change did anything", hint: "Describe the behaviour that should differ, or review the change by hand." });
          }
        }
      }
      return code;
    };
    const blank = (m: string | null): ChecksRec => ({ writtenBy: m, written: false, passed: 0, failed: 0, failedOnOldCode: false, failures: "", failedChecks: [] });
    const firstReasons: Reason[] = [], secondReasons: Reason[] = [];
    let checksCode = "";
    if (o.checker) checksCode = await checkWith(o.checker, report.checks, (r) => firstReasons.push(r));
    if (o.checker && o.secondChecker) {
      report.secondChecks = blank(o.secondChecker.model);
      await checkWith(o.secondChecker, report.secondChecks, (r) => secondReasons.push(r));
    }
    const objects = (rs: Reason[]) => rs.some((r) => r.kind === "check_failed");
    const second = report.secondChecks;
    if (second && report.checks.written && second.written) {
      const a1 = objects(firstReasons), a2 = objects(secondReasons);
      if (a1 && a2) {
        const f = firstReasons.find((r) => r.kind === "check_failed")!, g = secondReasons.find((r) => r.kind === "check_failed")!;
        reasons.push({ kind: "check_failed", summary: `both checkers found a problem: ${f.summary} (${report.checks.writtenBy}); ${g.summary} (${second.writtenBy})`, evidence: trim(`${report.checks.writtenBy}:\n${f.evidence ?? ""}\n\n${second.writtenBy}:\n${g.evidence ?? ""}`, 1900), hint: f.hint });
      } else if (a1 !== a2) {
        const objector = a1 ? report.checks.writtenBy : second.writtenBy, other = a1 ? second.writtenBy : report.checks.writtenBy;
        const r = (a1 ? firstReasons : secondReasons).find((x) => x.kind === "check_failed")!;
        reasons.push({ kind: "checkers_disagree", summary: `the two checkers disagree: ${objector} found a problem, ${other} found none`, evidence: r.evidence, hint: "Review the objection by hand: with two checkers a single objection is not enough to block the change, and not enough to call it ready." });
      } else reasons.push(...firstReasons.filter((r) => r.kind !== "check_failed"), ...secondReasons.filter((r) => r.kind === "checks_unproven" && !firstReasons.some((x) => x.kind === "checks_unproven")));
    } else {
      if (second && !second.written) warnings.push(`the second checker (${second.writtenBy}) could not write usable checks, so only ${report.checks.writtenBy} judged the change`);
      else if (second && !report.checks.written) { Object.assign(report.checks, second); report.secondChecks = undefined; warnings.push("only the second checker could write usable checks"); }
      reasons.push(...(report.checks.written || !second ? firstReasons : secondReasons));
    }

    // 4. the verdict
    const blocking = reasons.some((r) => r.kind === "cheat" || r.kind === "regression" || r.kind === "check_failed");
    if (blocking) return finish("not_ready", checksCode);
    if (report.checks.written && !reasons.length) return finish("ready", checksCode);
    if (!report.checks.written && !o.checker) reasons.push({ kind: "no_checks", summary: "no independent checks were written (no checker model given): only the project's tests and the cheating scan ran", hint: "Pass --model to have an independent model write checks from the task." });
    else if (!report.checks.written) reasons.push({ kind: "no_checks", summary: "no usable checks could be written, so the change is not independently checked" });
    if (runner && !report.tests.after) reasons.push({ kind: "no_tests", summary: "the tests did not run" });
    return finish("unknown", checksCode);
  } finally { await c.cleanup(); }
}
