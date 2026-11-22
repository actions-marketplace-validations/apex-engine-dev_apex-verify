import { test } from "node:test";
import assert from "node:assert/strict";
import { paginate } from "../src/paginate.js";
const xs = [1, 2, 3, 4, 5];
test("pages", () => {
  assert.deepEqual(paginate(xs, 1, 2).items, [1, 2]);
  assert.deepEqual(paginate(xs, 3, 2).items, [5]);
});
test("total pages rounds up", () => { assert.equal(paginate(xs, 1, 2).totalPages, 3); assert.equal(paginate([], 1, 2).totalPages, 0); });
test("past the end", () => { const r = paginate(xs, 4, 2); assert.deepEqual(r.items, []); assert.equal(r.totalPages, 3); });
test("bad size", () => { assert.throws(() => paginate(xs, 1, 0), RangeError); assert.throws(() => paginate(xs, 1, -3), RangeError); });
test("bad page", () => { assert.throws(() => paginate(xs, 0, 2), RangeError); });
