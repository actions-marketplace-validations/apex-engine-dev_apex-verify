export class Emitter {
  constructor() {
    this.handlers = {};
  }
  on(event, fn) {
    (this.handlers[event] ??= []).push(fn);
    return this;
  }
  once(event, fn) {
    const wrapper = (...args) => {
      this.off(event, wrapper);
      fn(...args);
    };
    return this.on(event, wrapper);
  }
  off(event, fn) {
    const list = this.handlers[event];
    if (!list) return this;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
    return this;
  }
  emit(event, ...args) {
    const list = this.handlers[event] || [];
    for (const fn of list) fn(...args);
    return list.length > 0;
  }
}
