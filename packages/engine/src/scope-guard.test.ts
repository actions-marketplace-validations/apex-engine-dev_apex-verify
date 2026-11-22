import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ModelEvent as GatewayEvent, ModelRequest } from "./model.js";
import { outOfScope, requestScope, securityFlags } from "./index.js";
import { checkResults } from "./index.js";
import { checkLines, dedupeChecks, examplesBlock, surgicalBestOfN, testExamples } from "./index.js";

const MAIN_BEFORE = `  } catch (err) {\n    send(res, { status: err.status || 500, body: { error: err.status ? err.message : "Something went wrong." } });\n  }\n`;
const MAIN_LEAK = `  } catch (err) {\n    send(res, { status: 500, body: { error: err.message } });\n  }\n`;

test("securityFlags: an internal error message sent in a 500 response is flagged (qa/04e)", () => {
  const f = securityFlags("src/main.js", MAIN_BEFORE, MAIN_LEAK);
  assert.equal(f.length, 1);
  assert.match(f[0], /src\/main\.js: an internal error message/);
});

test("securityFlags: the real expiry fix (ms vs seconds) is not flagged; a removed or always-true check is", () => {
  const before = "function isExpired(session, now) {\n  return session.expiresAt <= Math.floor(now / 1000);\n}\n";
  assert.deepEqual(securityFlags("src/auth/session.js", before, before.replace("Math.floor(now / 1000)", "now")), []);
  assert.match(securityFlags("src/auth/session.js", "  if (isExpired(s, now)) return null;\n  return s;\n", "  return s;\n")[0], /auth or expiry check was removed/);
  assert.match(securityFlags("src/auth/session.js", "  if (!verifySession(t)) return 401;\n", "  if (!verifySession(t) && false || true) return 401;\n".replace("&& false || true", "|| true"))[0] ?? "", /loosened|removed/);
  assert.match(securityFlags("src/auth.js", "", "  console.log('login', user, password);\n")[0], /written to a log/);
  assert.deepEqual(securityFlags("tests/a.test.js", "", "res.json({ error: err.message })\n"), [], "tests are not checked");
});

test("outOfScope: files outside named + targets + tests; an empty scope knows nothing", () => {
  const scope = requestScope({ named: ["src/tasks/store.js"], targets: ["src/seed.js"] });
  assert.deepEqual(outOfScope(["src/tasks/store.js", "src/main.js", "tests/store.test.js", "src/seed.js"], scope), ["src/main.js"]);
  assert.deepEqual(outOfScope(["src/main.js"], new Set()), []);
});

test("checkResults appends the implicit check, failed with its reason", () => {
  const out = "ok 1 - [c1] ids are unique\nnot ok 9001 - [implicit] No unrelated or security-weakening changes\n  ---\n  error: |-\n    src/main.js: an internal error message is sent in a response\n  ...\n";
  const r = checkResults(["ids are unique"], out);
  assert.equal(r.length, 2);
  assert.equal(r[0].passed, true);
  assert.deepEqual([r[1].text, r[1].passed], ["No unrelated or security-weakening changes", false]);
  assert.match(r[1].failure!.message, /internal error message/);
});

test("checkResults: 'What failed' carries the nested, further-indented error (qa/05c)", () => {
  const out = [
    "# Subtest: [c2] GET /api/today returns today's tasks",
    "    not ok 1 - returns tasks",
    "      ---",
    "      failureType: 'testCodeFailure'",
    "      error: |-",
    "        Expected values to be strictly equal:",
    "        ",
    "        401 !== 200",
    "      code: 'ERR_ASSERTION'",
    "      ...",
    "not ok 2 - [c2] GET /api/today returns today's tasks",
    "  ---",
    "  failureType: 'subtestsFailed'",
    "  error: '1 subtest failed'",
    "  ...",
    "ok 1 - [c1] signed-out gets 401",
  ].join("\n");
  const r = checkResults(["signed-out gets 401", "GET /api/today returns today's tasks"], out);
  assert.equal(r[1].passed, false);
  assert.match(r[1].failure!.message, /401 !== 200/);
  // A YAML block indented more than two past its test line is still read.
  const deep = "not ok 1 - [c1] x\n      ---\n      error: 'Cannot read properties of null'\n      ...\n";
  assert.match(checkResults(["x"], deep)[0].failure!.message, /Cannot read properties of null/);
  const stackOnly = "not ok 1 - [c1] x\n  ---\n  stack: |-\n    TypeError: boom\n        at f (a.js:1:1)\n  ...\n";
  assert.match(checkResults(["x"], stackOnly)[0].failure!.message, /TypeError: boom/);
});

test("dedupeChecks removes repeated checks, ignoring case, punctuation and (assumed) (qa/05)", () => {
  const lines = ["The task ID is not reused for different tasks (assumed)", "the task id is not reused for different tasks.", "GET /api/today returns 401 without a sign-in", "The task ID is not reused for different tasks (assumed)"];
  assert.deepEqual(dedupeChecks(lines), ["The task ID is not reused for different tasks (assumed)", "GET /api/today returns 401 without a sign-in"]);
  assert.equal(checkLines(lines.map((l) => `- ${l}`).join("\n")).length, 2);
  assert.equal(dedupeChecks(["GET /api/today returns 401 without a sign-in", "GET /api/today returns 200 with a sign-in"]).length, 2);
});

test("testExamples: for a route request, the router test with a sign-in comes first; two are included", async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "apex-ex-"));
  await fs.mkdir(path.join(d, "tests"));
  await fs.writeFile(path.join(d, "tests/time.test.js"), "test('isSameDay', () => {});\n");
  await fs.writeFile(path.join(d, "tests/server.test.js"), "const route = createRouter(createStore());\nconst signIn = await route('POST', '/api/sessions', {}, { userId: 'dana' });\nassert.equal(r.status, 401);\nconst headers = { authorization: `Bearer ${signIn.body.token}` };\n");
  const ex = await testExamples(d, ["tests/time.test.js", "tests/server.test.js"], "GET /api/today returns today's tasks; 401 without sign-in", false);
  assert.deepEqual(ex.map((e) => e.path), ["tests/server.test.js", "tests/time.test.js"]);
  assert.match(examplesBlock(ex, false), /these existing tests[\s\S]*tests\/server\.test\.js[\s\S]*tests\/time\.test\.js/);
});

async function project(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "apex-scope-"));
  await fs.mkdir(path.join(dir, "src")); await fs.mkdir(path.join(dir, "tests"));
  await fs.writeFile(path.join(dir, "package.json"), '{"type":"module"}');
  await fs.writeFile(path.join(dir, "src/add.js"), "export const add = (a, b) => a - b;\n");
  await fs.writeFile(path.join(dir, "src/main.js"), `export function handle(send, res, err) {\n  try {\n    return 1;\n${MAIN_BEFORE}}\n`);
  await fs.writeFile(path.join(dir, "tests/add.test.js"), 'import test from "node:test";\nimport assert from "node:assert";\nimport { add } from "../src/add.js";\ntest("adds", () => assert.equal(add(2, 3), 5));\n');
  return dir;
}
const both = "=== FILE: src/add.js\n<<<<<<< SEARCH\nexport const add = (a, b) => a - b;\n=======\nexport const add = (a, b) => a + b;\n>>>>>>> REPLACE\n=== FILE: src/main.js\n<<<<<<< SEARCH\n" + MAIN_BEFORE.trimEnd() + "\n=======\n" + MAIN_LEAK.trimEnd() + "\n>>>>>>> REPLACE\n";
const gw = () => ({ async *stream(_req: ModelRequest): AsyncIterable<GatewayEvent> { yield { type: "text-delta", text: both }; yield { type: "done" }; } });

test("scope guard: an unrequested edit to src/main.js is dropped from the chosen version (qa/04c)", async () => {
  const root = await project();
  const r = await surgicalBestOfN({ gateway: gw(), model: "m", root, task: "Fix add in src/add.js", n: 1, repairs: 0, scopeTargets: [] });
  assert.deepEqual(r.droppedOutOfScope, ["src/main.js"]);
  assert.deepEqual(r.changes.map((c) => c.path), ["src/add.js"]);
  assert.match(await fs.readFile(path.join(root, "src/main.js"), "utf8"), /Something went wrong/);
  assert.equal(r.securityFlags, undefined);
});

test("security flag: a requested file that now leaks err.message fails the implicit check", async () => {
  const root = await project();
  const r = await surgicalBestOfN({ gateway: gw(), model: "m", root, task: "Fix add in src/add.js and tidy src/main.js", n: 1, repairs: 0, scopeTargets: [], apply: false });
  assert.equal(r.droppedOutOfScope, undefined);
  assert.equal(r.securityFlags?.length, 1);
  assert.ok((r.chosen?.checksFailed ?? 0) >= 1);
  const implicit = checkResults([], r.chosen!.checksRun ?? "");
  assert.deepEqual(implicit.map((c) => [c.text, c.passed]), [["No unrelated or security-weakening changes", false]]);
});

test("draftChecks asks for one line per stated rule and returns no repeats; the checks prompt carries the input rules", async () => {
  const root = await project();
  const seen: ModelRequest[] = [];
  const g = { async *stream(req: ModelRequest): AsyncIterable<GatewayEvent> {
    seen.push(req);
    yield { type: "text-delta", text: /You write tests/.test(req.messages[0].content) ? "```js\nimport test from 'node:test';\ntest('[c1] x', () => {});\n```" : /acceptance criteria/.test(req.messages[0].content) ? "- The task ID is not reused (assumed)\n- The task ID is not reused (assumed)\n- GET /api/today returns 401 without a sign-in" : both };
    yield { type: "done" };
  } };
  const { draftChecks } = await import("./index.js");
  const d = await draftChecks({ gateway: g, model: "m", root, task: "Add GET /api/today; 401 without sign-in" });
  assert.equal(d.items.length, 2);
  assert.match(seen[0].messages[1].content, /one line per rule the task states/);
  await surgicalBestOfN({ gateway: g, model: "m", root, task: "Add GET /api/today in src/add.js", n: 1, repairs: 0, scopeTargets: [], apply: false, requirements: ["GET /api/today returns 401 without a sign-in"] });
  const ask = seen.find((q) => /You write tests/.test(q.messages[0].content));
  assert.match(ask!.messages[1].content, /a real session or token from the project's own sign-in or auth helper/);
  assert.match(ask!.messages[1].content, /tests\/add\.test\.js/);
});
