import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/server.js";
import { createStore } from "../src/tasks/store.js";

test("tasks need a sign-in", async () => {
  const route = createRouter(createStore());
  assert.equal((await route("GET", "/api/tasks", {})).status, 401);
  assert.equal((await route("GET", "/api/nothing", {})).status, 404);
});

test("sign in, add a task, list it, complete it", async () => {
  const route = createRouter(createStore());
  const signIn = await route("POST", "/api/sessions", {}, { userId: "dana", timeZone: "Asia/Jerusalem" });
  assert.equal(signIn.status, 201);
  const headers = { authorization: `Bearer ${signIn.body.token}` };
  const added = await route("POST", "/api/tasks", headers, { title: "Write tests", due: "2026-11-12T09:00:00Z", priority: "high" });
  assert.equal(added.status, 201);
  assert.equal((await route("GET", "/api/tasks", headers)).body.length, 1);
  assert.equal((await route("POST", `/api/tasks/${added.body.id}/done`, headers)).body.done, true);
  assert.equal((await route("POST", "/api/tasks", headers, { title: "x", due: "soon" })).status, 400);
});
