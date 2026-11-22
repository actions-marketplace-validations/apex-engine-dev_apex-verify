/**
 * Task store, kept in memory.
 * A task: { id, userId, title, due: ISO string, priority: "high" | "medium" | "low", done: boolean }.
 */
const DEFAULTS = { done: false, priority: "medium" };

export function createStore(seed = []) {
  const tasks = seed.map((t, i) => ({ id: t.id ?? String(i + 1), ...DEFAULTS, ...t }));
  return {
    /** Adds a task and returns a copy of it with its new id. */
    add(task) {
      const t = { ...DEFAULTS, ...task, id: String(tasks.length + 1) };
      tasks.push(t);
      return { ...t };
    },
    /** One task by id, or null. */
    get(id) {
      const t = tasks.find((x) => x.id === String(id));
      return t ? { ...t } : null;
    },
    /** Marks a task done. Returns the updated copy, or null when it is not the user's task. */
    complete(userId, id) {
      const t = tasks.find((x) => x.id === String(id) && x.userId === userId);
      if (!t) return null;
      t.done = true;
      return { ...t };
    },
    /** Copies of every task that belongs to the user. */
    forUser(userId) {
      return tasks.filter((t) => t.userId === userId).map((t) => ({ ...t }));
    },
  };
}
