import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDuration } from "../src/duration.js";
test("existing", () => {
  assert.equal(parseDuration("90s"), 90);
  assert.equal(parseDuration("5m"), 300);
});
test("hours", () => assert.equal(parseDuration("1h"), 3600));
