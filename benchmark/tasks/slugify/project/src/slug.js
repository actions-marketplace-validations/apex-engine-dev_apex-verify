export function slugify(text) {
  return String(text).toLowerCase().trim().replace(/\s+/g, "-");
}
