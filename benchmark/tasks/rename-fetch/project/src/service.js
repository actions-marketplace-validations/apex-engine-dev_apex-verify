import { fetchItem } from "./store.js";

export function describe(id) {
  const it = fetchItem(id);
  return it ? `item ${it.id} (${it.n})` : "missing";
}

export function total(ids) {
  return ids.map((i) => fetchItem(i)).filter(Boolean).reduce((s, it) => s + it.n, 0);
}
