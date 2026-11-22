import { test } from "node:test";
import assert from "node:assert/strict";
import { describe as d, total } from "../src/index.js";
test("service", () => {
  assert.equal(d("a"), "item a (1)");
  assert.equal(total(["a", "b", "zz"]), 3);
});
