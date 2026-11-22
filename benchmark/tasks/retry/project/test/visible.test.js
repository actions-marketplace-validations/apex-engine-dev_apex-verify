import { test } from "node:test";
import assert from "node:assert/strict";
import { retry } from "../src/retry.js";
test("succeeds after failures", async () => {
  let n = 0;
  const r = await retry(async () => { if (++n < 3) throw new Error("x"); return "ok"; }, { retries: 3, delayMs: 1 });
  assert.equal(r, "ok");
  assert.equal(n, 3);
});
