#!/usr/bin/env node
// Logging wrapper around `apex verify --hook`. Args: <dataDir> <arm B|C> <path to apex.mjs>
// On every call: snapshot the working tree, save stdin/stdout, and (arm C) withhold the details of a block.
import fs from "node:fs"; import path from "node:path"; import { spawnSync, execFileSync } from "node:child_process";
const [dataDir, arm, apex] = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
let input = {}; try { input = JSON.parse(stdin); } catch {}
const cwd = input.cwd || process.cwd();
const snaps = path.join(dataDir, "snaps"); fs.mkdirSync(snaps, { recursive: true });
const n = fs.readdirSync(snaps).filter((x) => /^\d+$/.test(x)).length + 1;
const dir = path.join(snaps, String(n).padStart(2, "0")); fs.mkdirSync(dir);
const SKIP = new Set([".git", ".gemini", "node_modules", ".apex-tmp"]);
fs.cpSync(cwd, path.join(dir, "tree"), { recursive: true, filter: (s) => !SKIP.has(path.basename(s)) });
const git = (a) => { try { return execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", maxBuffer: 1 << 28 }); } catch (e) { return "ERR " + e.message; } };
fs.writeFileSync(path.join(dir, "diff.patch"), git(["diff", "HEAD", "--binary"]));
fs.writeFileSync(path.join(dir, "status.txt"), git(["status", "--porcelain=v1", "-uall"]));
fs.writeFileSync(path.join(dir, "stdin.json"), stdin);
const t0 = Date.now();
const r = spawnSync("node", [apex, "verify", "--hook"], { input: stdin, encoding: "utf8", cwd, maxBuffer: 1 << 28,
  env: { ...process.env, APEX_STATE_DIR: path.join(dataDir, "state"), APEX_CACHE_DIR: path.join(dataDir, "cache") } });
let out = r.stdout || "";
fs.writeFileSync(path.join(dir, "stdout.raw.json"), out);
fs.writeFileSync(path.join(dir, "hook.meta.json"), JSON.stringify({ exit: r.status, signal: r.signal, seconds: (Date.now() - t0) / 1000, stderr: (r.stderr || "").slice(-4000) }));
if (arm === "C") {
  try {
    const j = JSON.parse(out);
    if (j.decision === "block") {
      const lines = String(j.reason).split("\n");
      const summaries = lines.filter((l) => /^  - /.test(l)).map((l) => l.trim());
      const names = lines.map((l) => /^\s*check: (.*)$/.exec(l)?.[1]).filter(Boolean);
      j.reason = ["Apex verify says this change is NOT READY. Do not stop yet.", "", ...summaries,
        ...(names.length ? ["", "Failing checks:", ...names.map((x) => `  - ${x}`)] : [])].join("\n");
      out = JSON.stringify(j) + "\n";
    }
  } catch {}
}
fs.writeFileSync(path.join(dir, "stdout.shown.json"), out);
process.stdout.write(out);
