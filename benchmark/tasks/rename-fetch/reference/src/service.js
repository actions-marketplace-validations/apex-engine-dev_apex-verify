import { loadItem } from "./store.js";

export function describe(id) {
  const it = loadItem(id);
  return it ? `item ${it.id} (${it.n})` : "missing";
}

export function total(ids) {
  return ids.map((i) => loadItem(i)).filter(Boolean).reduce((s, it) => s + it.n, 0);
}
