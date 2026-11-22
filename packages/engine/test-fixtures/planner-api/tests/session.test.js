import test from "node:test";
import assert from "node:assert/strict";
import { createSession, verifySession, endSession, sessionFromHeaders } from "../src/auth/session.js";

test("a new session knows the user and their time zone", () => {
  const token = createSession("dana", "Asia/Jerusalem");
  assert.deepEqual(verifySession(token), { userId: "dana", timeZone: "Asia/Jerusalem" });
});

test("unknown tokens and signed-out sessions are refused", () => {
  assert.equal(verifySession("nope"), null);
  const token = createSession("omer");
  assert.equal(endSession(token), true);
  assert.equal(verifySession(token), null);
});

test("the bearer header is read case-insensitively", () => {
  const token = createSession("dana", "UTC");
  assert.equal(sessionFromHeaders({ authorization: `bearer ${token}` }).userId, "dana");
  assert.equal(sessionFromHeaders({}), null);
});
