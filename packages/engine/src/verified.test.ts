import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelClient, ModelRequest } from "./model.js";
import { fsWorkspace, outcomeStatus, registerTaskPack, taskPackProvider, verifiedOutcome, type SurgicalResult, type Workspace } from "./index.js";

async function project(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "apex-verified-"));
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.mkdir(path.join(dir, "tests"), { recursive: true });
  await fs.writeFile(path.join(dir, "package.json"), '{"name":"p","type":"module","scripts":{"test":"node --test"}}');
  await fs.writeFile(path.join(dir, "src/add.js"), "export const add = (a, b) => a - b;\n");
  await fs.writeFile(path.join(dir, "tests/add.test.js"), 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/add.js";\ntest("add", () => assert.equal(add(2, 3), 5));\n');
  return dir;
}
const edit = (to: string) => `=== FILE: src/add.js\n<<<<<<< SEARCH\nexport const add = (a, b) => a - b;\n=======\n${to}\n>>>>>>> REPLACE\n`;
const model = (answer: string, seen: ModelRequest[] = []): ModelClient => ({ async *stream(req) { seen.push(req); yield { type: "text-delta", text: answer }; yield { type: "done" }; } });

test("verifiedOutcome: a change that passes the project's tests is ready, returned and not written", async () => {
  const dir = await project();
  const seen: ModelRequest[] = [];
  const out = await verifiedOutcome({ model: model(edit("export const add = (a, b) => a + b;"), seen), workspace: dir, task: "Fix add in src/add.js", n: 1, repairs: 0, taskChecks: false, testTimeoutSec: 60 });
  assert.equal(out.status, "ready");
  assert.equal(out.edits.length, 1);
  assert.equal(out.edits[0].path, "src/add.js");
  assert.equal(out.changes[0].after.includes("a + b"), true);
  assert.equal(out.evidence.testsFailed, 0);
  assert.ok(out.evidence.testsPassed >= 1);
  assert.equal(await fs.readFile(path.join(dir, "src/add.js"), "utf8"), "export const add = (a, b) => a - b;\n", "apply defaults to false");
  assert.ok(seen.every((r) => r.tools.length === 0 && r.messages[0].role === "system"));
});

test("verifiedOutcome: apply true writes the change through the workspace", async () => {
  const dir = await project();
  const writes: string[] = [];
  const base = fsWorkspace(dir);
  const files: Workspace = { ...base, write: async (rel, c) => { writes.push(rel); await base.write(rel, c); } };
  const out = await verifiedOutcome({ model: model(edit("export const add = (a, b) => a + b;")), workspace: { root: dir, files }, task: "Fix add in src/add.js", n: 1, repairs: 0, taskChecks: false, apply: true, testTimeoutSec: 60 });
  assert.equal(out.status, "ready");
  assert.deepEqual(writes, ["src/add.js"]);
  assert.match(await fs.readFile(path.join(dir, "src/add.js"), "utf8"), /a \+ b/);
});

test("verifiedOutcome: a change that leaves the tests failing is failed; no edits is an answer", async () => {
  const dir = await project();
  const bad = await verifiedOutcome({ model: model(edit("export const add = (a, b) => a * b;")), workspace: dir, task: "Fix add in src/add.js", n: 1, repairs: 0, taskChecks: false, testTimeoutSec: 60 });
  assert.equal(bad.status, "failed");
  const none = await verifiedOutcome({ model: { async *stream() { yield { type: "text-delta", text: "add subtracts; that is a bug, but I changed nothing." }; yield { type: "done" }; } }, workspace: dir, task: "What does add do in src/add.js?", n: 1, repairs: 0, taskChecks: false, testTimeoutSec: 60 });
  assert.equal(none.status, "answer");
  assert.deepEqual(none.edits, []);
});

test("outcomeStatus: the rules the loop applies (verdict, checks policy, second look)", () => {
  const chosen = { index: 0, edits: [{ path: "a.js", replace: "x" }], applyErrors: [], passed: 3, failed: 0, testOutput: "", repaired: false };
  const base: SurgicalResult = { chosen, candidates: [chosen], changes: [{ path: "a.js", before: "", after: "x" }], modelCalls: 1, inputTokens: 0, outputTokens: 0, contextChars: 0, ms: 0 };
  assert.equal(outcomeStatus({ ...base, verdict: { outcome: "ready" } }).status, "ready");
  assert.equal(outcomeStatus({ ...base, verdict: { outcome: "not_ready", reason: "1 check fails" } }).status, "not_ready");
  assert.equal(outcomeStatus({ ...base, verdict: { outcome: "not_ready", reason: "1 check fails" } }, "warn").status, "unverified");
  assert.equal(outcomeStatus({ ...base, verdict: { outcome: "unverified", reason: "pending" } }).status, "unverified");
  assert.equal(outcomeStatus({ ...base, verdict: { outcome: "not_ready" }, secondLook: { verdict: "test", reason: "asks for more" } }).status, "unverified");
  assert.equal(outcomeStatus({ ...base, verdict: undefined }).status, "failed");
  assert.equal(outcomeStatus({ ...base, chosen: null, candidates: [{ ...chosen, edits: [] }], changes: [] }).status, "answer");
  assert.equal(outcomeStatus({ ...base, chosen: null, changes: [], gaveUp: "unusable" }).status, "failed");
});

test("task pack: none by default, a registered or explicit provider otherwise", async () => {
  registerTaskPack(undefined);
  assert.deepEqual(await taskPackProvider()("/x", "t", () => false, 100), { text: "", packFiles: [] });
  const mine = async () => ({ text: "pack", packFiles: ["a.js"] });
  assert.equal((await taskPackProvider(mine)("/x", "t", () => false, 100)).text, "pack");
  registerTaskPack(mine);
  assert.equal((await taskPackProvider()("/x", "t", () => false, 100)).packFiles[0], "a.js");
  registerTaskPack(undefined);
});
