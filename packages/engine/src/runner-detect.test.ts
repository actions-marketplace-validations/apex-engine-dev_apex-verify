import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { detectTestRunner } from "./test-runner.js";

const hasPytest = spawnSync("python3", ["-m", "pytest", "--version"], { stdio: "ignore" }).status === 0;

test("a lone test.py at the root is found and named (pytest would not collect it by default)", { skip: !hasPytest && "pytest is not installed" }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "apex-rd-"));
  await fs.writeFile(path.join(dir, "m.py"), "def f():\n    return 1\n");
  await fs.writeFile(path.join(dir, "test.py"), "from m import f\n\ndef test_f():\n    assert f() == 1\n");
  const r = await detectTestRunner(dir);
  assert.equal(r?.kind, "pytest");
  assert.equal(r?.command.at(-1), "test.py");
});

test("a mocha project with its dependencies installed runs through npm test", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "apex-rd-"));
  await fs.mkdir(path.join(dir, "node_modules"));
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "mocha tests.js" } }));
  const r = await detectTestRunner(dir);
  assert.deepEqual(r?.command, ["npm", "test", "--silent"]);
});
