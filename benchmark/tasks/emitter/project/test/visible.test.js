import { test } from "node:test";
import assert from "node:assert/strict";
import { Emitter } from "../src/emitter.js";
test("on and emit", () => {
  const e = new Emitter(); const got = [];
  e.on("x", (v) => got.push(v));
  assert.equal(e.emit("x", 1), true);
  assert.equal(e.emit("y"), false);
  assert.deepEqual(got, [1]);
});
