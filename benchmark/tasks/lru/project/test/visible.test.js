import { test } from "node:test";
import assert from "node:assert/strict";
import { LRUCache } from "../src/lru.js";
test("evicts oldest", () => {
  const c = new LRUCache(2);
  c.set("a", 1); c.set("b", 2); c.set("c", 3);
  assert.equal(c.get("a"), undefined);
  assert.equal(c.get("c"), 3);
});
