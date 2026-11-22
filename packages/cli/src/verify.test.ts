import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ModelClient, ModelEvent } from "reallydone-engine";
import { verify } from "./verify.js";
import { parseVerifyArgs } from "./verify-cmd.js";
import { renderMarkdown, renderSarif, renderText, exitCode } from "./report.js";
import { lastUserPrompt } from "./hook.js";
import { handle } from "./mcp.js";

// Tests never touch the real cache in the home folder.
const TEST_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), "apex-vt-cache0-"));
process.env.APEX_CACHE_DIR = TEST_CACHE;
const TASK = "slugify should replace spaces with dashes and lower-case the text";
const CHECKS = "```js\nimport { test } from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { slugify } from \"../src/slug.js\";\ntest(\"replaces spaces with dashes\", () => { assert.equal(slugify(\"Hello Big World\"), \"hello-big-world\"); });\ntest(\"lower-cases\", () => { assert.equal(slugify(\"ABC\"), \"abc\"); });\n```";

const fake = (text = CHECKS): ModelClient => ({
  async *stream(): AsyncIterable<ModelEvent> { yield { type: "text-delta", text } as ModelEvent; yield { type: "usage", inputTokens: 10, outputTokens: 10 } as ModelEvent; yield { type: "done" } as ModelEvent; },
});

function repo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "apex-vt-"));
  fs.mkdirSync(path.join(d, "src")); fs.mkdirSync(path.join(d, "test"));
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "p", type: "module", scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(d, "src/slug.js"), "export function slugify(s) { return String(s).toLowerCase(); }\n");
  fs.writeFileSync(path.join(d, "test/slug.test.js"), "import { test } from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { slugify } from \"../src/slug.js\";\ntest(\"lower\", () => { assert.equal(slugify(\"A\"), \"a\"); });\ntest(\"empty\", () => { assert.equal(slugify(\"\"), \"\"); });\n");
  const g = (...a: string[]) => execFileSync("git", ["-C", d, ...a], { stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  g("init", "-q"); g("add", "-A"); g("commit", "-q", "-m", "init");
  return d;
}
const write = (d: string, f: string, c: string) => fs.writeFileSync(path.join(d, f), c);

test("a correct change is READY: checks fail on the old code, pass on the new, tests pass", async () => {
  const d = repo();
  write(d, "src/slug.js", "export function slugify(s) { return String(s).toLowerCase().trim().replace(/\\s+/g, \"-\"); }\n");
  const r = await verify({ dir: d, task: TASK, checker: { client: fake(), model: "m" }, cache: false });
  assert.equal(r.verdict, "ready", JSON.stringify(r.reasons));
  assert.equal(r.checks.failedOnOldCode, true);
  assert.equal(r.checks.failed, 0);
  assert.ok(r.checks.passed >= 2);
  assert.equal(exitCode(r.verdict), 0);
  assert.match(renderText(r), /READY/);
});

test("the same task on the same code reuses its checks instead of asking the model again", async () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "apex-vt-cache-"));
  process.env.APEX_CACHE_DIR = cache;
  try {
    const d = repo();
    write(d, "src/slug.js", "export function slugify(s) { return String(s).toLowerCase().trim().replace(/\\s+/g, \"-\"); }\n");
    const first = await verify({ dir: d, task: TASK, checker: { client: fake(), model: "m" } });
    assert.equal(first.verdict, "ready");
    const boom: ModelClient = { async *stream(): AsyncIterable<ModelEvent> { throw new Error("the model must not be called"); } };
    const second = await verify({ dir: d, task: TASK, checker: { client: boom, model: "m" } });
    assert.equal(second.verdict, "ready");
    assert.equal(second.usage.modelCalls, 0);
  } finally { process.env.APEX_CACHE_DIR = TEST_CACHE; }
});

test("a wrong change is NOT READY and names the failing check", async () => {
  const d = repo();
  write(d, "src/slug.js", "export function slugify(s) { return String(s).toLowerCase().replace(/ /g, \"_\"); }\n");
  const r = await verify({ dir: d, task: TASK, checker: { client: fake(), model: "m" }, secondLook: false });
  assert.equal(r.verdict, "not_ready");
  assert.equal(r.reasons[0]!.kind, "check_failed");
  assert.match(r.reasons[0]!.evidence ?? "", /dash|hello/i);
  assert.equal(exitCode(r.verdict), 1);
  assert.match(renderMarkdown(r), /reallydone/);
});

test("deleting a test to make the change pass is NOT READY, with no model needed", async () => {
  const d = repo();
  write(d, "src/slug.js", "export function slugify(s) { return 1; }\n");
  fs.rmSync(path.join(d, "test/slug.test.js"));
  const r = await verify({ dir: d, task: TASK, checker: null });
  assert.equal(r.verdict, "not_ready");
  assert.ok(r.reasons.some((x) => x.kind === "cheat" && /deleted a test file/.test(x.summary)));
});

test("a change that breaks an existing test is NOT READY", async () => {
  const d = repo();
  write(d, "src/slug.js", "export function slugify(s) { return String(s).toUpperCase(); }\n");
  const r = await verify({ dir: d, task: TASK, checker: null });
  assert.equal(r.verdict, "not_ready");
  assert.ok(r.reasons.some((x) => x.kind === "regression"));
  assert.ok(r.tests.newlyFailing.length >= 1);
});

test("a change that breaks the type check is NOT READY even though the tests pass", async () => {
  const d = repo();
  const pkg = JSON.parse(fs.readFileSync(path.join(d, "package.json"), "utf8")); pkg.scripts.typecheck = "node check-types.mjs"; fs.writeFileSync(path.join(d, "package.json"), JSON.stringify(pkg));
  fs.writeFileSync(path.join(d, "check-types.mjs"), 'import fs from "node:fs"; const s = fs.readFileSync("src/slug.js", "utf8"); if (s.includes("MISSING_IMPORT")) { console.error("src/slug.js: error TS2307: cannot find module"); process.exit(1); }\n');
  execFileSync("git", ["-C", d, "add", "-A"]); execFileSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "typecheck"]);
  write(d, "src/slug.js", "// MISSING_IMPORT\nexport function slugify(s) { return String(s).toLowerCase().trim(); }\n");
  const r = await verify({ dir: d, task: TASK, checker: null });
  assert.equal(r.verdict, "not_ready");
  assert.ok(r.reasons.some((x) => x.kind === "regression" && /typecheck/.test(x.summary)), JSON.stringify(r.reasons));
});

test("without a checker a clean change is UNKNOWN, never a silent pass", async () => {
  const d = repo();
  write(d, "src/slug.js", "export function slugify(s) { return String(s).toLowerCase().trim(); }\n");
  const r = await verify({ dir: d, task: TASK, checker: null });
  assert.equal(r.verdict, "unknown");
  assert.ok(r.reasons.some((x) => x.kind === "no_checks"));
  assert.equal(exitCode(r.verdict), 3);
});

test("nothing changed: UNKNOWN with a clear reason; the project is never modified", async () => {
  const d = repo();
  const before = fs.readFileSync(path.join(d, "src/slug.js"), "utf8");
  const r = await verify({ dir: d, task: TASK, checker: null });
  assert.equal(r.verdict, "unknown");
  assert.equal(r.reasons[0]!.kind, "no_change");
  assert.equal(fs.readFileSync(path.join(d, "src/slug.js"), "utf8"), before);
});

test("a diff file is judged on a copy", async () => {
  const d = repo();
  const patched = fs.mkdtempSync(path.join(os.tmpdir(), "apex-vt-p-"));
  fs.cpSync(d, patched, { recursive: true, filter: (p) => !p.includes(`${path.sep}.git`) });
  write(patched, "src/slug.js", "export function slugify(s) { return String(s).toLowerCase().trim().replace(/\\s+/g, \"-\"); }\n");
  let diff = ""; try { execFileSync("diff", ["-ruN", "-x", ".git", d, patched], { encoding: "utf8" }); } catch (e: any) { diff = e.stdout; }
  const f = path.join(os.tmpdir(), `apex-vt-${process.pid}.diff`);
  fs.writeFileSync(f, diff.replace(new RegExp(d.replace(/[/\\]/g, "\\$&"), "g"), "a").replace(new RegExp(patched.replace(/[/\\]/g, "\\$&"), "g"), "b"));
  const r = await verify({ dir: d, task: TASK, diffFile: f, checker: { client: fake(), model: "m" } });
  assert.equal(r.change.mode, "patch");
  assert.equal(r.verdict, "ready", JSON.stringify(r.reasons));
  assert.match(fs.readFileSync(path.join(d, "src/slug.js"), "utf8"), /toLowerCase\(\); \}/);
});

test("argument parsing: key and model are required unless --no-model", () => {
  assert.throws(() => parseVerifyArgs(["do it"], {}), /GEMINI_API_KEY/);
  assert.throws(() => parseVerifyArgs([], {}), /say what/);
  const a = parseVerifyArgs(["do it", "--no-model", "--format", "json"], {});
  assert.equal(a.noModel, true);
  assert.equal(a.format, "json");
  assert.equal(parseVerifyArgs(["do it", "--provider", "openai", "--model", "m"], { OPENAI_API_KEY: "k" }).model, "m");
});

test("SARIF and exit codes", () => {
  const r: any = { verdict: "not_ready", reasons: [{ kind: "regression", summary: "x", hint: "y" }], change: { files: [{ path: "a.js" }] } };
  const s = JSON.parse(renderSarif(r));
  assert.equal(s.version, "2.1.0");
  assert.equal(s.runs[0].results[0].level, "error");
  assert.deepEqual([exitCode("ready"), exitCode("not_ready"), exitCode("unknown")], [0, 1, 3]);
});

test("the hook finds the person's last request in the transcript", () => {
  const t = [
    JSON.stringify({ type: "user", message: { role: "user", content: "first request" } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "x" }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "fix the csv parser\n<system-reminder>ignore</system-reminder>" }] } }),
  ].join("\n");
  assert.equal(lastUserPrompt(t), "fix the csv parser");
});

test("the MCP server lists and calls verify_change", async () => {
  const list = await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(list.result.tools[0].name, "verify_change");
  const init = await handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(init.result.serverInfo.name, "reallydone");
  const d = repo();
  const call = await handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "verify_change", arguments: { task: TASK, dir: d } } }, { APEX_NO_MODEL: "1" });
  assert.equal(call.result.isError, false);
  assert.equal(call.result.structuredContent.verdict, "unknown");
});
