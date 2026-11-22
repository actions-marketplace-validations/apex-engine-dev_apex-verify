export class TodoList {
  constructor() {
    this.items = [];
    this.nextId = 1;
  }
  add(text) {
    const item = { id: this.nextId++, text, done: false };
    this.items.push(item);
    return item;
  }
  complete(id) {
    const it = this.items.find((i) => i.id === id);
    if (!it) throw new Error("no such todo " + id);
    it.done = true;
  }
  remove(id) {
    this.items = this.items.filter((i) => i.id !== id);
  }
  pending() {
    return this.items.filter((i) => !i.done);
  }
}
