import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { selfExcludingChecks } from "./index.js";
import { runTests } from "./index.js";

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

