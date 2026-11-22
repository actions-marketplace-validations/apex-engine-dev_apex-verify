function parse(s) {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}
export function daysBetween(a, b) {
  return Math.round((parse(b) - parse(a)) / 86400000);
}
