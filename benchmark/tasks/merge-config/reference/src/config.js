const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
  return v;
}
export function mergeConfig(base, override) {
  const out = clone(base);
  for (const [key, val] of Object.entries(override)) {
    if (val === undefined) continue;
    if (isObj(val) && isObj(out[key])) out[key] = mergeConfig(out[key], val);
    else out[key] = clone(val);
  }
  return out;
}
