export const PRIORITIES = ["high", "medium", "low"];
const RANK = { high: 0, medium: 1, low: 2 };

/** True for "high", "medium" or "low". */
export function isPriority(value) {
  return PRIORITIES.includes(value);
}

/** Sort comparator: high before medium before low, then earlier due first. */
export function byPriorityThenDue(a, b) {
  const p = (RANK[a.priority] ?? 1) - (RANK[b.priority] ?? 1);
  return p !== 0 ? p : new Date(a.due) - new Date(b.due);
}
