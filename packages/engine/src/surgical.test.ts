import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ModelEvent as GatewayEvent, ModelRequest } from "./model.js";
import { boundedCall, checkLines, draftChecks, focusedContextX, parseEdits, surgicalBestOfN } from "./index.js";
import { requestOnly } from "./index.js";

const edit = (body: string) => `=== FILE: src/add.js\n<<<<<<< SEARCH\nexport const add = (a, b) => a - b;\n=======\n${body}\n>>>>>>> REPLACE\n`;

async function project(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "apex-surg-test-"));
  await fs.mkdir(path.join(dir, "src")); await fs.mkdir(path.join(dir, "tests"));
  await fs.writeFile(path.join(dir, "package.json"), '{"type":"module"}');
  await fs.writeFile(path.join(dir, "src/add.js"), "export const add = (a, b) => a - b;\n");
  await fs.writeFile(path.join(dir, "tests/add.test.js"), 'import test from "node:test";\nimport assert from "node:assert";\nimport { add } from "../src/add.js";\ntest("adds", () => assert.equal(add(2, 3), 5));\n');
  return dir;
}

function fake(answers: (req: ModelRequest) => string) {
  const seen: ModelRequest[] = [];
  return { seen, async *stream(req: ModelRequest): AsyncIterable<GatewayEvent> { seen.push(req); yield { type: "text-delta", text: answers(req) }; yield { type: "done" }; } };
}

test("parseEdits reads search/replace and whole-file blocks, with fences", () => {
  const e = parseEdits("```\n" + edit("x") + "=== FILE: src/new.js\n<<<<<<< SEARCH\n=======\nexport {};\n>>>>>>> REPLACE\n```");
  assert.equal(e.length, 2);
  assert.equal(e[0].search, "export const add = (a, b) => a - b;");
  assert.equal(e[1].search, undefined);
});

test("tests pick the passing candidate and only it reaches the project", async () => {
  const root = await project();
  const gw = fake((req) => (req.slot === 2 ? edit("export const add = (a, b) => a + b;") : edit("export const add = (a, b) => a * b;")));
  const r = await surgicalBestOfN({ gateway: gw, model: "m", root, task: "Fix add in src/add.js", n: 3, repairs: 0 });
  assert.equal(r.chosen?.index, 1);
  assert.equal(r.chosen?.failed, 0);
  assert.match(await fs.readFile(path.join(root, "src/add.js"), "utf8"), /a \+ b/);
  const cands = gw.seen.filter((s) => (s.slot ?? 0) <= 3);
  assert.equal(new Set(cands.map((s) => s.temperature)).size, 3);
  assert.match(cands[0].messages[1].content, /<file path="src\/add.js">/);
});

test("a failing best candidate gets one repair with the test failure", async () => {
  const root = await project();
  const gw = fake((req) => {
    const last = req.messages[req.messages.length - 1].content;
    if (/Failing tests/.test(last)) return "=== FILE: src/add.js\n<<<<<<< SEARCH\nexport const add = (a, b) => a * b;\n=======\nexport const add = (a, b) => a + b;\n>>>>>>> REPLACE";
    return edit("export const add = (a, b) => a * b;");
  });
  const r = await surgicalBestOfN({ gateway: gw, model: "m", root, task: "Fix add", n: 2, repairs: 1 });
  assert.equal(r.chosen?.repaired, true);
  assert.equal(r.chosen?.failed, 0);
  assert.equal(r.modelCalls, 4); // 2 candidates, task checks, 1 repair
  assert.match(await fs.readFile(path.join(root, "src/add.js"), "utf8"), /a \+ b/);
});

test("endOfEdits stops at === END or at a repeated edit", async () => {
  const { endOfEdits } = await import("./index.js");
  const block = "<<<<<<< SEARCH\na - b\n=======\na + b\n>>>>>>> REPLACE\n";
  assert.equal(endOfEdits("=== FILE: a.js\n" + block), -1);
  assert.equal(endOfEdits("=== FILE: a.js\n" + block + "=== END\n"), ("=== FILE: a.js\n" + block).length);
  const once = "=== FILE: a.js\n" + block;
  assert.equal(endOfEdits(once + block), once.length);
  assert.equal(endOfEdits(once + "=== FILE: b.js\n" + block), -1);
});

test("task checks pick between candidates that pass the same tests", async () => {
  const root = await project();
  // Both pass "adds" (2 + 3); only one also handles the requirement the task states (strings are numbers).
  const gw = fake((req) => {
    if (/Write one new test file/.test(req.messages[req.messages.length - 1].content)) {
      return 'Sure.\n```js\nimport test from "node:test";\nimport assert from "node:assert";\nimport { add } from "../src/add.js";\ntest("strings", () => assert.equal(add("2", "3"), 5));\n```\n';
    }
    return req.slot === 1 ? edit("export const add = (a, b) => a + b;") : edit("export const add = (a, b) => Number(a) + Number(b);");
  });
  const r = await surgicalBestOfN({ gateway: gw, model: "m", root, task: "Fix add; it must also accept numbers given as strings", n: 2, repairs: 0 });
  assert.equal(r.chosen?.index, 1);
  assert.equal(r.chosen?.checksPassed, 1);
  assert.match(await fs.readFile(path.join(root, "src/add.js"), "utf8"), /Number\(a\)/);
  await assert.rejects(fs.access(path.join(root, "tests/apex-task-check.test.js")));
});

test("tests asked for: kept checks get a file name from the task, never an existing one", async () => {
  const { asksForTests, keptCheckPath } = await import("./index.js");
  assert.equal(asksForTests("Add GET /api/tasks/count that returns counts, and add a test"), true);
  assert.equal(asksForTests("Rename price to unitPrice"), false);
  assert.equal(asksForTests("Fix the bug, no tests needed"), false);
  assert.equal(asksForTests("Change it without tests"), false);
  assert.equal(keptCheckPath("tests/", "Add GET /api/tasks/count that returns counts", []), "tests/tasks-count-counts.test.js");
  assert.equal(keptCheckPath("tests/", "Add GET /api/tasks/count that returns counts", ["tests/tasks-count-counts.test.js"]), "tests/tasks-count-counts-2.test.js");
});

test("a changed file that does not parse is reported, even when no test loads it", async () => {
  const { syntaxErrors } = await import("./index.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "apex-syntax-"));
  await fs.writeFile(path.join(dir, "ok.js"), "export const a = 1;\n");
  await fs.writeFile(path.join(dir, "bad.js"), "console.log(JSON.stringify({ a: 1 });\n");
  await fs.writeFile(path.join(dir, "notes.md"), "(\n");
  const errs = await syntaxErrors(dir, ["ok.js", "bad.js", "notes.md", "gone.js"]);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /^bad\.js: SyntaxError/);
});

test("a test that already failed is not held against a version, unless the task is to fix it", async () => {
  const root = await project();
  // Another, unrelated test that fails before any change.
  await fs.writeFile(path.join(root, "tests/old.test.js"), 'import test from "node:test";\nimport assert from "node:assert";\ntest("old bug", () => assert.equal(1, 2));\n');
  await fs.writeFile(path.join(root, "src/add.js"), "export const add = (a, b) => a + b;\n");
  const mul = "=== FILE: src/add.js\n<<<<<<< SEARCH\nexport const add = (a, b) => a + b;\n=======\nexport const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n>>>>>>> REPLACE\n";
  const events: string[] = [];
  const r = await surgicalBestOfN({ gateway: fake(() => mul), model: "m", root, task: "Add a mul function to src/add.js", n: 2, repairs: 0, taskChecks: false, onEvent: (e) => events.push(e.text) });
  assert.equal(r.chosen?.failed, 0, "the old failure does not count");
  assert.ok(events.some((t) => /1 test already failed before the change/.test(t)));
  // A version that breaks a passing test still fails.
  const breaks = "=== FILE: src/add.js\n<<<<<<< SEARCH\nexport const add = (a, b) => a + b;\n=======\nexport const add = (a, b) => a - b;\n>>>>>>> REPLACE\n";
  const root2 = await project();
  await fs.writeFile(path.join(root2, "tests/old.test.js"), 'import test from "node:test";\nimport assert from "node:assert";\ntest("old bug", () => assert.equal(1, 2));\n');
  await fs.writeFile(path.join(root2, "src/add.js"), "export const add = (a, b) => a + b;\n");
  const r2 = await surgicalBestOfN({ gateway: fake(() => breaks), model: "m", root: root2, task: "Tidy src/add.js", n: 1, repairs: 0, taskChecks: false, apply: false });
  assert.equal(r2.chosen?.failed, 1);
  // "Fix …": every failing test counts.
  const root3 = await project();
  const noop = edit("export const add = (a, b) => a - b; // same");
  const r3 = await surgicalBestOfN({ gateway: fake(() => noop), model: "m", root: root3, task: "Fix add", n: 1, repairs: 0, taskChecks: false, apply: false });
  assert.equal(r3.chosen?.failed, 1);
});

test("a version that skips a file the task names scores lower and is asked to finish", async () => {
  const root = await project();
  await fs.writeFile(path.join(root, "src/add.js"), "export const add = (a, b) => a + b;\n");
  await fs.writeFile(path.join(root, "src/main.js"), "export const run = () => 1;\n");
  const one = "=== FILE: src/add.js\n<<<<<<< SEARCH\nexport const add = (a, b) => a + b;\n=======\nexport const add = (a, b) => a + b; // json\n>>>>>>> REPLACE\n";
  const both = one + "=== FILE: src/main.js\n<<<<<<< SEARCH\nexport const run = () => 1;\n=======\nexport const run = () => 2;\n>>>>>>> REPLACE\n";
  const r = await surgicalBestOfN({ gateway: fake((req) => (req.slot === 2 ? both : one)), model: "m", root, task: "Add a json option: change src/add.js and wire it in src/main.js", n: 2, repairs: 0, taskChecks: false, apply: false });
  assert.equal(r.chosen?.index, 1, "the version that changed both named files wins");
  assert.deepEqual(r.candidates[0].skippedNamed, ["src/main.js"]);
});

test("edits survive a model's slips: a repeated edit, and one quoted line with a typo", async () => {
  const { applyEdits } = await import("./index.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "apex-slips-"));
  const src = "/** Table. */\nexport function formatTable(c) {\n  return `lines ${c.lines}\\nwords ${c.words}\\nchars ${c.chars}`;\n}\n";
  await fs.writeFile(path.join(dir, "format.js"), src);
  const typo = "/** Table. */\nexport function formatTable(c) {\n  return `lines ${c.lines}\\nwords ${c.words\\nchars ${c.chars}`;\n}";
  const added = "/** Table. */\nexport function formatTable(c) {\n  return `lines ${c.lines}\\nwords ${c.words}\\nchars ${c.chars}`;\n}\n\nexport function formatJson(c) {\n  return JSON.stringify(c);\n}";
  const r = await applyEdits(dir, [{ path: "format.js", search: typo, replace: added }, { path: "format.js", search: typo, replace: added }]);
  assert.deepEqual(r.errors, [], "the typo line still finds its block; the repeat is already done");
  const out = await fs.readFile(path.join(dir, "format.js"), "utf8");
  assert.equal(out.match(/formatJson/g)?.length, 1);
  // A block that is simply not there is still an error.
  const miss = await applyEdits(dir, [{ path: "format.js", search: "function nothing() {\n  return 0;\n}", replace: "x" }]);
  assert.equal(miss.errors.length, 1);
});

test("the first version that passes everything ends the wait; slower versions are cancelled", async () => {
  const root = await project();
  const good = edit("export const add = (a, b) => a + b;");
  let cancelled = 0;
  const gw = {
    async *stream(req: ModelRequest): AsyncIterable<GatewayEvent> {
      if ((req.slot ?? 0) > 1 && (req.slot ?? 0) <= 3) {
        // Versions 2 and 3 are slow: they only end when cancelled.
        await new Promise<void>((resolve) => { const t = setTimeout(resolve, 20_000); req.signal?.addEventListener("abort", () => { clearTimeout(t); cancelled++; resolve(); }); });
        if (req.signal?.aborted) throw new Error("aborted");
      }
      yield { type: "text-delta", text: good }; yield { type: "done" };
    },
  };
  const t0 = Date.now();
  const r = await surgicalBestOfN({ gateway: gw, model: "m", root, task: "Fix add in src/add.js", n: 3, repairs: 0, taskChecks: false });
  assert.ok(Date.now() - t0 < 10_000, "did not wait for the slow versions");
  assert.equal(cancelled, 2);
  assert.equal(r.chosen?.index, 0);
  assert.equal(r.candidates.length, 1);
  assert.match(await fs.readFile(path.join(root, "src/add.js"), "utf8"), /a \+ b/);
  // When every version is wanted (a review will compare them), all are waited for.
  const root2 = await project();
  const all = await surgicalBestOfN({ gateway: fake(() => good), model: "m", root: root2, task: "Fix add in src/add.js", n: 3, repairs: 0, taskChecks: false, firstPassingWins: false });
  assert.equal(all.candidates.length, 3);
});

test("a checks answer that repeats setup lines is kept; one cut before its end keeps its complete tests", async () => {
  const { checkCode, repeatsALine } = await import("./index.js");
  const file = 'import { test } from "node:test";\ntest("a", () => {\n  const s = createStore();\n});\ntest("b", () => {\n  const s = createStore();\n});\ntest("c", () => {\n  const s = createStore();\n});';
  assert.equal(repeatsALine(file, 8), false, "three tests with the same setup line are not a loop");
  assert.equal(repeatsALine(Array(9).fill("  const s = createStore();").join("\n"), 8), true);
  assert.equal(checkCode("```js\n" + file + "\n```"), file);
  const cut = "```js\n" + file + '\ntest("d", () => {\n  const s = crea';
  assert.equal(checkCode(cut), file, "the unfinished last test is dropped");
  assert.equal(checkCode("no code here"), "");
});

test("a repair's context holds the changed files and the files the failure names, not the rest", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "apex-focus-"));
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "src/a.js"), "export const a = 'CHANGED';\n");
  await fs.writeFile(path.join(dir, "src/b.js"), "export const b = 'NAMED';\n");
  await fs.writeFile(path.join(dir, "src/c.js"), "export const c = 'UNRELATED';\n");
  const ctx = (await focusedContextX(dir, ["src/a.js"], "not ok 1 - b\n  at src/b.js:1:1")).text;
  assert.match(ctx, /CHANGED/);
  assert.match(ctx, /NAMED/);
  assert.doesNotMatch(ctx, /UNRELATED/);
  assert.match(ctx, /src\/c\.js/, "the rest is listed by name");
});

// Python projects: the checks Apex writes from the task are pytest files, run with the project's Python.
// Needs a Python with pytest: APEX_TEST_PYTHON=/path/to/python (skipped otherwise).
test("python: pytest task checks rank the versions and the passing one wins", { skip: !process.env.APEX_TEST_PYTHON }, async () => {
  const py = String(process.env.APEX_TEST_PYTHON);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "apex-surg-py-"));
  await fs.mkdir(path.join(root, "tests"));
  await fs.writeFile(path.join(root, "calc.py"), "def add(a, b):\n    return a - b\n\ndef mul(a, b):\n    return a * b\n");
  await fs.writeFile(path.join(root, "tests/test_mul.py"), "import sys, os\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))\nfrom calc import mul\n\ndef test_mul():\n    assert mul(2, 3) == 6\n");
  const pyEdit = (body: string) => `=== FILE: calc.py\n<<<<<<< SEARCH\n    return a - b\n=======\n    ${body}\n>>>>>>> REPLACE\n`;
  const gw = fake((req) => {
    if (/You write tests/.test(req.messages[0].content)) {
      assert.match(req.messages[0].content, /```python/);
      assert.match(req.messages[1].content, /pytest/);
      return "```python\nimport sys, os\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))\nfrom calc import add\n\ndef test_add():\n    assert add(2, 3) == 5\n```";
    }
    return req.slot === 2 ? pyEdit("return a + b") : pyEdit("return a * b");
  });
  const r = await surgicalBestOfN({ gateway: gw, model: "m", root, task: "Fix add in calc.py so it adds", n: 3, repairs: 0,
    testCommand: [py, "-m", "pytest", "-q", "--no-header", "-p", "no:cacheprovider"] });
  assert.equal(r.chosen?.index, 1);
  assert.equal(r.chosen?.checksPassed, 1);
  assert.equal(r.chosen?.checksFailed, 0);
  const losers = r.candidates.filter((c) => c.index !== 1 && !c.repaired);
  assert.ok(losers.every((c) => (c.checksFailed ?? 0) > 0), "the wrong versions fail the pytest check");
});

test("python, no tests of its own: the pytest checks alone decide", { skip: !process.env.APEX_TEST_PYTHON }, async () => {
  const py = String(process.env.APEX_TEST_PYTHON);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "apex-surg-py0-"));
  await fs.writeFile(path.join(root, "calc.py"), "def add(a, b):\n    return a - b\n");
  const gw = fake((req) => /You write tests/.test(req.messages[0].content)
    ? "```python\nimport sys, os\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))\nfrom calc import add\n\ndef test_add():\n    assert add(2, 3) == 5\n```"
    : `=== FILE: calc.py\n<<<<<<< SEARCH\n    return a - b\n=======\n    return ${req.slot === 2 ? "a + b" : "a * b"}\n>>>>>>> REPLACE\n`);
  const r = await surgicalBestOfN({ gateway: gw, model: "m", root, task: "Fix add in calc.py so it adds", n: 3, repairs: 0, checksOnly: true,
    testCommand: [py, "-m", "pytest", "-q", "--no-header", "-p", "no:cacheprovider"] });
  assert.equal(r.chosen?.index, 1);
  assert.equal(r.chosen?.failed, 0);
  assert.equal(r.chosen?.checksPassed, 1);
});

test("draftChecks returns clean lines and keeps (assumed) marks", async () => {
  const root = await project();
  // Each line quotes the request; a line quoting nothing ("Here you go:") is dropped and listed as dropped.
  const gw = fake(() => "Here you go:\n- add(2, 3) returns 5 — \"add(2, 3) must return 5\"\n- add(-1, 1) returns 0 — \"add(-1, 1) gives 0\"\n* Negative zero is returned as 0 (assumed) — \"negative numbers\"\n```");
  const d = await draftChecks({ gateway: gw, model: "m", root, task: "Fix add: add(2, 3) must return 5 and add(-1, 1) gives 0, also for negative numbers." });
  assert.deepEqual(d.items, ['add(2, 3) returns 5 — "add(2, 3) must return 5"', 'add(-1, 1) returns 0 — "add(-1, 1) gives 0"', 'Negative zero is returned as 0 (assumed) — "negative numbers"']);
  assert.deepEqual(d.dropped.map((x) => x.text), ["Here you go:"]);
  assert.equal(checkLines("1. one two three four\n2) five six seven eight").length, 2);
});

test("approved requirements drive the checks and are shown to the writer first", async () => {
  const root = await project();
  const gw = fake((req) => {
    if (/You write tests/.test(req.messages[0].content)) {
      assert.match(req.messages[1].content, /The user approved exactly these requirements[\s\S]*1\. add\(2, 3\) returns 5/);
      return "```js\nimport test from \"node:test\";\nimport assert from \"node:assert\";\nimport { add } from \"../src/add.js\";\ntest(\"add(2, 3) returns 5\", () => assert.equal(add(2, 3), 5));\n```";
    }
    assert.match(req.messages[1].content, /<acceptance tests written from the task/, "the writer sees the approved checks");
    return edit("export const add = (a, b) => a + b;");
  });
  const r = await surgicalBestOfN({ gateway: gw, model: "m", root, task: "Fix add", n: 1, repairs: 0, requirements: ["add(2, 3) returns 5"] });
  assert.equal(r.chosen?.checksPassed, 1);
  assert.equal(r.chosen?.checksFailed, 0);
});

test("fix: a test that reproduces the bug is written first, must fail now, and decides the versions", async () => {
  const root = await project(); // add() subtracts: the bug
  const repro = "```js\nimport test from \"node:test\";\nimport assert from \"node:assert\";\nimport { add } from \"../src/add.js\";\ntest(\"add(1, 1) is 2\", () => assert.equal(add(1, 1), 2));\n```";
  const gw = fake((req) => {
    if (/You write tests/.test(req.messages[0].content)) {
      assert.match(req.messages[1].content, /reproduces this bug[\s\S]*FAIL on the code above/);
      return repro;
    }
    // Shown the failing test before writing; slot 2 fixes the cause, slot 1 games only the visible case.
    assert.match(req.messages[1].content, /<acceptance tests written from the task/);
    return req.slot === 2 ? edit("export const add = (a, b) => a + b;") : edit("export const add = (a, b) => (a === 2 && b === 3 ? 5 : a - b);");
  });
  const r = await surgicalBestOfN({ gateway: gw, model: "m", root, task: "Fix: add(1, 1) returns 0", n: 2, repairs: 0, reproFirst: true });
  assert.equal(r.reproduced, true);
  assert.equal(r.chosen?.index, 1);
  assert.equal(r.chosen?.checksFailed, 0);
  assert.ok(r.changes.some((c) => /\.test\.js$/.test(c.path)), "the repro test is kept as a regression test");
});

test("fix: a test that passes on the buggy code does not count as a reproduction", async () => {
  const root = await project();
  const gw = fake((req) => /You write tests/.test(req.messages[0].content)
    ? "```js\nimport test from \"node:test\";\nimport assert from \"node:assert\";\ntest(\"trivial\", () => assert.ok(true));\n```"
    : edit("export const add = (a, b) => a + b;"));
  const r = await surgicalBestOfN({ gateway: gw, model: "m", root, task: "Fix add", n: 1, repairs: 0, reproFirst: true });
  assert.equal(r.reproduced, false);
  assert.equal(r.chosen?.failed, 0);
});

test("an edit whose quoted block rewords a middle line still applies, anchored on its first and last lines", async () => {
  const { applyEdits } = await import("./index.js");
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "apex-anchor-"));
  await fs.writeFile(path.join(d, "a.js"), "export function f(x) {\n  const y = x + 1;\n  const z = y * 2;\n  return z;\n}\nexport const other = 1;\n");
  const search = "export function f(x) {\n  const y = x + 1; // add one\n  const z = y * 2;\n  return z;\n}";
  const r = await applyEdits(d, [{ path: "a.js", search, replace: "export function f(x) {\n  return (x + 1) * 2;\n}" }]);
  assert.deepEqual(r.errors, []);
  assert.equal(await fs.readFile(path.join(d, "a.js"), "utf8"), "export function f(x) {\n  return (x + 1) * 2;\n}\nexport const other = 1;\n");
  const bad = await applyEdits(d, [{ path: "a.js", search: "export const otherr = 2;\nfoo", replace: "x" }]);
  assert.match(bad.errors[0], /SEARCH text not found\. The file has, near there, exactly:\n[\s\S]*export const other = 1;/);
});

test("boundedCall: fires after its limit, follows the caller's signal, and says which one stopped it", async () => {
  const b = boundedCall(undefined, 20);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(b.signal.aborted, true);
  assert.equal(b.timedOut(), true);
  b.done();
  const parent = new AbortController();
  const c = boundedCall(parent.signal, 5000);
  parent.abort();
  assert.equal(c.signal.aborted, true);
  assert.equal(c.timedOut(), false);
  c.done();
});

test("a version call that runs past its time limit is stopped and asked again with little thinking", async () => {
  const root = await project();
  const seen: ModelRequest[] = [];
  const gw = {
    async *stream(req: ModelRequest): AsyncIterable<GatewayEvent> {
      seen.push(req);
      if (req.thinkingBudget === undefined) {
        // Thinks without end until its signal fires, as a provider stream does.
        await new Promise<void>((_, reject) => req.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      yield { type: "text-delta", text: edit("export const add = (a, b) => a + b;") };
      yield { type: "done" };
    },
  };
  const t0 = Date.now();
  const r = await surgicalBestOfN({ gateway: gw, model: "m", root, task: "Fix add in src/add.js", n: 1, repairs: 0, taskChecks: false, callSeconds: 0.2 });
  assert.equal(r.chosen?.failed, 0);
  assert.ok(Date.now() - t0 < 20_000);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].thinkingBudget, 1024);
});

test("requestOnly drops the code-graph callers note, so its file paths are not read as files the request names", () => {
  const task = "Fix `add`.\n\n<code-graph-callers>\nCallers:\n- add() (src/add.js:1) is used by src/main.js:3 run\n</code-graph-callers>";
  assert.equal(requestOnly(task), "Fix `add`.");
});

test("secondLook: the project's tests pass and a minority of checks fail; checks judged wrong end the versions step, never as ready", async () => {
  const root = await project(); // add() subtracts: the bug
  const t = (name: string, expr: string) => `test(${JSON.stringify(name)}, () => assert.equal(${expr}));`;
  const repro = "```js\nimport test from \"node:test\";\nimport assert from \"node:assert\";\nimport { add } from \"../src/add.js\";\n" +
    [t("add(1, 1) is 2", "add(1, 1), 2"), t("add(2, 2) is 4", "add(2, 2), 4"), t("add(0, 5) is 5", "add(0, 5), 5"), t("add(1, 1) is 3", "add(1, 1), 3")].join("\n") + "\n```";
  const run = async (answer: string) => {
    const gw = fake((req) => {
      const sys = String(req.messages[0].content);
      if (/You write tests/.test(sys)) return repro;
      if (/settle a disagreement/.test(sys)) { assert.match(String(req.messages[1].content), /add\(1, 1\) is 3/); assert.match(String(req.messages[1].content), /\+ export const add = \(a, b\) => a \+ b;/); return answer; }
      return edit("export const add = (a, b) => a + b;");
    });
    const r = await surgicalBestOfN({ gateway: gw, model: "m", root: await (async () => { const d = await project(); return d; })(), task: "Fix: add(1, 1) returns 0", n: 3, repairs: 1, adaptive: true, reproFirst: true, secondLook: true, apply: false });
    const edits = gw.seen.filter((q) => /senior engineer/.test(String(q.messages[0].content))).length;
    const looks = gw.seen.filter((q) => /settle a disagreement/.test(String(q.messages[0].content))).length;
    return { r, edits, looks };
  };
  void root;
  const blamed = await run("TEST\nThe request never says add(1, 1) is 3.");
  assert.equal(blamed.r.secondLook?.verdict, "test");
  assert.equal(blamed.looks, 1);
  assert.equal(blamed.edits, 1, "no repair and no further version after the checks were judged wrong");
  assert.equal(blamed.r.chosen?.index, 0);
  assert.equal(blamed.r.chosen?.checksFailed, 1);
  assert.notEqual(blamed.r.verdict?.outcome, "ready");
  // The change judged at fault: repairs and further versions go on as before, and the look is not repeated.
  const kept = await run("CODE\nIt misses a case.");
  assert.equal(kept.r.secondLook?.verdict, "code");
  assert.equal(kept.looks, 1);
  assert.ok(kept.edits > 1, `more calls after "code": ${kept.edits}`);
});

test("alreadyChanged: a file the request names that this turn already changed is not counted as skipped", async () => {
  const root = await project();
  await fs.writeFile(path.join(root, "src/add.js"), "export const add = (a, b) => a + b;\n");
  await fs.writeFile(path.join(root, "src/main.js"), "export const run = () => 1;\n");
  const one = "=== FILE: src/add.js\n<<<<<<< SEARCH\nexport const add = (a, b) => a + b;\n=======\nexport const add = (a, b) => a + b; // json\n>>>>>>> REPLACE\n";
  const r = await surgicalBestOfN({ gateway: fake(() => one), model: "m", root, task: "Add a json option: change src/add.js and wire it in src/main.js", n: 1, repairs: 0, taskChecks: false, apply: false, alreadyChanged: ["src/main.js"] });
  assert.equal(r.candidates[0].skippedNamed, undefined);
});

test("a file name the task writes as part of another path does not name every file called the same", async () => {
  const root = await project();
  await fs.mkdir(path.join(root, "bin"));
  await fs.writeFile(path.join(root, "src/add.js"), "export const add = (a, b) => a + b;\n");
  await fs.writeFile(path.join(root, "bin/add.js"), "export const cli = () => 1;\n");
  await fs.writeFile(path.join(root, "bin/tool.js"), "export const tool = () => 1;\n");
  const one = "=== FILE: src/add.js\n<<<<<<< SEARCH\nexport const add = (a, b) => a + b;\n=======\nexport const add = (a, b) => a + b; // json\n>>>>>>> REPLACE\n";
  const r = await surgicalBestOfN({ gateway: fake(() => one), model: "m", root, task: "Add a json option in src/add.js", n: 1, repairs: 0, taskChecks: false, apply: false });
  assert.equal(r.candidates[0].skippedNamed, undefined, "bin/add.js is not named by src/add.js");
  // A bare file name with no path anywhere still names the files called that.
  const r2 = await surgicalBestOfN({ gateway: fake(() => one), model: "m", root, task: "Add a json option in add.js and tool.js", n: 1, repairs: 0, taskChecks: false, apply: false });
  assert.deepEqual(r2.candidates[0].skippedNamed?.sort(), ["bin/add.js", "bin/tool.js"]);
});
