import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { negatesRequest, quoteInRequest, screenChecks, selfExcludingChecks, splitQuote, surgicalDecision, traceCheckLines, vagueCheck } from "./index.js";
import { checksVerdict } from "./index.js";
import { draftChecks, runTests, validateChecks } from "./index.js";

// ---- 1. Self-matching search checks (the rename task) ----

const RENAME = "Rename isSameDay to isSameLocalDay everywhere (src and tests); keep behaviour the same.";
const SCAN_CHECK = `import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
function walk(dir) {
  return readdirSync(dir).flatMap((n) => n === "node_modules" ? [] : statSync(path.join(dir, n)).isDirectory() ? walk(path.join(dir, n)) : [path.join(dir, n)]);
}
test("[c1] isSameDay is not used anywhere", () => {
  const hits = walk(root).filter((f) => f.endsWith(".js") && /\\bisSameDay\\b/.test(readFileSync(f, "utf8")));
  assert.deepEqual(hits, [], "no file mentions isSameDay");
});
`;

async function renamedProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "apex-selfmatch-"));
  await fs.mkdir(path.join(dir, "src"));
  await fs.mkdir(path.join(dir, "tests"));
  await fs.writeFile(path.join(dir, "package.json"), '{"type":"module"}');
  // The correct change: every isSameDay renamed.
  await fs.writeFile(path.join(dir, "src/date.js"), "export function isSameLocalDay(a, b) { return a.toDateString() === b.toDateString(); }\n");
  await fs.writeFile(path.join(dir, "tests/date.test.js"), 'import test from "node:test";\nimport { isSameLocalDay } from "../src/date.js";\ntest("same", () => { isSameLocalDay(new Date(), new Date()); });\n');
  return dir;
}

test("self-match: the rename check found isSameDay in Apex's own check file and failed a correct rename", async () => {
  assert.ok(RENAME.includes("isSameDay"));
  const dir = await renamedProject();
  try {
    await fs.writeFile(path.join(dir, "tests/apex-task-check.test.js"), SCAN_CHECK);
    const raw = await runTests(dir, ["node", "--test", "tests/apex-task-check.test.js"]);
    assert.equal(raw.failed, 1, "without the prelude the check matches its own file");
    await fs.writeFile(path.join(dir, "tests/apex-task-check.test.js"), selfExcludingChecks(SCAN_CHECK));
    const fixed = await runTests(dir, ["node", "--test", "tests/apex-task-check.test.js"]);
    assert.equal(fixed.failed, 0, fixed.output);
    assert.equal(fixed.passed, 1);
    // A real leftover is still caught.
    await fs.writeFile(path.join(dir, "src/old.js"), "export const x = isSameDay;\n");
    const leftover = await runTests(dir, ["node", "--test", "tests/apex-task-check.test.js"]);
    assert.equal(leftover.failed, 1, "a project file with the old name still fails the check");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("self-match: the prelude works for CommonJS checks and fs.promises.readdir", async () => {
  const dir = await renamedProject();
  try {
    await fs.writeFile(path.join(dir, "package.json"), "{}");
    const cjs = `const test = require("node:test");\nconst assert = require("node:assert");\nconst fs = require("node:fs");\nconst path = require("node:path");\ntest("[c1] no isSameDay in tests", async () => {\n  const names = await fs.promises.readdir(path.join(__dirname));\n  assert.ok(!names.some((n) => /apex-task-check/.test(n)), names.join(","));\n});\n`;
    await fs.writeFile(path.join(dir, "tests/apex-task-check.test.cjs"), selfExcludingChecks(cjs));
    const r = await runTests(dir, ["node", "--test", "tests/apex-task-check.test.cjs"]);
    assert.equal(r.failed, 0, r.output);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("self-match: Python prelude goes after __future__ imports and is added once", () => {
  const py = "from __future__ import annotations\nimport os\n\ndef test_c1_no_old_name():\n    assert True\n";
  const out = selfExcludingChecks(py, true);
  assert.ok(out.startsWith("from __future__ import annotations\n"));
  assert.match(out, /__apex_os\.walk = __apex_walk_own/);
  assert.equal(selfExcludingChecks(out, true), out);
});

// ---- 2. A checks file that does not load ----

test("broken check file: never loads after repairs -> the change is written as unverified, not held", async () => {
  const dir = await renamedProject();
  try {
    const broken = 'import test from "node:test";\nimport { nope } from "../src/missing.js";\ntest("[c1] x", () => {});\n';
    let asked = 0;
    const v = await validateChecks(broken, {
      run: async (c) => { await fs.writeFile(path.join(dir, "tests/apex-task-check.test.js"), c); return (await runTests(dir, ["node", "--test", "tests/apex-task-check.test.js"])).output; },
      ask: async () => { asked++; return broken; },
      count: 1, py: false,
    });
    assert.ok(v.error, "still does not load");
    assert.ok(asked >= 1, "a repair was attempted first");
    assert.equal(surgicalDecision({ testsOk: true, checksFailing: false, checksNotLoaded: Boolean(v.error), pending: true }), "write_unverified");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("decision: a proven failing check still holds; pending checks that ran still hold as unverified", () => {
  assert.equal(surgicalDecision({ testsOk: true, checksFailing: true, checksNotLoaded: false, pending: false }), "hold_not_ready");
  assert.equal(surgicalDecision({ testsOk: true, checksFailing: true, checksNotLoaded: true, pending: false }), "hold_not_ready");
  assert.equal(surgicalDecision({ testsOk: true, checksFailing: false, checksNotLoaded: false, pending: true }), "write_unverified");
  assert.equal(surgicalDecision({ testsOk: true, checksFailing: false, checksNotLoaded: false, pending: false }), "write");
  assert.equal(surgicalDecision({ testsOk: false, checksFailing: false, checksNotLoaded: true, pending: false }), null, "project tests failing: nothing is written");
  assert.equal(surgicalDecision({ testsOk: true, checksFailing: true, checksNotLoaded: false, pending: false, warnOnly: true }), "write_unverified", "warn-only: failing drafted checks warn");
  assert.equal(surgicalDecision({ testsOk: true, checksFailing: false, checksNotLoaded: false, pending: true, warnOnly: true }), "write_unverified");
  assert.equal(surgicalDecision({ testsOk: false, checksFailing: true, checksNotLoaded: false, pending: false, warnOnly: true }), null, "warn-only: failing project tests still write nothing");
  assert.equal(checksVerdict(true, [{ text: "x", assumed: false, passed: false }])?.outcome, "not_ready");
});

// ---- 3. Checks that invent or contradict rules ----

const TODAY = "Add GET /api/today returning the signed-in user's tasks due today in their time zone, plus overdue tasks. Done tasks are left out. Sort by priority, then by due time. Signed-out requests get 401.";

test("quote: found ignoring case and punctuation, or nearly word for word; invented quotes are not", () => {
  assert.equal(splitQuote('todayTasks leaves out done tasks — "Done tasks are left out."').quote, "Done tasks are left out.");
  assert.equal(splitQuote('sorts by priority (assumed) — "sort by priority"').text, "sorts by priority (assumed)");
  assert.equal(splitQuote("no quote here").quote, null);
  assert.ok(quoteInRequest("done tasks are left out", TODAY));
  assert.ok(quoteInRequest("Sort by priority then by due time", TODAY));
  assert.ok(quoteInRequest("signed out requests get 401", TODAY));
  assert.ok(!quoteInRequest("tasks with no due date come last", TODAY));
});

test("negation: request says done tasks are left out, check asserts GET /api/today includes done tasks", () => {
  assert.match(negatesRequest("GET /api/today includes done tasks", TODAY) ?? "", /done/);
  assert.equal(negatesRequest("GET /api/today leaves out done tasks", TODAY), null);
  assert.equal(negatesRequest("GET /api/today includes overdue tasks", TODAY), null);
  assert.equal(negatesRequest("includes tasks that are done", "Return only tasks that are not done."), "done");
});

test("vague: 'todayTasks returns the expected value' has no concrete expectation", () => {
  assert.ok(vagueCheck("todayTasks returns the expected value"));
  assert.ok(vagueCheck("GET /api/today works correctly"));
  assert.ok(!vagueCheck("GET /api/today returns 401 when signed out"));
});

test("screen: dropped checks are listed with a reason, never silently removed", () => {
  const lines = [
    'GET /api/today returns 401 when signed out — "Signed-out requests get 401"',
    'GET /api/today includes done tasks — "Done tasks are left out"',
    'todayTasks returns the expected value — "tasks due today"',
    'tasks with no due date come last (assumed) — "tasks without a due date come last"',
    "overdue tasks come first",
  ];
  const r = screenChecks(TODAY, lines, { requireQuote: true });
  assert.deepEqual(r.kept, [lines[0]]);
  assert.equal(r.dropped.length, 4);
  assert.match(r.dropped.find((d) => d.text === lines[1])!.reason, /contradicts/);
  assert.match(r.dropped.find((d) => d.text === lines[2])!.reason, /concrete/);
  assert.match(r.dropped.find((d) => d.text === lines[3])!.reason, /not in the request/);
  assert.match(r.dropped.find((d) => d.text === lines[4])!.reason, /quotes no phrase/);
  // Approved lines a person wrote without a quote are not dropped for that.
  assert.deepEqual(screenChecks(TODAY, ["overdue tasks come before tasks due today"]).kept, ["overdue tasks come before tasks due today"]);
});

const CRASH = `The server crashes on some requests:
TypeError: Cannot read properties of undefined (reading 'trim')
    at parseAuth (src/auth.js:12:31)
    at handle (src/server.js:40:5)
Fix it.`;

test("crash report: checks limited to 'the crash is gone' and 'behaviour unchanged'", () => {
  const lines = [
    "returns 401 when the Authorization header is missing",
    "treats a null header as an empty token",
    "parseAuth(undefined) returns null",
    "does not throw when the Authorization header is undefined",
    "requests with a valid token still work as before",
  ];
  const r = screenChecks(CRASH, lines, { trace: true });
  assert.deepEqual(r.kept, [lines[3], lines[4]]);
  assert.equal(r.dropped.length, 3);
  assert.ok(r.dropped.every((d) => /crash/.test(d.reason)));
  const two = traceCheckLines(CRASH);
  assert.equal(two.length, 2);
  assert.match(two[0], /TypeError: Cannot read properties of undefined/);
});

const gw = (text: string) => ({
  stream: async function* () { yield { type: "text-delta", text }; },
  decide: async () => ({}),
}) as unknown as Parameters<typeof draftChecks>[0]["gateway"];

test("draftChecks: a crash report gets the two crash checks; other drafts are screened with drops reported", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "apex-draft-"));
  try {
    await fs.writeFile(path.join(dir, "a.js"), "export const a = 1;\n");
    const crash = await draftChecks({ gateway: gw("- returns 401 for a null header"), model: "m", root: dir, task: CRASH });
    assert.deepEqual(crash.items, traceCheckLines(CRASH));
    const d = await draftChecks({ gateway: gw('- GET /api/today includes done tasks — "Done tasks are left out"\n- GET /api/today returns 401 when signed out — "Signed-out requests get 401"\n- todayTasks returns the expected value — "tasks due today"'), model: "m", root: dir, task: TODAY });
    assert.equal(d.dropped.length, 2);
    assert.ok(d.items.includes('GET /api/today returns 401 when signed out — "Signed-out requests get 401"'));
    assert.ok(!d.items.some((i) => /includes done tasks/.test(i)));
    // The coverage gate puts the request's own rule back: done tasks are left out.
    assert.ok(d.items.some((i) => /Done tasks are left out/.test(i)), d.items.join("\n"));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
