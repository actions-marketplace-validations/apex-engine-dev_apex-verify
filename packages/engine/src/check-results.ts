/**
 * Per-check results: each check line the user approved (or Apex wrote from the request) mapped to the test(s)
 * written for it. Tests carry the check's number in their name ("[c3] ..." for node:test, "test_c3_..." for
 * pytest), so the result maps 1:1 to the line the user saw, in the same order and wording.
 */

export interface CheckFailure {
  expected?: string;
  actual?: string;
  message: string;
}

export interface CheckResult {
  text: string;
  /** The line was marked "(assumed)": Apex assumed it, the user confirmed it. */
  assumed: boolean;
  /** null: the check could not be run (Apex's generated test file did not load), so it is neither passed nor failed. */
  passed: boolean | null;
  failure?: CheckFailure;
}

interface TestOutcome {
  name: string;
  ok: boolean;
  /** Top-level test (not a subtest inside a describe). */
  top: boolean;
  /** Reported with "# SKIP": it did not run, so it neither passed nor failed. */
  skipped?: boolean;
  failure?: CheckFailure;
}

/** "Returns 404 for a missing id (assumed)" -> text without the mark, and assumed: true. */
export function splitAssumed(line: string): { text: string; assumed: boolean } {
  const assumed = /\(assumed\)/i.test(line);
  return { text: line.replace(/\s*\(assumed\)\s*/gi, " ").replace(/\s+/g, " ").trim(), assumed };
}

/** The check number a test name carries: "[c3] ...", "c3: ...", "test_c3_..." -> 3. */
export function checkIndexOf(name: string): number | null {
  const m = /\[c(\d+)\]/i.exec(name) ?? /(?:^|::|\b)test_c(\d+)(?:_|\b)/i.exec(name) ?? /^c(\d+)[:\s-]/i.exec(name);
  return m ? Number(m[1]) : null;
}

/** Test outcomes from node:test TAP output (with the failure's expected/actual/error) or pytest -rA output. */
export function parseTestOutcomes(output: string): TestOutcome[] {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  const out: TestOutcome[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const tap = /^(\s*)(not ok|ok) \d+ - (.+?)(?:\s+#\s*(SKIP|TODO).*)?$/i.exec(line);
    if (tap) {
      const ok = tap[2] === "ok";
      const outcome: TestOutcome = { name: tap[3].trim(), ok, top: tap[1].length === 0, ...(/^(skip|todo)$/i.test(tap[4] ?? "") ? { skipped: true } : {}) };
      if (!ok) {
        outcome.failure = tapFailure(lines, i + 1, tap[1].length);
        // node:test prints subtests before their parent; a parent's "1 subtest failed" says nothing, the child does.
        if (generic(outcome.failure)) {
          let child: TestOutcome | undefined;
          for (let k = out.length - 1; k >= 0 && !out[k].top; k--) if (!out[k].ok && !generic(out[k].failure)) { child = out[k]; break; }
          if (child) outcome.failure = child.failure;
        }
      }
      out.push(outcome);
      continue;
    }
    const py = /^(PASSED|FAILED|ERROR)\s+(.+?)(?:\s+-\s+(.*))?$/.exec(line.trim());
    if (py) {
      const ok = py[1] === "PASSED";
      const message = (py[3] ?? "").trim();
      const cmp = /assert\s+(.+?)\s*==\s*(.+)$/.exec(message);
      out.push({ name: py[2], ok, top: true, ...(ok ? {} : { failure: { message: message || py[1].toLowerCase(), ...(cmp ? { actual: cmp[1], expected: cmp[2] } : {}) } }) });
    }
  }
  return out;
}

/** The YAML block node:test prints under a failing test: error, expected, actual. */
function tapFailure(lines: string[], start: number, indent: number): CheckFailure {
  // The YAML block is indented two past the test line; some runners (and nested subtests) indent it further.
  const open = (lines[start] ?? "").match(/^(\s*)---[ \t]*$/);
  if (!open || open[1].length < indent) return { message: "failed" };
  const pad = open[1];
  const fields: Record<string, string> = {};
  let key = "";
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trimEnd() === `${pad}...`) break;
    const kv = l.startsWith(pad) && !l.startsWith(pad + " ") ? /^([\w]+):\s?(.*)$/.exec(l.slice(pad.length)) : null;
    if (kv) {
      key = kv[1];
      fields[key] = /^[|>][-+]?$/.test(kv[2]) ? "" : kv[2].replace(/^'(.*)'$/, "$1");
    } else if (key && l.startsWith(pad + " ")) {
      fields[key] = (fields[key] ? fields[key] + "\n" : "") + l.slice(pad.length + 2);
    }
  }
  const clean = (s: string | undefined) => (s === undefined ? undefined : s.trim().slice(0, 600));
  const fromStack = clean(fields.stack)?.split("\n").find((l) => l.trim() && !/^[ \t]*at\s/.test(l));
  const message = clean(fields.error)?.split("\n").filter((l) => l.trim()).slice(0, 4).join("\n") || fromStack || (fields.code ? `${clean(fields.failureType) ?? "failed"} (${clean(fields.code)})` : "") || clean(fields.failureType) || "failed";
  return { message, ...(fields.expected !== undefined ? { expected: clean(fields.expected) } : {}), ...(fields.actual !== undefined ? { actual: clean(fields.actual) } : {}) };
}

/** A check whose tests were all skipped: nothing ran, so it is unchecked, never passed. */
export const SKIPPED_MESSAGE = "The test for this check was skipped, so it was not checked.";
/** A check with no test of its own: not run, so neither passed nor failed (it never holds a change by itself). */
export const NO_TEST_MESSAGE = "No test was written for this check, so it was not checked.";
/** A failing check that has not proven itself: it neither fails on the original code for a reason the request
 * explains, nor passes on any version. It may be wrong itself, so it never holds a change. */
export const UNPROVEN_MESSAGE = "This check failed, but it has not proven itself (it did not fail on the original code for a reason the request explains, and no version passed it), so it may be wrong itself.";

/**
 * Each check with pass, fail or unchecked (null). A check passes when every test written for it passes; a check
 * with no test of its own is unchecked ("No test was written for this check"), never failed: one malformed test
 * used to fail every other check (measured: a correct one-line isDone held at "0 of 6"). With `proof`, a failing
 * check counts as failed only when it is proven (see provenKeys); otherwise it is unchecked with the reason.
 * Without numbered names at all, top-level tests map to checks in order.
 */
export function checkResults(checks: string[], output: string, proof?: CheckProof): CheckResult[] {
  // The file did not load: node:test prints one failing "test" named after the file. That is not check 1 failing,
  // and the checks did not run, so none passed or failed.
  const broken = checksLoadError(output);
  if (broken !== null) return checks.map((line) => ({ ...splitAssumed(line), passed: null, failure: { message: `The checks file did not load on this version: ${broken}` } }));
  const tests = parseTestOutcomes(output);
  const numbered = tests.filter((t) => checkIndexOf(t.name) !== null);
  const byIndex = new Map<number, TestOutcome[]>();
  if (numbered.length) {
    for (const t of numbered) {
      const n = checkIndexOf(t.name)!;
      byIndex.set(n, [...(byIndex.get(n) ?? []), t]);
    }
  } else {
    // A test file that exits early shows up as one "test" named after the file: that is not a check passing.
    const top = tests.filter((t) => t.top && !/^\[implicit\]/i.test(t.name) && !/\.(?:[cm]?[jt]sx?|py)$/.test(t.name));
    top.slice(0, checks.length).forEach((t, i) => byIndex.set(i + 1, [t]));
  }
  const results: CheckResult[] = checks.map((line, i) => {
    const { text, assumed } = splitAssumed(line);
    const mine = byIndex.get(i + 1) ?? [];
    if (!mine.length) return { text, assumed, passed: null, failure: { message: NO_TEST_MESSAGE } };
    if (mine.every((t) => t.skipped)) return { text, assumed, passed: null, failure: { message: SKIPPED_MESSAGE } };
    const bad = mine.find((t) => !t.ok && !generic(t.failure)) ?? mine.find((t) => !t.ok);
    if (bad && proof && !failureCounts(numbered.length ? `c${i + 1}` : testKey(mine[0].name), bad.failure, proof)) {
      return { text, assumed, passed: null, failure: { message: `${UNPROVEN_MESSAGE} It said: ${(bad.failure?.message ?? "failed").split("\n")[0].slice(0, 200)}` } };
    }
    return bad ? { text, assumed, passed: false, failure: bad.failure ?? { message: "failed" } } : { text, assumed, passed: true };
  });
  // Checks Apex adds to every change ("[implicit] No unrelated or security-weakening changes"), after the user's.
  for (const t of tests.filter((x) => /^\[implicit\]\s*/i.test(x.name))) {
    results.push({ text: t.name.replace(/^\[implicit\]\s*/i, ""), assumed: false, passed: t.skipped ? null : t.ok, ...(t.ok ? {} : { failure: t.failure ?? { message: "failed" } }) });
  }
  return results;
}

/** The key a test is judged by: its check number ("c3") when it carries one, else its name. */
export function testKey(name: string): string {
  const n = checkIndexOf(name);
  return n !== null ? `c${n}` : name.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Per key (check number or test name): ok when every top-level-or-numbered test under it passed. */
export function keyedOutcomes(output: string): Map<string, { ok: boolean; failure?: CheckFailure }> {
  const tests = parseTestOutcomes(output).filter((t) => !t.skipped && !/^\[implicit\]/i.test(t.name));
  const numbered = tests.filter((t) => checkIndexOf(t.name) !== null);
  const use = numbered.length ? numbered : tests.filter((t) => t.top);
  const out = new Map<string, { ok: boolean; failure?: CheckFailure }>();
  for (const t of use) {
    const k = testKey(t.name);
    const prev = out.get(k);
    if (!prev) out.set(k, { ok: t.ok, ...(t.failure ? { failure: t.failure } : {}) });
    else if (prev.ok && !t.ok) out.set(k, { ok: false, ...(t.failure ? { failure: t.failure } : {}) });
  }
  return out;
}

/** A failure that says the code under test is wrong: an assertion failed (expected/actual, AssertionError). */
export function assertionFailure(f: CheckFailure | undefined): boolean {
  if (!f) return false;
  if (f.expected !== undefined || f.actual !== undefined) return true;
  return /AssertionError|ERR_ASSERTION|Expected values to be|to be (?:strictly|loosely|deep)|\bassert\b.*==|^assert\s/i.test(f.message);
}

/** A failure because a name the request asks for is not there yet (not exported, not a function, not found). */
export function missingNameFailure(f: CheckFailure | undefined, names: string[]): boolean {
  if (!f || !names.length) return false;
  return names.some((n) => {
    const e = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${e}\\b[^\\n]*\\b(is not a function|is not defined|not exported|is not a constructor)|export named '${e}'|cannot import name '${e}'|has no attribute '${e}'`, "i").test(f.message);
  });
}

/**
 * Which checks have proven themselves, so they may hold a change: those that fail on the ORIGINAL code for a reason
 * the request explains (an assertion, or a name the request asks for that is not there yet), and those that pass on
 * at least one version. A check that never passes anywhere and broke on the original code by itself (a ReferenceError
 * in the test, a bad fixture) is unproven: it may be wrong, so it never holds a correct change.
 * `original`: the checks run on the code before the change (null when it was not run). `expectedLoad`: the file did
 * not load on the original code because of an export or file the request adds (then every check counts as failing
 * there for the right reason).
 */
export function provenKeys(original: string | null, attempts: string[], names: string[] = [], expectedLoad?: (error: string) => boolean): Set<string> {
  const proven = new Set<string>();
  const seen = new Set<string>();
  for (const run of attempts) {
    if (checksLoadError(run) !== null) continue;
    for (const [k, o] of keyedOutcomes(run)) { seen.add(k); if (o.ok) proven.add(k); }
  }
  if (original !== null) {
    const err = checksLoadError(original);
    if (err !== null) {
      if (expectedLoad?.(err)) for (const k of seen) proven.add(k);
    } else {
      for (const [k, o] of keyedOutcomes(original)) if (!o.ok && (assertionFailure(o.failure) || missingNameFailure(o.failure, names))) proven.add(k);
    }
  }
  return proven;
}

/** A version's checks split by proof: proven passes and failures, and failures that have not proven themselves. */
export function adjudicate(output: string, proof: CheckProof): { passed: number; provenFailed: string[]; unprovenFailed: string[] } {
  const r = { passed: 0, provenFailed: [] as string[], unprovenFailed: [] as string[] };
  if (checksLoadError(output) !== null) return r;
  for (const [k, o] of keyedOutcomes(output)) {
    if (o.ok) r.passed++;
    else (failureCounts(k, o.failure, proof) ? r.provenFailed : r.unprovenFailed).push(k);
  }
  return r;
}

/**
 * Evidence about the checks: `proven` (see provenKeys), `passed` (keys some version passed), and the names the
 * request asks for. A proven check's failure on a version counts when the check passed on some version, or when it
 * failed there the way a wrong program fails (an assertion, or a requested name missing), not by an error of its own.
 */
export interface CheckProof { proven: Set<string>; passed?: Set<string>; names?: string[] }

export function failureCounts(key: string, failure: CheckFailure | undefined, proof: CheckProof): boolean {
  if (!proof.proven.has(key)) return false;
  if (proof.passed?.has(key)) return true;
  return assertionFailure(failure) || missingNameFailure(failure, proof.names ?? []);
}

/** Keys (check numbers or test names) that passed on at least one of these runs. */
export function passedKeys(runs: string[]): Set<string> {
  const out = new Set<string>();
  for (const run of runs) if (checksLoadError(run) === null) for (const [k, o] of keyedOutcomes(run)) if (o.ok) out.add(k);
  return out;
}

/**
 * The turn's outcome from the evidence: ready only when the project's tests pass, every check that ran passed, and
 * no check is pending (unchecked or unproven); a proven failing check holds the change (not_ready); a pending one
 * makes it unverified (held for the person, never a false "ready"). Null when the project's tests did not pass.
 */
export function checksVerdict(testsOk: boolean, results: CheckResult[]): { outcome: "ready" | "not_ready" | "unverified"; reason?: string } | null {
  if (!testsOk) return null;
  const failed = results.filter((c) => c.passed === false);
  if (failed.length) return { outcome: "not_ready", reason: `${failed.length} check${failed.length === 1 ? "" : "s"} fail` };
  const pending = results.filter((c) => c.passed === null);
  if (pending.length) return { outcome: "unverified", reason: `${pending.length} of ${results.length} checks could not be judged (${(pending[0].failure?.message ?? "not run").slice(0, 160)})` };
  return { outcome: "ready" };
}

/** A failure that says nothing ("failed", "1 subtest failed"): the real message is on a nested test. */
function generic(f: CheckFailure | undefined): boolean {
  return !f || !f.message.trim() || /^(failed|\d+ subtests? failed|test failed|subtestsFailed)$/i.test(f.message.trim());
}

/** Every check as "could not be run": the generated checks file has an error Apex could not repair. */
export function uncheckedResults(checks: string[], error: string): CheckResult[] {
  return checks.map((line) => ({ ...splitAssumed(line), passed: null, failure: { message: `Apex couldn't run its checks for this (the generated test file has an error: ${error})` } }));
}

/**
 * The test file failed to load (syntax error, bad import path, missing export, a throw at the top level), as the
 * first line of the error; null when it loaded and its tests ran (assertions failing is not a load error).
 * node:test reports such a file as a single failing test named after the file, with the error printed above it as
 * "# " comment lines; pytest reports "ERROR collecting".
 */
export function checksLoadError(output: string): string | null {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  const tests = parseTestOutcomes(output);
  const fileLevel = tests.length === 1 && !tests[0].ok && tests[0].top && /\.(?:[mc]?[jt]sx?)$/.test(tests[0].name);
  if (fileLevel) {
    const err = lines.map((l) => l.replace(/^#\s?/, "")).find((l) => /^[ \t]*(?:\w*Error\b|Error \[)/.test(l));
    return (err ?? "the file did not load").trim().slice(0, 300);
  }
  if (/ERROR collecting|errors? during collection/.test(output)) {
    const e = lines.find((l) => /^E\s+\S/.test(l));
    return (e ? e.replace(/^E\s+/, "") : "the test file did not load").trim().slice(0, 300);
  }
  return null;
}

/** Check numbers (1-based, up to `count`) that have no test named for them in the file's source. */
export function missingCheckTests(code: string, count: number, py = false): number[] {
  const have = new Set<number>();
  const re = py ? /^[ \t]*def test_c(\d+)_/gm : /\b(?:test|it)\s*\(\s*(['"`])\[c(\d+)\]\s/g;
  for (const m of code.matchAll(re)) have.add(Number(py ? m[1] : m[2]));
  return Array.from({ length: count }, (_, i) => i + 1).filter((n) => !have.has(n));
}

/** Title text from a request: first line, markdown removed, at most 60 characters. */
export function plainTitle(text: string, max = 60): string {
  const first = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const plain = first
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`+/g, "")
    .replace(/^#+\s*/, "")
    .replace(/^[-*>]\s+/, "")
    .replace(/(\*\*|__|~~)/g, "")
    .replace(/(^|\s)[*_](\S[^*_]*?)[*_](?=\s|$|[.,;:!?])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return (space > max / 2 ? cut.slice(0, space) : cut).trimEnd() + "…";
}

/** A title holds markdown (emphasis, headings, code, links). */
export function hasMarkdown(title: string): boolean {
  return /\*\*|__|`|^#+\s|\[[^\]]*\]\([^)]*\)/.test(title);
}

/** Lines added and removed between two versions of a file (a multiset count: moved lines count as unchanged). */
export function diffStat(before: string | null, after: string): { added: number; removed: number } {
  const a = before ? before.split("\n") : [];
  const b = after.split("\n");
  const left = new Map<string, number>();
  for (const l of a) left.set(l, (left.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of b) {
    const n = left.get(l) ?? 0;
    if (n > 0) left.set(l, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of left.values()) removed += n;
  return { added, removed };
}

/** unverified: the project's tests pass but Apex's own checks could not run; held, not written, for the user to choose. */
export type TurnOutcome = "ready" | "not_ready" | "unverified" | "failed" | "answer" | "stopped";

export interface TestEvidence {
  command: string;
  passed: number;
  failed: number;
  seconds?: number;
  exitCode?: number | null;
  /** Tests that already failed before the change: shown, not counted in failed. */
  alreadyFailing?: number;
}

/** A change whose checks did not all pass: kept, not written. The server stores it until Keep anyway or Discard. */
export interface HeldChange {
  id: string;
  changes: Array<{ path: string; before: string; after: string }>;
  checks: CheckResult[];
  tests: TestEvidence | null;
  request: string;
  model: string;
  createdAt: string;
}

/** A question rather than a request: ends with "?" or opens with a question word. */
export function isQuestion(text: string): boolean {
  const t = text.trim();
  return /\?[ \t]*$/.test(t.split("\n")[0] ?? "") || /^(why|how|what|where|when|which|who|is|are|does|do|can|could|should|would|explain)\b/i.test(t);
}

/**
 * The conversation's title after a message: it follows the latest request when the conversation opened with a
 * question and this message asks for a change (route kind change or fix), or when the title holds markdown.
 * Null when it stays.
 */
export function nextTitle(current: string, firstUserText: string, latestText: string, kind: string | undefined, userCount: number): string | null {
  const latest = plainTitle(latestText);
  if (!latest) return null;
  const follows = userCount > 1 && (kind === "change" || kind === "fix") && isQuestion(firstUserText);
  const next = follows ? latest : hasMarkdown(current) ? plainTitle(current) : null;
  return next && next !== current ? next : null;
}
