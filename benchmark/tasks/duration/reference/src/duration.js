const UNITS = { s: 1, m: 60, h: 3600, d: 86400 };
export function parseDuration(str) {
  const s = String(str).trim();
  if (!/^(\d+[smhd]\s*)+$/.test(s)) throw new Error("bad duration: " + str);
  let total = 0;
  for (const m of s.matchAll(/(\d+)([smhd])/g)) total += Number(m[1]) * UNITS[m[2]];
  return total;
}
