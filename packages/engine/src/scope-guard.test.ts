import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { examplesBlock, testExamples } from "./index.js";

test("testExamples: for a route request, the router test with a sign-in comes first; two are included", async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "apex-ex-"));
  await fs.mkdir(path.join(d, "tests"));
  await fs.writeFile(path.join(d, "tests/time.test.js"), "test('isSameDay', () => {});\n");
  await fs.writeFile(path.join(d, "tests/server.test.js"), "const route = createRouter(createStore());\nconst signIn = await route('POST', '/api/sessions', {}, { userId: 'dana' });\nassert.equal(r.status, 401);\nconst headers = { authorization: `Bearer ${signIn.body.token}` };\n");
  const ex = await testExamples(d, ["tests/time.test.js", "tests/server.test.js"], "GET /api/today returns today's tasks; 401 without sign-in", false);
  assert.deepEqual(ex.map((e) => e.path), ["tests/server.test.js", "tests/time.test.js"]);
  assert.match(examplesBlock(ex, false), /these existing tests[\s\S]*tests\/server\.test\.js[\s\S]*tests\/time\.test\.js/);
});

