import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyRenames, coverageGate, renamesIn, requestRules } from "./index.js";

test("renames are read from the request", () => {
  assert.deepEqual(renamesIn("Refactor: rename isSameDay to isSameLocalDay everywhere (src and tests)"), [{ from: "isSameDay", to: "isSameLocalDay" }]);
  assert.deepEqual(renamesIn("Rename the function `getUser` → `fetchUser`, and rename UserRow into AccountRow"), [{ from: "getUser", to: "fetchUser" }, { from: "UserRow", to: "AccountRow" }]);
  assert.deepEqual(renamesIn("Add a rename button to the toolbar"), []);
});

test("a rename touches whole identifiers in every code file, nothing else", async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "apex-rename-"));
  await fs.mkdir(path.join(d, "src")); await fs.mkdir(path.join(d, "tests"));
  await fs.writeFile(path.join(d, "src/zone.js"), "export function isSameDay(a, b) { return a === b; }\nexport const isSameDayish = 1;\n");
  await fs.writeFile(path.join(d, "tests/zone.test.js"), "import { isSameDay } from '../src/zone.js';\nisSameDay(1, 1);\n");
  await fs.writeFile(path.join(d, "README.md"), "isSameDay is documented here\n");
  const changed = await applyRenames(d, [{ from: "isSameDay", to: "isSameLocalDay" }]);
  assert.deepEqual(changed.map((c) => [c.path, c.count]).sort(), [["src/zone.js", 1], ["tests/zone.test.js", 2]]);
  const z = changed.find((c) => c.path === "src/zone.js")!.after;
  assert.match(z, /function isSameLocalDay\(/);
  assert.match(z, /isSameDayish/, "a longer identifier is left alone");
});

test("named exports are read from the request and checked on a version", async () => {
  const { namedExports, missingExports } = await import("./index.js");
  const task = "Put the logic in `todayTasks(store, session, now)` exported from `src/today.js` (session is what verifySession returns), and register the route in `src/server.js`.";
  assert.deepEqual(namedExports(task), [{ name: "todayTasks", params: 3, file: "src/today.js" }]);
  assert.deepEqual(namedExports("Register GET /api/today in src/server.js"), []);
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "apex-iface-"));
  await fs.mkdir(path.join(d, "src"));
  await fs.writeFile(path.join(d, "src/today.js"), "export function createToday(store, session) { return []; }\n");
  assert.deepEqual(await missingExports(d, namedExports(task)), ["src/today.js does not export todayTasks with 3 parameters"]);
  await fs.writeFile(path.join(d, "src/today.js"), "export function todayTasks(store, session) { return []; }\n");
  assert.deepEqual(await missingExports(d, namedExports(task)), ["todayTasks in src/today.js takes 2 parameters; the task names 3"]);
  await fs.writeFile(path.join(d, "src/today.js"), "export async function todayTasks(store, session, now = new Date()) { return []; }\n");
  assert.deepEqual(await missingExports(d, namedExports(task)), []);
  await fs.writeFile(path.join(d, "src/today.js"), "export const todayTasks = (store, session, now) => [];\n");
  assert.deepEqual(await missingExports(d, namedExports(task)), []);
});

test("files that came along as context never become rules or checks", () => {
  const ask = "In planner-web, add `public/badges.js` exporting `taskBadges(task, now = new Date())`. It returns \"overdue\" when its due time is before `now`.";
  const task = `${ask}\n\nContext for this request (files from another project of this client are read-only references: do not edit them, build against them):\n` +
    `<reused-file project="planner-api" path="src/server.js">\nconst timeZone = body.timeZone || "UTC";\nconst routes = {\n  "POST /api/sessions": signIn,\n};\n// must return 401 without a session\n</reused-file>`;
  const rules = requestRules(task).map((r) => r.text).join("\n");
  assert.doesNotMatch(rules, /timeZone|api\/sessions|401/);
  assert.match(rules, /overdue/);
  const gate = coverageGate(task, ["taskBadges returns overdue for a task due before now"]);
  assert.ok(gate.checks.every((c) => !/timeZone|signIn|401/.test(c)), gate.checks.join(" | "));
});
