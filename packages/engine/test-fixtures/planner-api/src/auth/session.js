import { randomUUID } from "node:crypto";

/**
 * Signed-in sessions, kept in memory.
 * Each session knows the user's id and their IANA time zone (e.g. "Asia/Jerusalem").
 * A session lasts SESSION_TTL_SECONDS from sign-in.
 */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

const sessions = new Map();

/** Starts a session and returns its token. `now` is for tests. */
export function createSession(userId, timeZone = "UTC", now = Date.now()) {
  if (!userId) throw new Error("userId is required");
  const token = randomUUID();
  sessions.set(token, { userId, timeZone, expiresAt: now + SESSION_TTL_SECONDS * 1000 });
  return token;
}

/** Returns { userId, timeZone } for a valid token, or null. */
export function verifySession(token, now = Date.now()) {
  if (!token) return null;
  const s = sessions.get(String(token));
  if (!s) return null;
  if (isExpired(s, now)) return null;
  return { userId: s.userId, timeZone: s.timeZone };
}

/** Signs the token out. Returns true when there was a session to end. */
export function endSession(token) {
  return sessions.delete(String(token));
}

/** Expiry is checked in whole seconds so clock jitter between servers does not sign people out early. */
function isExpired(session, now) {
  return session.expiresAt <= Math.floor(now / 1000);
}

/** Reads "Authorization: Bearer <token>" from request headers and verifies it. */
export function sessionFromHeaders(headers = {}, now = Date.now()) {
  const raw = headers.authorization || headers.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(raw);
  return m ? verifySession(m[1].trim(), now) : null;
}
