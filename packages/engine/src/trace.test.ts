import assert from "node:assert/strict";
import test from "node:test";
import { hasTrace, parseTrace } from "./trace.js";

const files = ["src/auth/session.js", "src/server.js", "app/models.py", "pkg/handler.go", "src/main/java/com/acme/Foo.java"];

test("node trace: the project's frames, innermost first; runtime and stray frames left out", () => {
  const t = `TypeError: Cannot read properties of undefined (reading 'trim')
    at sessionFromHeaders (file:///home/dana/planner/src/auth/session.js:22:41)
    at GET /api/tasks (file:///home/dana/planner/src/server.js:11:23)
    at file:///home/dana/planner/src/server.js:18:22
    at ModuleJob.run (node:internal/modules/esm/module_job:343:25)
    at Object.<anonymous> (/home/dana/planner/node_modules/x/index.js:3:1)`;
  assert.equal(hasTrace(t), true);
  const p = parseTrace(t, files)!;
  assert.match(p.error, /TypeError: Cannot read properties of undefined/);
  assert.deepEqual(p.frames.map((f) => `${f.file}:${f.line}`), ["src/auth/session.js:22", "src/server.js:11", "src/server.js:18"]);
  assert.equal(p.frames[0].fn, "sessionFromHeaders");
});

test("python, java and go frames map to project files", () => {
  const py = `Traceback (most recent call last):\n  File "/srv/app/app/models.py", line 42, in save\n    x.y\nAttributeError: 'NoneType' object has no attribute 'y'`;
  assert.deepEqual(parseTrace(py, files)!.frames, [{ file: "app/models.py", line: 42, fn: "save" }]);
  const java = `java.lang.NullPointerException: boom\n\tat com.acme.Foo.bar(Foo.java:12)\n\tat java.base/java.lang.Thread.run(Thread.java:833)`;
  assert.deepEqual(parseTrace(java, files)!.frames.map((f) => f.file), ["src/main/java/com/acme/Foo.java"]);
  const go = `panic: runtime error: index out of range\n\ngoroutine 1 [running]:\nmain.handle()\n\t/home/u/proj/pkg/handler.go:42 +0x1d`;
  assert.deepEqual(parseTrace(go, files)!.frames, [{ file: "pkg/handler.go", line: 42 }]);
});

test("ordinary text is not a trace", () => {
  assert.equal(hasTrace("Add pagination to GET /api/tasks at the top of the list"), false);
  assert.equal(hasTrace("Fix the TypeError in the login form"), false);
});
