import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ModelEvent } from "apex-verify-engine";
import { cliArgs, cliClient, flattenPrompt, onPath, parseCliOutput, type CliKind } from "./cli-client.js";
import { checkersFrom, parseVerifyArgs } from "./verify-cmd.js";
import { runHook } from "./hook.js";

const msg = (role: "system" | "user" | "assistant", content: string) => ({ id: role, role, content, createdAt: "" });

/** A stand-in CLI: records its arguments, stdin, working folder and environment, and prints the JSON the real CLI prints. */
function fakeCli(kind: CliKind, answer: string): { spawnImpl: typeof spawn; seen: () => any } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apex-fakecli-"));
  const log = path.join(dir, "seen.json");
  const out = kind === "claude-cli"
    ? { type: "result", is_error: false, result: answer, usage: { input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 7 } }
    : { response: answer, stats: { models: { a: { tokens: { prompt: 11, candidates: 3 } }, b: { tokens: { prompt: 4, candidates: 2 } } } } };
  const script = path.join(dir, "cli.js");
  fs.writeFileSync(script, `let i="";process.stdin.on("data",d=>i+=d).on("end",()=>{require("fs").writeFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),stdin:i,cwd:process.cwd(),inChecker:process.env.APEX_IN_CHECKER,sys:process.env.GEMINI_SYSTEM_MD&&require("fs").readFileSync(process.env.GEMINI_SYSTEM_MD,"utf8")}));process.stdout.write("warning line\\n"+${JSON.stringify(JSON.stringify(out))});});`);
  const spawnImpl = ((_cmd: string, args: string[], opts: any) => spawn(process.execPath, [script, ...args], { ...opts, shell: false })) as unknown as typeof spawn;
  return { spawnImpl, seen: () => JSON.parse(fs.readFileSync(log, "utf8")) };
}

async function collect(it: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const ev: ModelEvent[] = [];
  for await (const e of it) ev.push(e);
  return ev;
}

test("claude-cli: tools off, no settings or MCP, system prompt passed, answer and tokens read", async () => {
  const f = fakeCli("claude-cli", "```js\ntest()\n```");
  const ev = await collect(cliClient({ kind: "claude-cli", spawnImpl: f.spawnImpl }).stream({ messages: [msg("system", "You write checks."), msg("user", "task: slugify")], tools: [], model: "claude-cli" }));
  const s = f.seen();
  assert.deepEqual(s.args.slice(0, 9), ["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence"]);
  assert.ok(s.args.includes("--system-prompt") && s.args.includes("You write checks."));
  assert.ok(!s.args.includes("--model"), "the placeholder model name is not passed on");
  assert.equal(s.stdin, "task: slugify");
  assert.ok(path.basename(s.cwd).startsWith("apex-checker-"), "runs in a fresh empty folder, not the project");
  assert.ok(!fs.existsSync(s.cwd), "the folder is removed afterwards");
  assert.equal(s.inChecker, "1");
  assert.deepEqual(ev.find((e) => e.type === "usage"), { type: "usage", inputTokens: 15, outputTokens: 7 });
  assert.deepEqual(ev.find((e) => e.type === "message-complete"), { type: "message-complete", message: { content: "```js\ntest()\n```" } });
});

test("gemini-cli: our instructions replace its agent prompt (GEMINI_SYSTEM_MD), a real model id is passed, tokens summed over models", async () => {
  const f = fakeCli("gemini-cli", "ok");
  const ev = await collect(cliClient({ kind: "gemini-cli", spawnImpl: f.spawnImpl }).stream({ messages: [msg("system", "SYS"), msg("user", "U")], tools: [], model: "gemini-3-flash-preview" }));
  const s = f.seen();
  assert.equal(s.stdin, "U");
  assert.equal(s.sys, "SYS");
  assert.deepEqual(s.args.slice(-2), ["-m", "gemini-3-flash-preview"]);
  assert.ok(s.args.includes("-e") && s.args.includes("none"), "no extensions");
  assert.deepEqual(ev.find((e) => e.type === "usage"), { type: "usage", inputTokens: 15, outputTokens: 5 });
});

test("CLI errors and a missing CLI become error events, never an answer", async () => {
  assert.match(parseCliOutput("claude-cli", '{"is_error":true,"result":"Not logged in"}').error!, /Not logged in/);
  assert.match(parseCliOutput("gemini-cli", '{"error":{"message":"quota"}}').error!, /quota/);
  assert.match(parseCliOutput("gemini-cli", "not json").error!, /could not read/);
  assert.match(parseCliOutput("gemini-cli", '{"error":{"type":"Error","message":"When using Gemini API, you must specify the GEMINI_API_KEY environment variable.","code":41}}').error!, /GEMINI_API_KEY/);
  const ev = await collect(cliClient({ kind: "claude-cli", command: "apex-no-such-cli-xyz" }).stream({ messages: [msg("user", "x")], tools: [] }));
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.type, "error");
});

test("flattenPrompt labels earlier turns when there is more than one", () => {
  assert.equal(flattenPrompt({ messages: [msg("user", "a"), msg("assistant", "b"), msg("user", "c")], tools: [] }).prompt, "[user]\na\n\n[assistant]\nb\n\n[user]\nc");
  assert.deepEqual(cliArgs("claude-cli", "opus", ""), ["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", "--model", "opus"]);
});

test("no key and no provider: a signed-in CLI on PATH is used; Gemini CLI first; a key or an explicit provider wins", () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "apex-path-"));
  const exe = process.platform === "win32" ? ".EXE" : "";
  fs.writeFileSync(path.join(bin, "claude" + exe), "");
  const env = { PATH: bin, PATHEXT: ".EXE", HOME: path.join(bin, "nohome") };
  assert.ok(onPath("claude", env) && !onPath("gemini", env));
  let a = parseVerifyArgs(["do it"], env);
  assert.equal(a.cli, "claude-cli");
  assert.equal(checkersFrom(a).checker!.model, "claude-cli");
  fs.writeFileSync(path.join(bin, "gemini" + exe), "");
  assert.equal(parseVerifyArgs(["do it"], env).cli, "claude-cli", "Gemini CLI with no Google sign-in would need a key too");
  fs.mkdirSync(path.join(bin, ".gemini"));
  fs.writeFileSync(path.join(bin, ".gemini", "settings.json"), JSON.stringify({ security: { auth: { selectedType: "gemini-api-key" } } }));
  assert.equal(parseVerifyArgs(["do it"], { ...env, HOME: bin }).cli, "claude-cli");
  fs.writeFileSync(path.join(bin, ".gemini", "settings.json"), JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } } }));
  assert.equal(parseVerifyArgs(["do it"], { ...env, HOME: bin }).cli, "gemini-cli");
  assert.equal(parseVerifyArgs(["do it", "--provider", "claude-cli", "--model", "opus"], env).model, "opus");
  assert.equal(parseVerifyArgs(["do it"], { ...env, GEMINI_API_KEY: "k" }).cli, undefined);
  assert.throws(() => parseVerifyArgs(["do it", "--provider", "openai"], env), /OPENAI_API_KEY/);
  assert.equal(parseVerifyArgs(["do it", "--no-model"], env).cli, undefined);
  assert.throws(() => parseVerifyArgs(["do it"], { PATH: "" }), /GEMINI_API_KEY/);
  for (const e of [env, { ...env, HOME: bin }]) assert.equal(parseVerifyArgs(["do it"], { ...e, APEX_PROVIDER: "gemini", GEMINI_API_KEY: "k" }).cli, undefined);
});

test("the hook does nothing inside a CLI checker's own run, so it cannot loop", async () => {
  let printed = "";
  assert.equal(await runHook(JSON.stringify({ cwd: os.tmpdir(), prompt: "x" }), { APEX_IN_CHECKER: "1" }, (s) => (printed += s)), 0);
  assert.equal(printed, "");
});
