export function mergeConfig(base, override) {
  for (const key of Object.keys(override)) {
    if (typeof override[key] === "object" && typeof base[key] === "object") {
      mergeConfig(base[key], override[key]);
    } else {
      base[key] = override[key];
    }
  }
  return base;
}
