import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkResults, checksLoadError, missingCheckTests, uncheckedResults } from "./index.js";
import { checksImportHint, expectedLoadError, runTests, validateChecks } from "./index.js";
import { namedExports } from "./index.js";

const REQUEST = "Add an exported function isDone(task) to src/tasks/priority.js that returns true only when task.done is true, with a test in tests/.";
const CHECKS = ["isDone returns true when done is true", "false when done is false", "false when done is missing", "false for a truthy non-true done", "false for null", "is exported"];

/** A temp project shaped like the real run: ESM, src/tasks/priority.js, tests/. withIsDone: the change applied. */
async function project(withIsDone: boolean): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "apex-checkload-"));
  await fs.mkdir(path.join(dir, "src/tasks"), { recursive: true });
  await fs.mkdir(path.join(dir, "tests"), { recursive: true });
  await fs.writeFile(path.join(dir, "package.json"), '{"type":"module"}');
  await fs.writeFile(path.join(dir, "src/tasks/priority.js"), `export function rank(t) { return t.priority ?? 0; }\n${withIsDone ? "export function isDone(task) { return task?.done === true; }\n" : ""}`);
  return dir;
}
async function runFile(dir: string, code: string): Promise<string> {
  await fs.writeFile(path.join(dir, "tests/apex-task-check.test.js"), code);
  return (await runTests(dir, ["node", "--test", "tests/apex-task-check.test.js"])).output;
}
const good = (n = 6) => `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { isDone } from "../src/tasks/priority.js";\n` +
  Array.from({ length: n }, (_, i) => `test("[c${i + 1}] check ${i + 1}", () => { assert.equal(isDone({ done: true }), true); });`).join("\n") + "\n";

test("reproduces the bug: a checks file that fails to load used to become 'check 1 failed, 2-6 no test'", async () => {
  const dir = await project(true);
  try {
    const cases = {
      badPath: good().replace("../src/tasks/priority.js", "../src/priority.js"),
      wrongExport: good().replace("{ isDone }", "{ isDon }"),
      syntax: good().replace('() => { assert', '() => { ( assert'),
    };
    for (const [name, code] of Object.entries(cases)) {
      const out = await runFile(dir, code);
      const err = checksLoadError(out);
      assert.ok(err, `${name}: load error detected`);
      assert.match(err!, /Error/, name);
      // Before: check 1 "test failed", checks 2-6 "No test was written". Now no check carries the file's failure as its own.
      const r = checkResults(CHECKS, out);
      // The checks did not run: unchecked (null), not failed.
      assert.ok(r.every((c) => c.passed === null && /did not load/.test(c.failure!.message)), name);
      assert.ok(!r.some((c) => /No test was written/.test(c.failure!.message)), name);
    }
    // Assertions failing is not a load error.
    const failing = await runFile(dir, good().replace("true);", "false);"));
    assert.equal(checksLoadError(failing), null);
    assert.equal(checkResults(CHECKS, failing)[0].passed, false);
    // Tests without [cN] prefixes load fine but name no check.
    const unnamed = good().replace(/\[c\d+\] /g, "");
    assert.equal(checksLoadError(await runFile(dir, unnamed)), null);
    assert.deepEqual(missingCheckTests(unnamed, 6), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(missingCheckTests(good(4), 6), [5, 6]);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("uncheckedResults: every check passed null with the 'couldn't run' message", () => {
  const r = uncheckedResults(["a (assumed)", "b"], "SyntaxError: Unexpected token ')'");
  assert.deepEqual(r[0], { text: "a", assumed: true, passed: null, failure: { message: "Apex couldn't run its checks for this (the generated test file has an error: SyntaxError: Unexpected token ')')" } });
});

test("validateChecks repairs a file that does not load on the original code, and excuses the export the request adds", async () => {
  const dir = await project(false);
  try {
    const wanted = namedExports(REQUEST);
    assert.deepEqual(wanted.map((w) => [w.name, w.file]), [["isDone", "src/tasks/priority.js"]]);
    const expected = expectedLoadError(wanted, []);
    const io = (answers: string[]) => {
      const asked: string[] = [];
      return { asked, run: (c: string) => runFile(dir, c), ask: async (p: string) => { asked.push(p); return answers.shift() ?? ""; }, count: 6, py: false, expected };
    };
    // A good file on the original code fails to import isDone (not there yet): expected, no repair asked.
    const a = io([]);
    assert.equal((await validateChecks(good(), a)).code, good());
    assert.equal(a.asked.length, 0);
    // A wrong path: repaired on the second answer.
    const b = io([good().replace("../src/tasks/priority.js", "./priority.js"), good()]);
    const vb = await validateChecks(good().replace("../src/tasks/priority.js", "../src/priority.js"), b);
    assert.equal(vb.error, undefined);
    assert.equal(vb.code.trim(), good().trim());
    assert.equal(b.asked.length, 2);
    // Never loads: at most 2 repairs, then the error.
    const c = io(["import x from './nope.js';", "syntax ( error"]);
    const vc = await validateChecks("syntax ( error", c);
    assert.match(vc.error ?? "", /SyntaxError/);
    assert.equal(c.asked.length, 2);
    // Missing [cN]: one regenerate; kept when it covers more.
    const d = io([good()]);
    const vd = await validateChecks(good(4), d);
    assert.deepEqual(missingCheckTests(vd.code, 6), []);
    // Additions that do not help: the original stays (missing checks are then unchecked, "No test was written").
    const e = io([good(3)]);
    const ve = await validateChecks(good(4), e);
    assert.deepEqual(missingCheckTests(ve.code, 6), [5, 6]);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("checksImportHint gives the exact import relative to the tests folder and the [cN] naming", () => {
  const h = checksImportHint(namedExports(REQUEST), "tests/apex-task-check.test.js", false, 6);
  assert.match(h, /import \{ isDone \} from "\.\.\/src\/tasks\/priority\.js";/);
  assert.match(h, /\[c1\] isDone/);
  assert.match(h, /from \[c1\] to \[c6\]/);
  assert.match(checksImportHint(namedExports(REQUEST), "tests/apex-task-check.test.js", false, 0, true), /require\("\.\.\/src\/tasks\/priority\.js"\)/);
});
