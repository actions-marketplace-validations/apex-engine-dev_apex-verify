import { test } from "node:test";
import assert from "node:assert/strict";
import { LRUCache } from "../src/lru.js";
test("get refreshes recency", () => { const c = new LRUCache(2); c.set("a", 1); c.set("b", 2); c.get("a"); c.set("c", 3); assert.equal(c.get("b"), undefined); assert.equal(c.get("a"), 1); });
test("overwrite does not evict", () => { const c = new LRUCache(2); c.set("a", 1); c.set("b", 2); c.set("a", 9); assert.equal(c.size, 2); assert.equal(c.get("b"), 2); assert.equal(c.get("a"), 9); });
test("overwrite refreshes", () => { const c = new LRUCache(2); c.set("a", 1); c.set("b", 2); c.set("a", 3); c.set("c", 4); assert.equal(c.get("b"), undefined); });
test("falsy values", () => { const c = new LRUCache(1); c.set("z", 0); assert.equal(c.get("z"), 0); });
test("missing key does not change order", () => { const c = new LRUCache(2); c.set("a", 1); c.set("b", 2); c.get("nope"); c.set("c", 3); assert.equal(c.get("a"), undefined); });
test("size never exceeds capacity", () => { const c = new LRUCache(3); for (let i = 0; i < 10; i++) c.set(i, i); assert.equal(c.size, 3); });
