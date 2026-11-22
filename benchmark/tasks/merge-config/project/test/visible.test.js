import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeConfig } from "../src/config.js";
test("merges", () => {
  const r = mergeConfig({ a: 1, n: { x: 1, y: 2 } }, { b: 2, n: { y: 3 } });
  assert.deepEqual(r, { a: 1, b: 2, n: { x: 1, y: 3 } });
});
