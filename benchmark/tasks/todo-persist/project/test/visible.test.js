import { test } from "node:test";
import assert from "node:assert/strict";
import { TodoList } from "../src/todos.js";
test("roundtrip", () => {
  const l = new TodoList(); l.add("a"); l.add("b"); l.complete(1);
  const r = TodoList.fromJSON(l.toJSON());
  assert.equal(r.pending().length, 1);
});
