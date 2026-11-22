import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ModelClient, ModelEvent } from "apex-verify-engine";
import { verify } from "./verify.js";

/**
 * Real Vitest (TypeScript) and Jest projects, installed with npm: the checks are written in the project's own framework
 * and run by it. Needs the network for `npm install` and takes minutes, so it only runs with APEX_FRAMEWORK_TESTS=1 (the `frameworks` CI job).
 */
const skip = process.env.APEX_FRAMEWORK_TESTS !== "1";
const TASK = "slugify should replace spaces with dashes and lower-case the text";
const git = (d: string, ...a: string[]) => execFileSync("git", ["-C", d, ...a], { stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const install = (d: string) => execFileSync("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: d, stdio: "pipe", timeout: 240_000 });
const write = (d: string, f: string, c: string) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); };
const model = (text: string): ModelClient => ({ async *stream(req: any): AsyncIterable<ModelEvent> {
  const prompt = String(req.messages?.[1]?.content ?? "");
  const system = String(req.messages?.[0]?.content ?? "");
  yield { type: "text-delta", text: system.startsWith("You settle") ? "CODE\nthe change is wrong" : text } as ModelEvent;
  yield { type: "done" } as ModelEvent;
  void prompt;
} });

function vitestProject(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "apex-vitest-"));
  write(d, "package.json", JSON.stringify({ name: "p", type: "module", scripts: { test: "vitest run" }, devDependencies: { vitest: "^2.1.0" } }));
  write(d, "src/slug.ts", "export function slugify(s: string): string { return s.toLowerCase(); }\n");
  write(d, "test/slug.test.ts", "import { test, expect } from \"vitest\";\nimport { slugify } from \"../src/slug\";\ntest(\"lower\", () => { expect(slugify(\"A\")).toBe(\"a\"); });\n");
  write(d, ".gitignore", "node_modules\n");
  install(d); git(d, "init", "-q"); git(d, "add", "-A"); git(d, "commit", "-q", "-m", "init");
  return d;
}
function jestProject(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "apex-jest-"));
  write(d, "package.json", JSON.stringify({ name: "p", scripts: { test: "jest" }, devDependencies: { jest: "^29.7.0" } }));
  write(d, "src/slug.js", "module.exports = { slugify: (s) => String(s).toLowerCase() };\n");
  write(d, "test/slug.test.js", "const { slugify } = require(\"../src/slug\");\ntest(\"lower\", () => { expect(slugify(\"A\")).toBe(\"a\"); });\n");
  write(d, ".gitignore", "node_modules\n");
  install(d); git(d, "init", "-q"); git(d, "add", "-A"); git(d, "commit", "-q", "-m", "init");
  return d;
}
const VITEST_CHECKS = "```ts\nimport { test, expect } from \"vitest\";\nimport { slugify } from \"../src/slug\";\ntest(\"replaces spaces with dashes\", () => { expect(slugify(\"Hello Big World\")).toBe(\"hello-big-world\"); });\ntest(\"lower-cases\", () => { expect(slugify(\"ABC\")).toBe(\"abc\"); });\n```";
const JEST_CHECKS = "```js\nconst { slugify } = require(\"../src/slug\");\ntest(\"replaces spaces with dashes\", () => { expect(slugify(\"Hello Big World\")).toBe(\"hello-big-world\"); });\ntest(\"lower-cases\", () => { expect(slugify(\"ABC\")).toBe(\"abc\"); });\n```";
const cache = () => { process.env.APEX_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "apex-fw-cache-")); };

test("vitest + TypeScript: a correct change is READY, a wrong one NOT READY with expected and actual", { skip, timeout: 600_000 }, async () => {
  cache();
  const d = vitestProject();
  write(d, "src/slug.ts", "export function slugify(s: string): string { return s.toLowerCase().trim().replace(/\\s+/g, \"-\"); }\n");
  const good = await verify({ dir: d, task: TASK, checker: { client: model(VITEST_CHECKS), model: "m" }, cache: false, timeoutSec: 120 });
  assert.equal(good.verdict, "ready", JSON.stringify(good.reasons) + good.warnings.join("|"));
  assert.equal(good.checks.failedOnOldCode, true);
  write(d, "src/slug.ts", "export function slugify(s: string): string { return s.toLowerCase().replace(/ /g, \"_\"); }\n");
  const bad = await verify({ dir: d, task: TASK, checker: { client: model(VITEST_CHECKS), model: "m" }, cache: false, timeoutSec: 120, secondLook: false });
  assert.equal(bad.verdict, "not_ready", JSON.stringify(bad.reasons));
  assert.ok(bad.checks.failedChecks.some((c) => c.expected === "hello-big-world" || /hello/.test(c.actual ?? "")), JSON.stringify(bad.checks.failedChecks));
});

test("jest: a correct change is READY, a wrong one NOT READY with expected and actual", { skip, timeout: 600_000 }, async () => {
  cache();
  const d = jestProject();
  write(d, "src/slug.js", "module.exports = { slugify: (s) => String(s).toLowerCase().trim().replace(/\\s+/g, \"-\") };\n");
  const good = await verify({ dir: d, task: TASK, checker: { client: model(JEST_CHECKS), model: "m" }, cache: false, timeoutSec: 120 });
  assert.equal(good.verdict, "ready", JSON.stringify(good.reasons) + good.warnings.join("|"));
  write(d, "src/slug.js", "module.exports = { slugify: (s) => String(s).toLowerCase().replace(/ /g, \"_\") };\n");
  const bad = await verify({ dir: d, task: TASK, checker: { client: model(JEST_CHECKS), model: "m" }, cache: false, timeoutSec: 120, secondLook: false });
  assert.equal(bad.verdict, "not_ready", JSON.stringify(bad.reasons));
  assert.ok(bad.checks.failedChecks.length >= 1);
  assert.ok(bad.checks.failedChecks.some((c) => /hello-big-world/.test(c.expected ?? "") || /hello_big_world/.test(c.actual ?? "") || /hello/.test(c.message ?? "")), JSON.stringify(bad.checks.failedChecks));
});
