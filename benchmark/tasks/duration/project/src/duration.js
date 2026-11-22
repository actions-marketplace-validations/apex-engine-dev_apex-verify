export function parseDuration(str) {
  const m = /^(\d+)([sm])$/.exec(str);
  if (!m) throw new Error("bad duration: " + str);
  return Number(m[1]) * (m[2] === "m" ? 60 : 1);
}
