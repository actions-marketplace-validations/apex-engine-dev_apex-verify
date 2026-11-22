/** Calendar helpers that respect the user's time zone. */

/** True when the name is an IANA time zone this runtime knows (e.g. "Asia/Jerusalem"). */
export function isTimeZone(name) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return typeof name === "string" && name.length > 0;
  } catch {
    return false;
  }
}

/** "YYYY-MM-DD" for the calendar day this instant falls on in the given IANA time zone. */
export function dayKey(date, timeZone = "UTC") {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(date));
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** True when both instants are on the same calendar day in the time zone. */
export function isSameDay(a, b, timeZone = "UTC") {
  return dayKey(a, timeZone) === dayKey(b, timeZone);
}

/** True when the due instant is on an earlier calendar day than now, in the time zone. */
export function isBeforeToday(due, now, timeZone = "UTC") {
  return dayKey(due, timeZone) < dayKey(now, timeZone);
}
