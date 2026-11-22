import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ModelEvent as GatewayEvent, ModelRequest } from "./model.js";
import { surgicalBestOfN } from "./index.js";
import { detectTestRunner, readTestOutput } from "./index.js";

const hasPytest = (() => { try { execFileSync("python3", ["-m", "pytest", "--version"], { stdio: "pipe" }); return true; } catch { return false; } })();

test("results are read from node:test, jest, vitest, mocha and pytest output", () => {
  assert.deepEqual(readTestOutput("ok 1 - a\nnot ok 2 - b\nok 3 - c\n", true), { passed: 2, failed: 1, failedNames: ["b"] });
  const jest = "FAIL src/cart.test.js\n  ● cart › adds tax\n\n    expect(received).toBe(expected)\n\nTests:       1 failed, 5 passed, 6 total\n";
  assert.deepEqual(readTestOutput(jest, true), { passed: 5, failed: 1, failedNames: ["cart › adds tax", "src/cart.test.js"] });
  const vitest = " ✓ src/a.test.ts (3)\n × src/b.test.ts > totals > rounds 12ms\n\n Test Files  1 failed | 1 passed (2)\n      Tests  1 failed | 5 passed (6)\n";
  const v = readTestOutput(vitest, true);
  assert.equal(v.passed, 5); assert.equal(v.failed, 1); assert.ok(v.failedNames.some((n) => /rounds/.test(n)));
  assert.deepEqual(readTestOutput("  5 passing (12ms)\n  2 failing\n", true), { passed: 5, failed: 2, failedNames: [] });
  const py = "..F.\nFAILED tests/test_cart.py::test_tax - assert 1 == 2\n1 failed, 3 passed in 0.04s\n";
  assert.deepEqual(readTestOutput(py, true), { passed: 3, failed: 1, failedNames: ["tests/test_cart.py::test_tax"] });
  assert.deepEqual(readTestOutput("4 passed in 0.02s\n", false), { passed: 4, failed: 0, failedNames: [] });
  // A run that crashed or timed out without naming a failure still fails.
  assert.equal(readTestOutput("Segmentation fault", true).failed, 1);
  assert.equal(readTestOutput("ok 1 - a\n", true).failed, 1);
});

test("the project's own test command is found: npm test with dependencies, node:test, pytest, or none", async () => {
  const mk = async (files: Record<string, string>) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "apex-runner-"));
    for (const [f, body] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(dir, f)), { recursive: true }); await fs.writeFile(path.join(dir, f), body); }
    return dir;
  };
  const jest = await mk({ "package.json": '{"scripts":{"test":"jest"}}', "node_modules/.keep": "", "src/a.test.ts": "" });
  assert.deepEqual((await detectTestRunner(jest))?.command, ["npm", "test", "--silent"]);
  const noDeps = await mk({ "package.json": '{"scripts":{"test":"vitest run"}}', "src/a.test.ts": "" });
  assert.equal(await detectTestRunner(noDeps), null, "dependencies not installed: the tests cannot run");
  const node = await mk({ "package.json": '{"scripts":{"test":"node --test"}}', "tests/a.test.js": 'import test from "node:test";' });
  assert.equal((await detectTestRunner(node))?.kind, "node");
  const py = await mk({ "cart.py": "", "tests/test_cart.py": "" });
  assert.equal((await detectTestRunner(py))?.kind, hasPytest ? "pytest" : undefined, "pytest only when it is installed");
  assert.equal(await detectTestRunner(await mk({ "README.md": "hi" })), null);
});


test("a Python project's change is picked by pytest", { skip: !hasPytest }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "apex-py-"));
  await fs.mkdir(path.join(dir, "tests"));
  await fs.writeFile(path.join(dir, "cart.py"), "def total(items):\n    return sum(items)\n");
  await fs.writeFile(path.join(dir, "tests/test_cart.py"), "import sys, os\nsys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))\nfrom cart import total\n\ndef test_total():\n    assert total([1, 2]) == 3\n");
  const edit = (body: string) => `=== FILE: cart.py\n<<<<<<< SEARCH\ndef total(items):\n    return sum(items)\n=======\n${body}\n>>>>>>> REPLACE\n`;
  const good = edit("def total(items, tax=0):\n    return sum(items) * (1 + tax)");
  const bad = edit("def total(items, tax=0):\n    return sum(items) + tax + 1");
  const gw = { async *stream(req: ModelRequest): AsyncIterable<GatewayEvent> { yield { type: "text-delta", text: req.slot === 2 ? good : bad }; yield { type: "done" }; } };
  const runner = await detectTestRunner(dir);
  assert.equal(runner?.kind, "pytest");
  const r = await surgicalBestOfN({ gateway: gw, model: "m", root: dir, task: "Add an optional tax rate to total in cart.py", n: 2, repairs: 0, testCommand: runner!.command, testTimeoutSec: runner!.timeoutSec });
  assert.equal(r.chosen?.index, 1);
  assert.equal(r.chosen?.failed, 0);
  assert.match(await fs.readFile(path.join(dir, "cart.py"), "utf8"), /1 \+ tax\)/);
  assert.equal(r.modelCalls, 2, "no node:test checks are written for a Python project");
});

test("a project tested through npm test (any runner) gets its versions judged by that command", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "apex-npm-"));
  await fs.mkdir(path.join(dir, "node_modules"));
  await fs.mkdir(path.join(dir, "src"));
  // A stand-in runner that prints the way mocha does and exits non-zero on failure.
  await fs.writeFile(path.join(dir, "run-tests.cjs"), 'const { add } = require("./src/add.cjs");\nconst ok = add(2, 3) === 5;\nconsole.log(ok ? "  1 passing (2ms)" : "  0 passing (2ms)\\n  1 failing");\nprocess.exit(ok ? 0 : 1);\n');
  await fs.writeFile(path.join(dir, "package.json"), '{"scripts":{"test":"node run-tests.cjs"}}');
  await fs.writeFile(path.join(dir, "src/add.cjs"), "exports.add = (a, b) => a - b;\n");
  const edit = (body: string) => `=== FILE: src/add.cjs\n<<<<<<< SEARCH\nexports.add = (a, b) => a - b;\n=======\n${body}\n>>>>>>> REPLACE\n`;
  const gw = { async *stream(req: ModelRequest): AsyncIterable<GatewayEvent> { yield { type: "text-delta", text: req.slot === 2 ? edit("exports.add = (a, b) => a + b;") : edit("exports.add = (a, b) => a * b;") }; yield { type: "done" }; } };
  const runner = await detectTestRunner(dir);
  assert.equal(runner?.kind, "npm");
  const r = await surgicalBestOfN({ gateway: gw, model: "m", root: dir, task: "Fix add in src/add.cjs", n: 2, repairs: 0, testCommand: runner!.command, testTimeoutSec: runner!.timeoutSec });
  assert.equal(r.chosen?.index, 1, JSON.stringify(r.candidates));
  assert.equal(r.chosen?.failed, 0);
  assert.equal(r.candidates[0].failed, 1, JSON.stringify(r.candidates.map((c: any) => ({ f: c.failed, p: c.passed, o: String(c.output ?? c.testOutput ?? "").slice(0, 400) }))));
});

test("node:test spec reporter (Node 22 default when not TAP) is counted, not read as 0/0", () => {
  const spec = "✔ supports Pashto (0.02ms)\n✔ counter (0.19ms)\n✖ trailing dash (0.06ms)\nℹ tests 3\nℹ suites 0\nℹ pass 2\nℹ fail 1\n";
  const r = readTestOutput(spec, true);
  assert.equal(r.passed, 2);
  assert.equal(r.failed, 1);
  assert.deepEqual(r.failedNames, ["trailing dash"]);
  const cut = "✔ a (1ms)\n✔ b (1ms)\n✔ c (1ms)\n";
  assert.deepEqual([readTestOutput(cut, false).passed, readTestOutput(cut, false).failed], [3, 0]);
  const tap = "TAP version 13\nok 1 - main\n1..84\n# tests 84\n# pass 84\n# fail 0\n";
  assert.equal(readTestOutput(tap, false).passed, 84);
});

test("go test -v output: counted, and a failure becomes TAP with got and want", async () => {
  const { readTestOutput, goToTap } = await import("./test-runner.js");
  const out = "=== RUN   TestSpaces\n    apex_task_check_test.go:9: got hello_world, want hello-world\n--- FAIL: TestSpaces (0.00s)\n=== RUN   TestLower\n--- PASS: TestLower (0.00s)\nFAIL\nFAIL\tdemo\t0.004s\n";
  assert.deepEqual({ ...readTestOutput(out, true), failedNames: undefined }, { passed: 1, failed: 1, failedNames: undefined });
  const tap = goToTap(out);
  assert.match(tap, /not ok 1 - TestSpaces/);
  assert.match(tap, /actual: hello_world/);
  assert.match(tap, /expected: hello-world/);
  assert.match(tap, /ok 2 - TestLower/);
});

test("go: the check file goes beside the code, in its package", async () => {
  const { goPackageOf } = await import("./test-runner.js");
  assert.deepEqual(goPackageOf(["main.go", "util/a.go", "util/b.go", "go.mod"], () => "package main\n"), { dir: "", pkg: "main" });
  assert.deepEqual(goPackageOf(["util/a.go", "util/b.go", "util/b_test.go", "other/c.go"], () => "package util\n"), { dir: "util", pkg: "util" });
});
