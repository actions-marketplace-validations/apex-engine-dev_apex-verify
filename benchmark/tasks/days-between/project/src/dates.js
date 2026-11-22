function parse(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
export function daysBetween(a, b) {
  return Math.floor((parse(b) - parse(a)) / 86400000);
}
