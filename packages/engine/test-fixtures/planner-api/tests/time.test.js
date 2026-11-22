import test from "node:test";
import assert from "node:assert/strict";
import { dayKey, isSameDay, isBeforeToday, isTimeZone } from "../src/time/zone.js";
import { byPriorityThenDue } from "../src/tasks/priority.js";

test("calendar days follow the user's time zone", () => {
  assert.equal(dayKey("2026-11-08T23:30:00Z", "Asia/Jerusalem"), "2026-11-09");
  assert.ok(isSameDay("2026-11-07T23:30:00Z", "2026-11-08T12:00:00Z", "Asia/Jerusalem"));
  assert.ok(isBeforeToday("2026-11-07T10:00:00Z", "2026-11-08T12:00:00Z", "UTC"));
  assert.ok(isTimeZone("America/New_York"));
  assert.equal(isTimeZone("Mars/Olympus"), false);
});

test("high priority first, then earlier due", () => {
  const list = [{ priority: "low", due: "2026-01-01" }, { priority: "high", due: "2026-01-02" }, { priority: "high", due: "2026-01-01" }];
  assert.deepEqual(list.sort(byPriorityThenDue).map((t) => t.priority + t.due), ["high2026-01-01", "high2026-01-02", "low2026-01-01"]);
});
