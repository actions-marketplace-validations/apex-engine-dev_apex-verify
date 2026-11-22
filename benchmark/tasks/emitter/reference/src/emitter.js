export class Emitter {
  constructor() {
    this.handlers = {};
  }
  on(event, fn) {
    (this.handlers[event] ??= []).push({ fn });
    return this;
  }
  once(event, fn) {
    const entry = { fn, once: true };
    (this.handlers[event] ??= []).push(entry);
    return this;
  }
  off(event, fn) {
    const list = this.handlers[event];
    if (!list) return this;
    const i = list.findIndex((h) => h.fn === fn);
    if (i >= 0) list.splice(i, 1);
    return this;
  }
  emit(event, ...args) {
    const list = (this.handlers[event] || []).slice();
    for (const h of list) {
      if (h.once) {
        const cur = this.handlers[event];
        const i = cur.indexOf(h);
        if (i < 0) continue;
        cur.splice(i, 1);
      }
      h.fn(...args);
    }
    return list.length > 0;
  }
}
