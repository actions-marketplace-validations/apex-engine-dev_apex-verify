// APEX-WIN-MORE-PLAN items 1-7: checks never fail correct code by accident, cover the request's rules, survive
// retries, repairs get real feedback, fixes get edge cases, the interface is checked first, attempts are adaptive.
// Includes replays of the held changes from the audit (isDone held at 0/6; the Today overdue bug) and of fix-ids.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelEvent as GatewayEvent, ModelRequest } from "./model.js";
import { adjudicate, checkResults, checksVerdict, passedKeys, provenKeys, type CheckProof } from "./index.js";
import { bugEdgeChecks, collapseStatusVariants, coverageGate, requestRules, resolveImports, uncoveredRules, namedExports } from "./index.js";
import { expectedLoadError, majorityGroup, mergeTests, runTests, surgicalBestOfN, unnumberedResults, validateChecks, workedExample } from "./index.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SAMPLE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test-fixtures", "planner-api");
const TODAY = (await fs.readFile(path.join(REPO, "qa/bench/today/task.md"), "utf8").catch(() => "")) ||
  "GET /api/today returns the signed-in user's tasks for today: tasks that are not done and are due today in the user's own time zone, plus overdue tasks that are not done. Sort by priority (high, then medium, then low), then by due time. Add `overdue: true` to tasks due before today and `overdue: false` to the others. Requests without a valid sign-in get 401. Put the logic in `todayTasks(store, session, now)` exported from `src/today.js`, and register the route in `src/server.js`.";
const FIX_IDS = "When the store is created with tasks that already have ids, adding a new task can give it an id that another task already has, so two tasks share an id. Fix it.";

async function copySample(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "apex-winmore-"));
  await fs.cp(SAMPLE, dir, { recursive: true });
  return dir;
}
async function runChecks(dir: string, code: string): Promise<string> {
  await fs.mkdir(path.join(dir, "tests"), { recursive: true });
  await fs.writeFile(path.join(dir, "tests/apex-task-check.test.js"), code);
  const r = await runTests(dir, ["node", "--test", "tests/apex-task-check.test.js"]);
  await fs.rm(path.join(dir, "tests/apex-task-check.test.js"), { force: true });
  return r.output;
}

// ---- Item 2: rules and the coverage gate ----

test("requestRules: the Today request yields its time zone, overdue, done, order, 401, export and route rules", () => {
  const keys = requestRules(TODAY).map((r) => r.key);
  for (const k of ["status:401", "timezone", "overdue", "done", "order", "export:todayTasks", "route:GET /api/today"]) assert.ok(keys.includes(k), `${k} in ${keys.join(", ")}`);
});

test("coverageGate: 8 status-code variants collapse to one and each missing rule gets a line", () => {
  const degenerate = [
    "GET /api/today returns 401 without a sign-in",
    "GET /api/today returns 401 with an expired token",
    "GET /api/today returns 401 with a malformed Authorization header",
    "GET /api/today returns 401 for an unknown token",
    "GET /api/today returns 401 when the Bearer prefix is missing",
    "GET /api/today returns 200 with a valid sign-in",
    "GET /api/today returns 401 after sign-out",
    "GET /api/today returns 401 with an empty token",
  ];
  const rules = requestRules(TODAY);
  assert.deepEqual(uncoveredRules(rules, degenerate).map((r) => r.key).filter((k) => ["timezone", "overdue", "done", "order"].includes(k)).sort(), ["done", "order", "overdue", "timezone"]);
  const collapsed = collapseStatusVariants(degenerate, rules);
  assert.equal(collapsed.filter((l) => /401/.test(l)).length, 1);
  const g = coverageGate(TODAY, degenerate);
  assert.equal(uncoveredRules(rules.filter((r) => ["timezone", "overdue", "done", "order", "status:401"].includes(r.key)), g.checks).length, 0);
  assert.ok(g.added.some((l) => /overdue/i.test(l)) && g.added.some((l) => /time zone/i.test(l)) && g.added.some((l) => /[Ss]ort/.test(l)));
  assert.ok(g.checks.length <= 10);
});

test("coverageGate leaves a list that already covers every rule alone", () => {
  const good = [
    "GET /api/today returns 401 without a valid sign-in",
    "todayTasks returns tasks due today in the user's time zone",
    "Overdue tasks that are not done are included with overdue: true",
    "Done tasks are left out",
    "Tasks are sorted by priority, then by due time",
    "todayTasks is exported from src/today.js and GET /api/today is registered",
  ];
  assert.deepEqual(coverageGate(TODAY, good).added, []);
});

// ---- Item 1 and the proof rule ----

test("proof: a check proves itself by an assertion failing on the original code, or by passing on some version", () => {
  const original = "not ok 1 - [c1] sorts\n  ---\n  error: 'Expected values to be strictly equal'\n  expected: 1\n  actual: 2\n  ...\nnot ok 2 - [c2] broken\n  ---\n  error: 'ReferenceError: makeTask is not defined'\n  ...\nnot ok 3 - [c3] passes later\n  ---\n  error: 'ReferenceError: x'\n  ...\n";
  const attempt = "ok 1 - [c1] sorts\nnot ok 2 - [c2] broken\n  ---\n  error: 'ReferenceError: makeTask is not defined'\n  ...\nok 3 - [c3] passes later\n";
  const other = "not ok 1 - [c1] sorts\n  ---\n  error: 'Expected values to be strictly equal'\n  expected: 1\n  actual: 2\n  ...\nnot ok 2 - [c2] broken\n  ---\n  error: 'ReferenceError: makeTask is not defined'\n  ...\nnot ok 3 - [c3] passes later\n  ---\n  error: 'TypeError: boom'\n  ...\n";
  const proven = provenKeys(original, [attempt, other]);
  assert.deepEqual([...proven].sort(), ["c1", "c3"]);
  const proof: CheckProof = { proven, passed: passedKeys([attempt, other]) };
  const adj = adjudicate(other, proof);
  assert.deepEqual(adj.provenFailed, ["c1", "c3"]);
  assert.deepEqual(adj.unprovenFailed, ["c2"]);
  const r = checkResults(["sorts", "broken check", "passes later", "no test for me"], other, proof);
  assert.deepEqual(r.map((c) => c.passed), [false, null, false, null]);
  assert.match(r[1].failure!.message, /not proven itself/);
  assert.match(r[3].failure!.message, /No test was written/);
});

test("checksVerdict: ready needs tests + every check passing + nothing pending", () => {
  const t = (passed: boolean | null) => ({ text: "x", assumed: false, passed });
  assert.deepEqual(checksVerdict(true, [t(true), t(true)]), { outcome: "ready" });
  assert.equal(checksVerdict(true, [t(true), t(null)])?.outcome, "unverified");
  assert.equal(checksVerdict(true, [t(false), t(null)])?.outcome, "not_ready");
  assert.equal(checksVerdict(false, [t(true)]), null);
  assert.deepEqual(checksVerdict(true, []), { outcome: "ready" });
});

test("validateChecks: under 60% covered is redrafted once; then ONLY the missing tests are asked for and merged", async () => {
  const head = 'import test from "node:test";\nimport assert from "node:assert/strict";\n';
  const t = (n: number) => `test("[c${n}] check ${n}", () => { assert.equal(1, 1); });`;
  const file = (ns: number[]) => head + ns.map(t).join("\n") + "\n";
  const asked: string[] = [];
  const answers = [file([1, 2, 3]), `${t(5)}\n${t(6)}`];
  const v = await validateChecks(file([1]), { run: async () => "ok 1 - [c1] check 1\n", ask: async (p) => { asked.push(p); return answers.shift() ?? ""; }, count: 6, py: false });
  assert.equal(asked.length, 2);
  assert.match(asked[0], /Answer with the whole file/);
  assert.match(asked[1], /Write ONLY the missing test/);
  assert.match(asked[1], /4, 5, 6/);
  for (const n of [1, 2, 3, 5, 6]) assert.ok(v.code.includes(`[c${n}]`), `c${n}`);
  assert.equal(v.code.match(/\[c1\]/g)?.length, 1);
  // A reused file is never redrafted, only added to.
  const asked2: string[] = [];
  const v2 = await validateChecks(file([1]), { run: async () => "", ask: async (p) => { asked2.push(p); return t(2); }, count: 2, py: false, reuse: true });
  assert.equal(asked2.length, 1);
  assert.match(asked2[0], /ONLY the missing/);
  assert.ok(v2.code.startsWith(file([1]).trimEnd()));
  assert.ok(v2.code.includes("[c2]"));
});

test("mergeTests adds new imports after the file's imports and drops tests the file already numbers", () => {
  const code = 'import test from "node:test";\nimport { a } from "../src/a.js";\ntest("[c1] a", () => {});\n';
  const add = 'import test from "node:test";\nimport { b } from "../src/b.js";\ntest("[c1] again", () => {});\ntest("[c2] b", () => {\n  b();\n});';
  const m = mergeTests(code, add);
  assert.equal(m.match(/node:test/g)?.length, 1);
  assert.ok(m.indexOf('import { b }') < m.indexOf('test("[c1] a"'));
  assert.ok(!m.includes("[c1] again"));
  assert.ok(m.includes('test("[c2] b", () => {\n  b();\n});'));
});

// ---- Items 4, 5, 7 helpers ----

test("workedExample names the failing check's expected and actual values", () => {
  const out = "not ok 1 - [c2] overdue tasks are included\n  ---\n  error: 'Expected values to be strictly equal'\n  expected: 2\n  actual: 1\n  ...\n";
  assert.match(workedExample(out), /"\[c2\] overdue tasks are included" expected 2 but your code gave 1/);
  assert.equal(workedExample("ok 1 - fine\n"), "");
});

test("resolveImports finds the helpers a repair needs (zone.js, priority.js for today.js)", async () => {
  const dir = await copySample();
  try {
    await fs.writeFile(path.join(dir, "src/today.js"), TODAY_HELD);
    assert.deepEqual(await resolveImports(dir, "src/today.js"), ["src/time/zone.js", "src/tasks/priority.js"]);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("bugEdgeChecks for fix-ids: many adds after a seeded gap, empty store, ids keep their type", () => {
  const e = bugEdgeChecks(FIX_IDS);
  assert.equal(e.length, 3);
  assert.match(e[0], /Many adds[\s\S]*gap[\s\S]*never produce a duplicate id/);
  assert.match(e[1], /empty/i);
  assert.match(e[2], /string id stays a string/);
});

test("majorityGroup keeps the behaviour most passing versions share (S*)", () => {
  assert.deepEqual(majorityGroup(["[1,2]", "[2,1]", "[1,2]"]), [0, 2]);
  assert.deepEqual(majorityGroup(["a", "b"]), [0, 1]);
  assert.deepEqual(majorityGroup([null, "a", "a"]), [1, 2]);
});

// ---- Replays ----

const IS_DONE_REQ = "Add an exported function isDone(task) to src/tasks/priority.js that returns true only when task.done is true, with a test in tests/.";
const IS_DONE_CHECKS = [
  "`isDone(task)` returns true only when `task.done` is true",
  "`isDone(task)` returns false when `task.done` is false or undefined",
  "`isDone(task)` returns false when `task` is not an object",
  "`isDone(task)` does not mutate the input task",
  "`isDone(task)` works with any task object regardless of other properties",
  "`isDone(task)` handles edge cases like `task.done` being `false` or `undefined`",
];
const IS_DONE_HELD = `/** Returns true only when task.done is true. */\nexport function isDone(task) {\n  return task?.done === true;\n}\n`;
const TODAY_HELD = `import { isBeforeToday, dayKey } from "./time/zone.js";\nimport { byPriorityThenDue } from "./tasks/priority.js";\n\nexport function todayTasks(store, session, now = new Date()) {\n  const userTasks = store.forUser(session.userId);\n  return userTasks\n    .filter((task) => !task.done && !isBeforeToday(task.due, now, session.timeZone))\n    .map((task) => ({\n      ...task,\n      overdue: isBeforeToday(task.due, now, session.timeZone),\n    }))\n    .sort(byPriorityThenDue);\n}\n`;
const TODAY_FIXED = TODAY_HELD.replace("!task.done && !isBeforeToday(task.due, now, session.timeZone)", "!task.done && (isBeforeToday(task.due, now, session.timeZone) || dayKey(task.due, session.timeZone) === dayKey(now, session.timeZone))");

test("replay: the correct isDone held at 0 of 6 is no longer held (malformed c1, no tests for c2-c6 -> unverified)", async () => {
  const dir = await copySample();
  try {
    // The audit's shape: one malformed test (an error in the check itself) and no tests for the other five checks.
    const malformed = `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { isDone } from "../src/tasks/priority.js";\ntest("[c1] returns true only when done", () => { assert.equal(isDone(makeTask({ done: true })), true); });\n`;
    const names = namedExports(IS_DONE_REQ).map((w) => w.name);
    const expected = expectedLoadError(namedExports(IS_DONE_REQ), []);
    const original = await runChecks(dir, malformed);
    await fs.appendFile(path.join(dir, "src/tasks/priority.js"), "\n" + IS_DONE_HELD);
    const run = await runChecks(dir, malformed);
    // Before: every check failed ("test failed", then "No test was written") and the change was held as Not ready.
    const proof: CheckProof = { proven: provenKeys(original, [run], names, expected), passed: passedKeys([run]), names };
    const r = checkResults(IS_DONE_CHECKS, run, proof);
    assert.ok(r.every((c) => c.passed === null), JSON.stringify(r.map((c) => c.failure?.message)));
    assert.equal(checksVerdict(true, r)?.outcome, "unverified");
    // A working file for the same change: every check passes -> ready.
    const good = `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { isDone } from "../src/tasks/priority.js";\n` +
      [`assert.equal(isDone({ done: true }), true)`, `assert.equal(isDone({ done: false }), false); assert.equal(isDone({}), false)`, `assert.equal(isDone(null), false); assert.equal(isDone(3), false)`, `const t = { done: true }; isDone(t); assert.deepEqual(t, { done: true })`, `assert.equal(isDone({ done: true, title: "x", priority: "high" }), true)`, `assert.equal(isDone({ done: undefined }), false); assert.equal(isDone({ done: "true" }), false)`]
        .map((b, i) => `test("[c${i + 1}] check", () => { ${b}; });`).join("\n") + "\n";
    const run2 = await runChecks(dir, good);
    assert.equal(checksVerdict(true, checkResults(IS_DONE_CHECKS, run2, { proven: provenKeys(null, [run2]), passed: passedKeys([run2]) }))?.outcome, "ready");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

const TODAY_CHECKS_FILE = `import test from "node:test";
import assert from "node:assert/strict";
import { todayTasks } from "../src/today.js";
import { createStore } from "../src/tasks/store.js";
import { createRouter } from "../src/server.js";
const now = new Date("2026-11-12T10:00:00Z");
const session = { userId: "dana", timeZone: "UTC" };
const store = () => createStore([
  { id: "1", userId: "dana", title: "today low", due: "2026-11-12T15:00:00Z", priority: "low" },
  { id: "2", userId: "dana", title: "yesterday", due: "2026-11-11T09:00:00Z", priority: "medium" },
  { id: "3", userId: "dana", title: "today high", due: "2026-11-12T12:00:00Z", priority: "high" },
  { id: "4", userId: "dana", title: "done", due: "2026-11-12T08:00:00Z", priority: "high", done: true },
  { id: "5", userId: "dana", title: "tomorrow", due: "2026-11-13T09:00:00Z", priority: "high" },
]);
test("[c1] GET /api/today returns 401 without a valid sign-in", async () => {
  assert.equal((await createRouter(createStore())("GET", "/api/today", {})).status, 401);
});
test("[c2] overdue tasks that are not done are included with overdue: true", () => {
  const t = todayTasks(store(), session, now).find((x) => x.id === "2");
  assert.ok(t, "the overdue task is in the list");
  assert.equal(t.overdue, true);
});
test("[c3] tasks due today are included with overdue: false; tomorrow is not", () => {
  const ids = todayTasks(store(), session, now).map((x) => x.id);
  assert.ok(ids.includes("1") && ids.includes("3") && !ids.includes("5"));
  assert.ok(todayTasks(store(), session, now).filter((x) => x.id !== "2").every((x) => x.overdue === false));
});
test("[c4] done tasks are left out", () => {
  assert.ok(!todayTasks(store(), session, now).some((x) => x.done));
});
test("[c5] high before medium before low", () => {
  const ranks = todayTasks(store(), session, now).map((x) => ({ high: 0, medium: 1, low: 2 })[x.priority]);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
});
`;

test("replay: the Today change with the overdue-filter bug is caught by a proven check (held, not ready); the one-line fix is ready", async () => {
  const dir = await copySample();
  try {
    const wanted = namedExports(TODAY);
    const names = wanted.map((w) => w.name);
    const expected = expectedLoadError(wanted, ["src/today.js"]);
    const original = await runChecks(dir, TODAY_CHECKS_FILE);
    await fs.writeFile(path.join(dir, "src/today.js"), TODAY_HELD);
    await fs.writeFile(path.join(dir, "src/server.js"), (await fs.readFile(path.join(dir, "src/server.js"), "utf8"))
      .replace('import { isTimeZone } from "./time/zone.js";', 'import { isTimeZone } from "./time/zone.js";\nimport { todayTasks } from "./today.js";')
      .replace('"GET /api/tasks": signedIn', '"GET /api/today": signedIn((session) => ok(todayTasks(store, session, new Date()))),\n    "GET /api/tasks": signedIn'));
    const held = await runChecks(dir, TODAY_CHECKS_FILE);
    const lines = ["GET /api/today returns 401 without a valid sign-in", "Overdue tasks are included with overdue: true", "Tasks due today are included", "Done tasks are left out", "Sorted by priority"];
    let proof: CheckProof = { proven: provenKeys(original, [held], names, expected), passed: passedKeys([held]), names };
    const r = checkResults(lines, held, proof);
    assert.equal(r[1].passed, false, JSON.stringify(r[1]));
    assert.match(r[1].failure!.message, /overdue task is in the list/);
    // The held change also lets tomorrow's task in (its filter is "not before today"): a second proven failure.
    assert.equal(r[2].passed, false);
    assert.deepEqual([r[0].passed, r[3].passed, r[4].passed], [true, true, true]);
    assert.equal(checksVerdict(true, r)?.outcome, "not_ready");
    // The repair gets the helpers' source and the failing assertion; the fixed version passes everything.
    await fs.writeFile(path.join(dir, "src/today.js"), TODAY_FIXED);
    const fixed = await runChecks(dir, TODAY_CHECKS_FILE);
    proof = { proven: provenKeys(original, [held, fixed], names, expected), passed: passedKeys([held, fixed]), names };
    assert.equal(checksVerdict(true, checkResults(lines, fixed, proof))?.outcome, "ready");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

const FIX_IDS_EDGE_FILE = `import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/tasks/store.js";
test("reproduces: a task added after a seeded store gets a new id", () => {
  const s = createStore([{ id: "1", userId: "a", title: "x" }, { id: "3", userId: "a", title: "y" }]);
  const t = s.add({ userId: "a", title: "z" });
  assert.ok(!["1", "3"].includes(t.id), "reused id " + t.id);
});
test("edge: many adds after seeding with a gap never produce a duplicate id", () => {
  const s = createStore([{ id: "1", userId: "a", title: "x" }, { id: "2", userId: "a", title: "y" }, { id: "7", userId: "a", title: "z" }]);
  for (let i = 0; i < 50; i++) s.add({ userId: "a", title: "n" + i });
  const ids = s.forUser("a").map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
});
test("edge: an empty store numbers its first item from 1", () => {
  assert.equal(createStore().add({ userId: "a", title: "x" }).id, "1");
});
test("edge: new ids stay strings", () => {
  assert.equal(typeof createStore([{ id: "4", userId: "a", title: "x" }]).add({ userId: "a", title: "y" }).id, "string");
});
`;

test("replay: fix-ids edge checks catch the fix that only skips seeded ids (the false Ready), and pass the real fix", async () => {
  const dir = await copySample();
  try {
    const storePath = path.join(dir, "src/tasks/store.js");
    const before = await fs.readFile(storePath, "utf8");
    const original = await runChecks(dir, FIX_IDS_EDGE_FILE);
    // A plausible fix that passes the project's tests and the reproduction, but collides after a gap.
    await fs.writeFile(storePath, before.replace("const t = { ...DEFAULTS, ...task, id: String(tasks.length + 1) };",
      "const seeded = new Set(seed.map((s) => String(s.id)));\n      let id = String(tasks.length + 1);\n      if (seeded.has(id)) id = String(Math.max(...[...seeded].map(Number)) + 1);\n      const t = { ...DEFAULTS, ...task, id };"));
    const weak = await runChecks(dir, FIX_IDS_EDGE_FILE);
    await fs.writeFile(storePath, before.replace("const t = { ...DEFAULTS, ...task, id: String(tasks.length + 1) };",
      "let next = tasks.length + 1;\n      while (tasks.some((x) => x.id === String(next))) next++;\n      const t = { ...DEFAULTS, ...task, id: String(next) };"));
    const good = await runChecks(dir, FIX_IDS_EDGE_FILE);
    const proof: CheckProof = { proven: provenKeys(original, [weak, good]), passed: passedKeys([weak, good]) };
    const weakR = unnumberedResults(weak, proof);
    assert.equal(weakR.find((c) => /many adds/.test(c.text))?.passed, false);
    assert.equal(weakR.find((c) => /reproduces/.test(c.text))?.passed, true);
    assert.equal(checksVerdict(true, weakR)?.outcome, "not_ready");
    assert.equal(checksVerdict(true, unnumberedResults(good, proof))?.outcome, "ready");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ---- surgicalBestOfN wiring: interface first, adaptive attempts, reused checks, unverified verdict ----

async function tiny(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "apex-winmore-s-"));
  await fs.mkdir(path.join(dir, "src/tasks"), { recursive: true }); await fs.mkdir(path.join(dir, "tests"));
  await fs.writeFile(path.join(dir, "package.json"), '{"type":"module"}');
  await fs.writeFile(path.join(dir, "src/tasks/priority.js"), "export const RANK = { high: 0 };\n");
  await fs.writeFile(path.join(dir, "tests/priority.test.js"), 'import test from "node:test";\nimport assert from "node:assert";\nimport { RANK } from "../src/tasks/priority.js";\ntest("rank", () => assert.equal(RANK.high, 0));\n');
  return dir;
}
const edit = (name: string) => `=== FILE: src/tasks/priority.js\n<<<<<<< SEARCH\nexport const RANK = { high: 0 };\n=======\nexport const RANK = { high: 0 };\nexport function ${name}(task) {\n  return task?.done === true;\n}\n>>>>>>> REPLACE\n=== END`;
function fakeGateway(answer: (req: ModelRequest, text: string) => string) {
  const calls: Array<{ kind: string; text: string }> = [];
  return {
    calls,
    async *stream(req: ModelRequest): AsyncIterable<GatewayEvent> {
      const sys = req.messages[0]?.content ?? "";
      const text = req.messages.map((m) => m.content).join("\n");
      const kind = /You write tests/.test(sys) ? "checks" : /probe script/.test(sys) ? "probe" : "edits";
      calls.push({ kind, text });
      yield { type: "text-delta", text: answer(req, text) };
      yield { type: "done" } as GatewayEvent;
    },
  };
}

test("interface first: a version with the wrong export name is repaired at once, without running its tests", async () => {
  const root = await tiny();
  try {
    const g = fakeGateway((_r, text) => (/does not provide it with that exact name/.test(text) ? edit("isDone") : edit("isFinished")));
    const events: string[] = [];
    const r = await surgicalBestOfN({ gateway: g, model: "m", root, task: IS_DONE_REQ, n: 1, repairs: 0, taskChecks: false, apply: false, scopeTargets: [], onEvent: (e) => events.push(e.text) });
    assert.ok(r.candidates[0].interfaceMissing?.length, "first version flagged");
    assert.match(r.candidates[0].testOutput, /interface: src\/tasks\/priority\.js does not export isDone/);
    assert.ok(events.some((e) => /not running the tests/.test(e)));
    assert.match(r.changes[0].after, /export function isDone/);
    assert.equal(r.chosen?.failed, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("adaptive: one attempt first; when it passes, no other version is written", async () => {
  const root = await tiny();
  try {
    const g = fakeGateway(() => edit("isDone"));
    const r = await surgicalBestOfN({ gateway: g, model: "m", root, task: IS_DONE_REQ, n: 3, adaptive: true, taskChecks: false, apply: false, scopeTargets: [] });
    assert.equal(g.calls.filter((c) => c.kind === "edits").length, 1);
    assert.equal(r.chosen?.failed, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("adaptive: a failing first attempt gets other versions with a different framing, not the same prompt", async () => {
  const root = await tiny();
  try {
    let k = 0;
    const g = fakeGateway(() => (k++ === 0 ? "no edits" : edit("isDone")));
    const r = await surgicalBestOfN({ gateway: g, model: "m", root, task: IS_DONE_REQ, n: 3, adaptive: true, repairs: 0, taskChecks: false, apply: false, scopeTargets: [] });
    const edits = g.calls.filter((c) => c.kind === "edits");
    assert.equal(edits.length, 2);
    assert.notEqual(edits[0].text, edits[1].text);
    assert.match(edits[1].text, /go through each rule the task states/);
    assert.equal(r.chosen?.failed, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("reuseChecks: the earlier file is reused (no new checks file written), exposed as checksFile; a malformed check makes the outcome unverified, not held", async () => {
  const root = await tiny();
  try {
    const reused = `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { isDone } from "../src/tasks/priority.js";\ntest("[c1] true when done", () => { assert.equal(isDone({ done: true }), true); });\ntest("[c2] false otherwise", () => { assert.equal(isDone(makeTask()), false); });\n`;
    const g = fakeGateway((_r, text) => (/ONLY the missing/.test(text) ? "" : edit("isDone")));
    const reqs = ["isDone(task) returns true when task.done is true", "isDone(task) returns false otherwise", "isDone does not mutate the task"];
    const r = await surgicalBestOfN({ gateway: g, model: "m", root, task: IS_DONE_REQ, n: 1, repairs: 0, requirements: reqs, reuseChecks: { content: reused }, apply: false, scopeTargets: [] });
    const checkCalls = g.calls.filter((c) => c.kind === "checks");
    assert.equal(checkCalls.length, 1, "only the missing test was asked for");
    assert.match(checkCalls[0].text, /numbered line 3\. Write ONLY the missing test/);
    assert.equal(r.checksFile?.content.trim(), reused.trim());
    assert.deepEqual(r.checkResults?.slice(0, 3).map((c) => c.passed), [true, null, null]);
    assert.equal(r.verdict?.outcome, "unverified");
    assert.ok(r.checksError, "older callers see unverified");
    assert.equal(r.chosen?.checksFailed, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
