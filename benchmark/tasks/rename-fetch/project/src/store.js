// Item store. fetchItem(id) returns a copy of the stored item or null.
const items = new Map([["a", { id: "a", n: 1 }], ["b", { id: "b", n: 2 }]]);

/** fetchItem: look up an item by id. */
export function fetchItem(id) {
  const it = items.get(id);
  return it ? { ...it } : null;
}

export function itemCount() {
  return items.size;
}
