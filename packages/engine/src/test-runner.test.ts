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

test("go test -v output: counted, and failing subtests become TAP with got and want", async () => {
  const { readTestOutput, goToTap } = await import("./test-runner.js");
  const out = [
    "=== RUN   TestSlug", "=== RUN   TestSlug/spaces", '    c_test.go:52: Slugify("A B") = "a_b", want "a-b"', "=== RUN   TestSlug/empty",
    "--- FAIL: TestSlug (0.00s)", "    --- FAIL: TestSlug/spaces (0.00s)", "    --- PASS: TestSlug/empty (0.00s)",
    "=== RUN   TestLower", "--- PASS: TestLower (0.00s)", "FAIL", "FAIL\texample.com/demo\t0.35s", ""].join("\n");
  const r = readTestOutput(out, true);
  assert.equal(r.passed, 1); assert.equal(r.failed, 1);
  const tap = goToTap(out);
  assert.match(tap, /not ok 1 - TestSlug\/spaces/);
  assert.doesNotMatch(tap, /not ok \d+ - TestSlug\n/, "the parent is left out");
  assert.match(tap, /actual: "a_b"/);
  assert.match(tap, /expected: "a-b"/);
  assert.match(tap, /ok 3 - TestLower/);
});

test("go: the check file goes beside the code, in its package", async () => {
  const { goPackageOf } = await import("./test-runner.js");
  assert.deepEqual(goPackageOf(["main.go", "util/a.go", "util/b.go", "go.mod"], () => "package main\n"), { dir: "", pkg: "main" });
  assert.deepEqual(goPackageOf(["util/a.go", "util/b.go", "util/b_test.go", "other/c.go"], () => "package util\n"), { dir: "util", pkg: "util" });
});

test("test runs never see API keys or tokens from the environment (every platform, Windows included)", async () => {
  const { runTests } = await import("./surgical.js");
  process.env.APEX_SECRET_PROBE_TOKEN = "s3cret"; process.env.APEX_SECRET_PROBE_KEY = "s3cret";
  try {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "apex-env-"));
    await fs.writeFile(path.join(dir, "probe.cjs"), 'const leaked = Object.keys(process.env).filter((k) => k.startsWith("APEX_SECRET_PROBE"));\nconsole.log(leaked.length ? "LEAKED " + leaked : "# pass 1\\n# fail 0");\nprocess.exit(leaked.length ? 1 : 0);\n');
    const r = await runTests(dir, ["node", "probe.cjs"], undefined, 30, { sandbox: false });
    assert.equal(r.exitCode, 0, r.output);
    assert.doesNotMatch(r.output, /LEAKED/);
  } finally { delete process.env.APEX_SECRET_PROBE_TOKEN; delete process.env.APEX_SECRET_PROBE_KEY; }
});

test("output made of blank lines does not stall the parsers (no quadratic regex)", async () => {
  const { readTestOutput, goToTap, jestToTap, cargoToTap } = await import("./test-runner.js");
  const big = "\n".repeat(80_000);
  const t0 = Date.now();
  readTestOutput(big, false); goToTap(big); jestToTap(big); cargoToTap(big);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});

test("TAP skip/todo are not counted, a pytest id with a space is one test, goToTap follows === CONT", async () => {
  const { readTestOutput, goToTap } = await import("./test-runner.js");
  const { parseTestOutcomes } = await import("./check-results.js");
  const r = readTestOutput("ok 1 - a # SKIP later\nok 2 - b\nnot ok 3 - c # TODO not yet\n", false);
  assert.equal(r.passed, 1); assert.equal(r.failed, 0);
  const py = parseTestOutcomes("FAILED t.py::test_c1_x[hello world] - assert 1 == 2\nPASSED t.py::test_c1_x[abc]\n");
  assert.equal(py.length, 2); assert.equal(py[0]!.ok, false); assert.equal(py[0]!.name, "t.py::test_c1_x[hello world]");
  const out = ["=== RUN   TestA", "=== PAUSE TestA", "=== RUN   TestB", "=== CONT  TestA", "    a_test.go:5: got 1, want 2", "=== CONT  TestB", "--- FAIL: TestA (0.00s)", "--- PASS: TestB (0.00s)", "FAIL", ""].join("\n");
  const tap = goToTap(out);
  assert.match(tap, /not ok 1 - TestA[\s\S]*actual: 1/);
});

test("a Python check file with a docstring before `from __future__` keeps the future import first", async () => {
  const { selfExcludingChecks } = await import("./check-screen.js");
  const code = '"""doc"""\nfrom __future__ import annotations\nimport os\n\ndef test_a():\n    assert True\n';
  const out = selfExcludingChecks(code, true);
  const futureAt = out.indexOf("from __future__"), preludeAt = out.indexOf("__apex_os");
  assert.ok(futureAt >= 0 && preludeAt > futureAt, "the prelude comes after the future import");
});
