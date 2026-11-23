// Minimal mocha-compatible globals on top of node:test, so the library's own mocha tests run with `node --test`
// without installing mocha. Supports describe/it (+ .skip/.only), before/after/beforeEach/afterEach and a shared `this`.
const t = require("node:test");
let ctx = {};
const stack = [];
const wrap = (fn, c) => (fn.length > 0 ? (a) => new Promise((res, rej) => fn.call(c, (e) => (e ? rej(e) : res()))) : () => fn.call(c));
function describe(name, fn) {
  const c = Object.create(ctx);
  stack.push(ctx); ctx = c;
  try { return t.describe(name, () => { const p = ctx; ctx = c; try { fn.call(c); } finally { ctx = p; } }); } finally { ctx = stack.pop(); }
}
describe.skip = (name, fn) => t.describe.skip(name, () => {});
const mk = (k) => (fn) => { const c = ctx; return t[k](wrap(fn, c)); };
const it = (name, fn) => { const c = ctx; return t.it(name, wrap(fn, c)); };
it.skip = (name) => t.it.skip(name);
Object.assign(globalThis, { describe, it, specify: it, before: mk("before"), after: mk("after"), beforeEach: mk("beforeEach"), afterEach: mk("afterEach") });
