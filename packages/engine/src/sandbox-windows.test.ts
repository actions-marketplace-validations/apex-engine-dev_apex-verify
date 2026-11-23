import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { runEnv } from "./surgical.js";
import { inTestSandbox, runCommand, testSandboxAvailable, testSandboxProfile } from "./test-runner.js";

/**
 * The Windows AppContainer sandbox must actually isolate: writes outside the copy denied, the user profile unreadable,
 * the network (including localhost) denied. Only on Windows. With APEX_REQUIRE_SANDBOX=1 (CI) an unusable sandbox fails
 * the test instead of skipping it.
 */
const win = process.platform === "win32";
const skip = !win;
const must = process.env.APEX_REQUIRE_SANDBOX === "1";

async function inSandbox(js: string): Promise<{ code: number | null; out: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apex-wsb-t-"));
  const { file, args } = inTestSandbox(testSandboxProfile({ writable: [dir] }), process.execPath, ["-e", js]);
  const r = await runCommand(file, args, { cwd: dir, env: runEnv(), timeoutMs: 90_000 });
  return { code: r.exitCode, out: r.stdout + r.stderr };
}

test("windows sandbox: available, exit code and output come through, writes inside the copy work", { skip }, async () => {
  const ok = await testSandboxAvailable();
  if (!ok && !must) return;
  assert.equal(ok, true, "AppContainer sandbox unusable on this runner");
  const r = await inSandbox('require("fs").writeFileSync("a.txt","hi");console.log("hello-"+require("fs").readFileSync("a.txt","utf8"));process.exit(7)');
  assert.equal(r.code, 7, r.out);
  assert.match(r.out, /hello-hi/);
});

test("windows sandbox: writing outside the copy and reading the user profile are denied", { skip }, async () => {
  if (!(await testSandboxAvailable())) { assert.equal(must, false, "AppContainer sandbox unusable on this runner"); return; }
  const secret = path.join(os.homedir(), `.apex-secret-${process.pid}.txt`);
  fs.writeFileSync(secret, "top secret");
  const outside = path.join(os.homedir(), `.apex-escape-${process.pid}.txt`);
  try {
    const w = await inSandbox(`try{require("fs").writeFileSync(${JSON.stringify(outside)},"x");console.log("WROTE")}catch(e){console.log("DENIED")}`);
    assert.match(w.out, /DENIED/, w.out);
    assert.equal(fs.existsSync(outside), false);
    const r = await inSandbox(`try{console.log("READ "+require("fs").readFileSync(${JSON.stringify(secret)},"utf8"))}catch(e){console.log("DENIED")}`);
    assert.match(r.out, /DENIED/, r.out);
    assert.doesNotMatch(r.out, /top secret/);
  } finally { fs.rmSync(secret, { force: true }); fs.rmSync(outside, { force: true }); }
});

test("windows sandbox: no network, not even localhost", { skip }, async () => {
  if (!(await testSandboxAvailable())) { assert.equal(must, false, "AppContainer sandbox unusable on this runner"); return; }
  const server = net.createServer((s) => s.end("up")).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as net.AddressInfo).port;
  try {
    const code = `const s=require("net").connect(${port},"127.0.0.1");s.on("data",()=>{console.log("CONNECTED");process.exit(0)});s.on("error",()=>{console.log("BLOCKED");process.exit(0)});setTimeout(()=>{console.log("BLOCKED");process.exit(0)},8000)`;
    const r = await inSandbox(code);
    assert.match(r.out, /BLOCKED/, r.out);
    const ext = await inSandbox(`const s=require("net").connect(443,"1.1.1.1");s.on("connect",()=>{console.log("CONNECTED");process.exit(0)});s.on("error",()=>{console.log("BLOCKED");process.exit(0)});setTimeout(()=>{console.log("BLOCKED");process.exit(0)},8000)`);
    assert.match(ext.out, /BLOCKED/, ext.out);
  } finally { server.close(); }
});

test("windows sandbox: the environment is scrubbed of keys and the wrapper script is well formed", { skip }, async () => {
  if (!(await testSandboxAvailable())) { assert.equal(must, false, "AppContainer sandbox unusable on this runner"); return; }
  const r = await inSandbox('console.log("KEYS:"+Object.keys(process.env).filter((k)=>/KEY|TOKEN|SECRET/i.test(k)).length)');
  assert.match(r.out, /KEYS:0/, r.out);
});

test("windows sandbox: arguments with & ^ % ( ) and spaces reach the program as they were given", { skip }, async () => {
  if (!(await testSandboxAvailable())) { assert.equal(must, false, "AppContainer sandbox unusable on this runner"); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apex-wsb-q-"));
  const given = ["a&b", "x^y", "100%PATH%", "c d", "(e)", "f|g", "h<i>j", 'say "hi"'];
  const { file, args } = inTestSandbox(testSandboxProfile({ writable: [dir] }), process.execPath, ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", ...given]);
  const r = await runCommand(file, args, { cwd: dir, env: runEnv(), timeoutMs: 90_000 });
  assert.deepEqual(JSON.parse(r.stdout.trim().split("\n").pop()!), given, r.stdout + r.stderr);
});
