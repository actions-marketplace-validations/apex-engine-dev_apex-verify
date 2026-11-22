import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDuration } from "../src/duration.js";
test("units", () => { assert.equal(parseDuration("2h"), 7200); assert.equal(parseDuration("1d"), 86400); });
test("combined", () => { assert.equal(parseDuration("1h30m"), 5400); assert.equal(parseDuration("2d 4h"), 2 * 86400 + 4 * 3600); assert.equal(parseDuration("1m 1s"), 61); });
test("garbage", () => { for (const s of ["", "abc", "10", "5x", "1h junk", "m5", "-5m", "1h-"]) assert.throws(() => parseDuration(s), Error, s); });
test("whitespace around", () => assert.equal(parseDuration("  10m "), 600));
test("zero", () => assert.equal(parseDuration("0s"), 0));
