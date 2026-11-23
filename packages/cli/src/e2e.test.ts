import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

/**
 * End to end, through the real command line, against a fake OpenAI-compatible model server on localhost. Every use case the
 * README claims (verify in a git repository, a diff, the output formats, the stop hook, the MCP server, the error cases)
 * is run here, offline.
 */
const run = promisify(execFile);
const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "main.js");
const CHECKS = "```js\nimport { test } from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { slugify } from \"../src/slug.js\";\ntest(\"replaces spaces with dashes\", () => { assert.equal(slugify(\"Hello Big World\"), \"hello-big-world\"); });\ntest(\"lower-cases\", () => { assert.equal(slugify(\"ABC\"), \"abc\"); });\n```";
const TASK = "slugify should replace spaces with dashes and lower-case the text";

let server: http.Server, base = "", requests = 0, cache = "";
before(async () => {
  server = http.createServer((req, res) => {
    requests++;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: CHECKS } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cache = fs.mkdtempSync(path.join(os.tmpdir(), "apex-e2e-cache-"));
});
after(() => { server.close(); });

const env = () => ({ ...process.env, APEX_CACHE_DIR: cache, FAKE_KEY: "k", APEX_BASE_URL: base, APEX_API_KEY_ENV: "FAKE_KEY", APEX_CHECKER_MODEL: "fake" });
async function cli(args: string[], cwd: string, extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  try { const r = await run(process.execPath, [MAIN, ...args], { cwd, env: { ...env(), ...extraEnv } }); return { code: 0, out: r.stdout, err: r.stderr }; }
  catch (e: any) { return { code: e.code ?? 1, out: e.stdout ?? "", err: e.stderr ?? "" }; }
}
function repo(change?: "good" | "wrong"): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "apex-e2e-"));
  fs.mkdirSync(path.join(d, "src")); fs.mkdirSync(path.join(d, "test"));
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "p", type: "module", scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(d, "src/slug.js"), "export function slugify(s) { return String(s).toLowerCase(); }\n");
  fs.writeFileSync(path.join(d, "test/slug.test.js"), "import { test } from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { slugify } from \"../src/slug.js\";\ntest(\"lower\", () => { assert.equal(slugify(\"A\"), \"a\"); });\n");
  const g = (...a: string[]) => execFileSync("git", ["-C", d, ...a], { stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  g("init", "-q"); g("add", "-A"); g("commit", "-q", "-m", "init");
  if (change === "good") fs.writeFileSync(path.join(d, "src/slug.js"), "export function slugify(s) { return String(s).toLowerCase().trim().replace(/\\s+/g, \"-\"); }\n");
  if (change === "wrong") fs.writeFileSync(path.join(d, "src/slug.js"), "export function slugify(s) { return String(s).toLowerCase().replace(/ /g, \"_\"); }\n");
  return d;
}

test("a correct change is READY (exit 0), and the project is untouched", async () => {
  const d = repo("good"); const before = fs.readFileSync(path.join(d, "src/slug.js"), "utf8");
  const r = await cli([TASK], d);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /apex verify: READY/);
  assert.equal(fs.readFileSync(path.join(d, "src/slug.js"), "utf8"), before);
});

test("a wrong change is NOT READY (exit 1) and names the failing check", async () => {
  const d = repo("wrong");
  const r = await cli([TASK, "--no-model"], d);
  assert.equal(r.code, 3, "without a model the verdict is unknown");
  const m = await cli([TASK], repo("wrong"), { APEX_CACHE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "apex-e2e-c2-")) });
  assert.equal(m.code, 1, m.out + m.err);
  assert.match(m.out, /NOT READY/);
  assert.match(m.out, /dash|hello/i);
});

test("no model and a clean change is UNKNOWN (exit 3), never a silent pass", async () => {
  const r = await cli([TASK, "--no-model"], repo("good"));
  assert.equal(r.code, 3);
  assert.match(r.out, /UNKNOWN/);
});

test("the same task on the same code reuses its checks: no second model call", async () => {
  const c = fs.mkdtempSync(path.join(os.tmpdir(), "apex-e2e-c3-"));
  const d = repo("good");
  const a = await cli([TASK], d, { APEX_CACHE_DIR: c });
  assert.equal(a.code, 0, a.out + a.err);
  const n = requests;
  const b = await cli([TASK], d, { APEX_CACHE_DIR: c });
  assert.equal(b.code, 0);
  assert.equal(requests, n, "the second run must not call the model");
});

test("formats: json, markdown (with the comment marker), sarif, and files written in one run", async () => {
  const d = repo("good"); const out = fs.mkdtempSync(path.join(os.tmpdir(), "apex-e2e-o-"));
  const j = await cli([TASK, "--format", "json"], d);
  assert.equal(JSON.parse(j.out).verdict, "ready");
  const md = await cli([TASK, "--markdown-out", path.join(out, "r.md"), "--sarif-out", path.join(out, "r.sarif"), "--json-out", path.join(out, "r.json")], d);
  assert.equal(md.code, 0, md.out + md.err);
  assert.match(fs.readFileSync(path.join(out, "r.md"), "utf8"), /<!-- apex-verify -->/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, "r.sarif"), "utf8")).version, "2.1.0");
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, "r.json"), "utf8")).schema, 1);
});

test("--badge-out writes a shields.io endpoint badge with the verdict", async () => {
  const d = repo("good"); const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "apex-e2e-b-")), "badge.json");
  const r = await cli([TASK, "--badge-out", f], d);
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { schemaVersion: 1, label: "apex verify", message: "ready", color: "brightgreen" });
});

test("--badge-out x.svg writes a static SVG badge with the verdict", async () => {
  const d = repo("good"); const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "apex-e2e-bs-")), "badge.svg");
  const r = await cli([TASK, "--badge-out", f], d);
  assert.equal(r.code, 0, r.out + r.err);
  const svg = fs.readFileSync(f, "utf8");
  assert.match(svg, /^<svg xmlns=/);
  assert.match(svg, /apex verify: ready/);
  assert.match(svg, /#4c1/);
});

test("a diff file is judged without a git repository, on a copy", async () => {
  const d = repo(); const diff = path.join(d, "..", `apex-e2e-${process.pid}.diff`);
  fs.writeFileSync(diff, "--- a/src/slug.js\n+++ b/src/slug.js\n@@ -1 +1 @@\n-export function slugify(s) { return String(s).toLowerCase(); }\n+export function slugify(s) { return String(s).toLowerCase().trim().replace(/\\s+/g, \"-\"); }\n");
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "apex-e2e-plain-")); fs.cpSync(d, plain, { recursive: true, filter: (p) => !p.includes(`${path.sep}.git`) });
  const r = await cli([TASK, "--dir", plain, "--diff", diff], os.tmpdir(), { APEX_CACHE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "apex-e2e-c4-")) });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(fs.readFileSync(path.join(plain, "src/slug.js"), "utf8"), /toLowerCase\(\); \}/, "the project itself is not changed");
});

test("errors are clear: not a git repository, no key, no task", async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "apex-e2e-nogit-"));
  const a = await cli([TASK, "--no-model"], plain);
  assert.equal(a.code, 2); assert.match(a.err, /not a git repository/);
  const b = await cli([TASK, "--provider", "gemini", "--dir", repo("good")], os.tmpdir(), { APEX_BASE_URL: "", APEX_API_KEY_ENV: "", GEMINI_API_KEY: "" });
  assert.equal(b.code, 2); assert.match(b.err, /GEMINI_API_KEY/);
  const c = await cli([], plain);
  assert.equal(c.code, 0); assert.match(c.out, /apex/);
});

test("the stop hook blocks 'done' for a wrong change (with the reason), at most 3 times, and stays silent when nothing changed", async () => {
  const d = repo("wrong"); const t = path.join(d, "..", `apex-e2e-tr-${process.pid}.jsonl`);
  fs.writeFileSync(t, JSON.stringify({ type: "user", message: { role: "user", content: TASK } }) + "\n");
  const input = JSON.stringify({ cwd: d, transcript_path: t, session_id: `e2e-${process.pid}` });
  const hook = (stdin: string, extra: Record<string, string> = {}) => new Promise<{ code: number | null; out: string }>((resolve) => {
    const p = spawn(process.execPath, [MAIN, "--hook"], { cwd: d, env: { ...env(), APEX_CACHE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "apex-e2e-hc-")), ...extra } });
    let out = ""; p.stdout.on("data", (x) => (out += x)); p.on("close", (code) => resolve({ code, out })); p.stdin.end(stdin);
  });
  const outs: string[] = [];
  for (let i = 0; i < 4; i++) outs.push((await hook(input)).out.trim());
  const blocks = outs.filter((o) => o && JSON.parse(o).decision === "block");
  assert.equal(blocks.length, 3, outs.join("\n"));
  assert.match(JSON.parse(blocks[0]!).reason, /NOT READY/);
  const clean = repo();
  assert.equal((await hook(JSON.stringify({ cwd: clean, transcript_path: t, session_id: "e2e-clean" }))).out.trim(), "");
  const warn = await hook(JSON.stringify({ cwd: repo("wrong"), transcript_path: t, session_id: "e2e-warn" }), { APEX_MODE: "warn" });
  assert.ok(!warn.out.includes('"block"'), "warn mode never blocks");
});

test("the stop hook speaks Cursor (workspace_roots, followup_message) and Gemini CLI (prompt, no transcript)", async () => {
  const run = (stdin: string) => new Promise<string>((resolve) => {
    const p = spawn(process.execPath, [MAIN, "--hook"], { cwd: os.tmpdir(), env: { ...env(), APEX_CACHE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "apex-e2e-hx-")) } });
    let out = ""; p.stdout.on("data", (x) => (out += x)); p.on("close", () => resolve(out.trim())); p.stdin.end(stdin);
  });
  const t = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "apex-e2e-cur-")), "tr.jsonl");
  fs.writeFileSync(t, JSON.stringify({ role: "user", content: [{ type: "text", text: TASK }] }) + "\n");
  const cursor = JSON.parse(await run(JSON.stringify({ hook_event_name: "stop", status: "completed", conversation_id: `cur-${process.pid}`, workspace_roots: [repo("wrong")], transcript_path: t, loop_count: 0 })));
  assert.equal(cursor.decision, "block");
  assert.match(cursor.followup_message, /NOT READY/);
  assert.equal(await run(JSON.stringify({ hook_event_name: "stop", status: "aborted", conversation_id: "cur-ab", workspace_roots: [repo("wrong")], transcript_path: t })), "", "an aborted run is not verified");
  const gemini = JSON.parse(await run(JSON.stringify({ cwd: repo("wrong"), session_id: `gem-${process.pid}`, prompt: TASK, prompt_response: "done", stop_hook_active: false })));
  assert.equal(gemini.decision, "block");
  assert.ok(!("followup_message" in gemini), "only Cursor gets followup_message");
});

test("the MCP server answers initialize, lists verify_change and verifies a change", async () => {
  const d = repo("good");
  const msgs = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "verify_change", arguments: { task: TASK, dir: d } } },
  ];
  const out = await new Promise<string>((resolve) => {
    const p = spawn(process.execPath, [MAIN, "--mcp"], { env: { ...env(), APEX_CACHE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "apex-e2e-mc-")) } });
    let buf = ""; p.stdout.on("data", (x) => (buf += x)); p.on("close", () => resolve(buf));
    p.stdin.end(msgs.map((m) => JSON.stringify(m)).join("\n") + "\n");
  });
  const lines = out.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.find((l) => l.id === 1).result.serverInfo.name, "apex");
  assert.equal(lines.find((l) => l.id === 2).result.tools[0].name, "verify_change");
  const call = lines.find((l) => l.id === 3).result;
  assert.equal(call.isError, false);
  assert.equal(call.structuredContent.verdict, "ready");
});

test("the stop hook sees a change to an untracked file with a space or accent in its name, and blocks at most 3 times per session even as the change changes", async () => {
  const d = repo("good"); const t = path.join(d, "..", `apex-e2e-fp-${process.pid}.jsonl`);
  fs.writeFileSync(t, JSON.stringify({ type: "user", message: { role: "user", content: TASK } }) + "\n");
  const run = (session: string) => new Promise<string>((resolve) => {
    const p = spawn(process.execPath, [MAIN, "--hook"], { cwd: d, env: { ...env(), APEX_CACHE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "apex-e2e-fp-c-")) } });
    let out = ""; p.stdout.on("data", (x) => (out += x)); p.on("close", () => resolve(out.trim())); p.stdin.end(JSON.stringify({ cwd: d, transcript_path: t, session_id: session }));
  });
  const { changeFingerprint } = await import("./hook.js");
  fs.mkdirSync(path.join(d, "test"), { recursive: true });
  const f = path.join(d, "test", "Zoë two.test.js");
  fs.writeFileSync(f, "// v1\n"); const a = changeFingerprint(d);
  fs.writeFileSync(f, "// v2\n"); const b = changeFingerprint(d);
  assert.notEqual(a, b, "a rewrite of an untracked file with an odd name changes the fingerprint");
  // block limit: the change differs on every call, the limit still holds for the session
  const w = repo("wrong"); fs.writeFileSync(t, JSON.stringify({ type: "user", message: { role: "user", content: TASK } }) + "\n");
  const runW = (n: number) => new Promise<string>((resolve) => {
    fs.appendFileSync(path.join(w, "src/slug.js"), `// edit ${n}\n`);
    const p = spawn(process.execPath, [MAIN, "--hook"], { cwd: w, env: { ...env(), APEX_CACHE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "apex-e2e-fp-w-")) } });
    let out = ""; p.stdout.on("data", (x) => (out += x)); p.on("close", () => resolve(out.trim())); p.stdin.end(JSON.stringify({ cwd: w, transcript_path: t, session_id: `loop-${process.pid}` }));
  });
  const outs: string[] = []; for (let i = 0; i < 6; i++) outs.push(await runW(i));
  assert.equal(outs.filter((o) => o && JSON.parse(o).decision === "block").length, 3, outs.join("\n"));
  void run;
});
