import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/tasks/store.js";

test("tasks are kept per user with defaults", () => {
  const s = createStore([{ userId: "a", title: "x", due: "2026-01-01T00:00:00Z" }]);
  const added = s.add({ userId: "b", title: "y", due: "2026-01-01T00:00:00Z" });
  assert.equal(s.forUser("a").length, 1);
  assert.equal(added.done, false);
  assert.equal(added.priority, "medium");
});

test("only the owner can complete a task", () => {
  const s = createStore([{ userId: "a", title: "x", due: "2026-01-01T00:00:00Z" }]);
  assert.equal(s.complete("b", "1"), null);
  assert.equal(s.complete("a", "1").done, true);
});
