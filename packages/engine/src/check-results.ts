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

interface TestOutcome {
  name: string;
  ok: boolean;
  /** Top-level test (not a subtest inside a describe). */
  top: boolean;
  /** Reported with "# SKIP": it did not run, so it neither passed nor failed. */
  skipped?: boolean;
  failure?: CheckFailure;
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

/** A failure that says nothing ("failed", "1 subtest failed"): the real message is on a nested test. */
function generic(f: CheckFailure | undefined): boolean {
  return !f || !f.message.trim() || /^(failed|\d+ subtests? failed|test failed|subtestsFailed)$/i.test(f.message.trim());
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

