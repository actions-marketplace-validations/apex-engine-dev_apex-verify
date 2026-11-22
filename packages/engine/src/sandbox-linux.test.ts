import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inTestSandbox, runCommand, testSandboxAvailable, testSandboxProfile } from "./test-runner.js";

/** Only on Linux with bubblewrap usable (CI installs it); elsewhere these are skipped, not faked. */
const linux = process.platform === "linux";
const sandboxed = async (cwd: string, script: string, extraWritable: string[] = []) => {
  const profile = testSandboxProfile({ writable: [cwd, ...extraWritable] });
  const cmd = inTestSandbox(profile, process.execPath, ["-e", script]);
  return runCommand(cmd.file, cmd.args, { cwd, timeoutMs: 30_000 });
};

test("linux: the test sandbox runs a command, writes inside the copy, and cannot write elsewhere", { skip: !linux }, async (t) => {
  if (!(await testSandboxAvailable())) { assert.notEqual(process.env.APEX_REQUIRE_SANDBOX, "1", "CI requires the sandbox to work"); return t.skip("bubblewrap is not usable here (unprivileged user namespaces disabled?)"); }
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "apex-sbx-"));
  const ok = await sandboxed(copy, `require("fs").writeFileSync(${JSON.stringify(path.join(copy, "x.txt"))}, "hi"); console.log("wrote")`);
  assert.equal(ok.failed, false, ok.stderr);
  assert.equal(fs.readFileSync(path.join(copy, "x.txt"), "utf8"), "hi");
  const target = path.join(process.cwd(), `apex-sbx-denied-${process.pid}.txt`);
  const bad = await sandboxed(copy, `try { require("fs").writeFileSync(${JSON.stringify(target)}, "no"); console.log("WROTE"); } catch (e) { console.log("denied"); }`);
  assert.match(bad.stdout, /denied/);
  assert.equal(fs.existsSync(target), false);
});

test("linux: tests can start and use a server on localhost inside the sandbox; nothing outside the machine is reachable", { skip: !linux }, async (t) => {
  if (!(await testSandboxAvailable())) { assert.notEqual(process.env.APEX_REQUIRE_SANDBOX, "1", "CI requires the sandbox to work"); return t.skip("bubblewrap is not usable here"); }
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "apex-sbx-"));
  // A test suite starts its own server and talks to it: that must work inside the sandbox (the sandbox has its own loopback).
  const local = await sandboxed(copy, `const net = require("net"); const srv = net.createServer((s) => s.end("pong")).listen(0, "127.0.0.1", () => { const c = net.connect(srv.address().port, "127.0.0.1"); c.on("data", (d) => { console.log("local:" + d); process.exit(0); }); c.on("error", () => { console.log("local:error"); process.exit(0); }); }); setTimeout(() => { console.log("local:timeout"); process.exit(0); }, 8000);`);
  assert.match(local.stdout, /local:pong/, "a server started inside the sandbox must be reachable on localhost: " + local.stdout + local.stderr);
  // Anything outside the machine, and the host's own services, are not reachable.
  const out = await sandboxed(copy, `const s = require("net").connect(53, "1.1.1.1"); s.on("connect", () => { console.log("net:CONNECTED"); process.exit(0); }); s.on("error", () => { console.log("net:blocked"); process.exit(0); }); setTimeout(() => { console.log("net:blocked"); process.exit(0); }, 5000);`);
  assert.match(out.stdout, /net:blocked/);
});

test("the profile is a bwrap spec on Linux and an sbpl profile elsewhere", () => {
  const p = testSandboxProfile({ writable: [os.tmpdir()] });
  if (linux) assert.ok(p.startsWith("bwrap:")); else assert.ok(p.includes("(version 1)"));
});
