import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelClient } from "apex-verify-engine";
import { outdatedTests } from "./outdated.js";

const TASK = "Leading-dot domains such as '.example.com' should be accepted, while malformed domains must still be rejected.";
const answer = (j: unknown): ModelClient => ({ async *stream() { yield { type: "text-delta", text: "```json\n" + JSON.stringify(j) + "\n```" }; yield { type: "done" }; } });
const project = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "apex-outdated-"));
  fs.mkdirSync(path.join(d, "test"));
  fs.writeFileSync(path.join(d, "test", "domain.test.js"), "test('should throw for invalid domain', () => assert.throws(() => serialize('a', 'b', { domain: '.example.com' })));\n");
  return d;
};
const base = (client: ModelClient) => ({ client, model: "m", task: TASK, origDir: project(), failingNames: ["should throw for invalid domain"], failureOutput: "Missing expected exception: .example.com" });

test("a failing test is out of date only with a quote that really is in the task", async () => {
  const ok = await outdatedTests(base(answer({ outdated: true, quote: "Leading-dot domains such as '.example.com' should be accepted", why: "the test asserts the old rejection" })));
  assert.equal(ok?.outdated, true);
  const invented = await outdatedTests(base(answer({ outdated: true, quote: "The old domain tests can be ignored", why: "x" })));
  assert.equal(invented?.outdated, false, "a sentence that is not in the task does not excuse the failure");
  const short = await outdatedTests(base(answer({ outdated: true, quote: "accepted", why: "x" })));
  assert.equal(short?.outdated, false);
  const no = await outdatedTests(base(answer({ outdated: false, quote: "", why: "the task does not mention it" })));
  assert.equal(no?.outdated, false);
});

test("the second look gets the failing test's source and a model error leaves the regression", async () => {
  let prompt = "";
  const spy: ModelClient = { async *stream(req) { prompt = req.messages.map((m) => m.content).join("\n"); yield { type: "text-delta", text: '{"outdated": false, "quote": "", "why": ""}' }; } };
  await outdatedTests(base(spy));
  assert.match(prompt, /test\/domain\.test\.js/);
  assert.match(prompt, /should throw for invalid domain/);
  const err: ModelClient = { async *stream() { yield { type: "error", message: "quota" }; } };
  assert.equal(await outdatedTests(base(err)), null);
});
