// node refcheck.mjs <cacheDir> <benchmarkDir> <task> <change>: run the cached generated checks on the upstream reference fix and on the change.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import crypto from "node:crypto"; import { execFileSync } from "node:child_process";
const eng = await import(path.resolve("work/packages/engine/dist/index.js"));
const [cache, B, task, change] = process.argv.slice(2);
const key = crypto.createHash("sha1").update(task + change).digest("hex").slice(0, 8);
const dir = path.join(cache, key, "checks"); const f = fs.readdirSync(dir)[0];
const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const mk = (kind) => { const t = fs.mkdtempSync(path.join(os.tmpdir(), "refchk-")); fs.cpSync(path.join(B, "tasks", task, "project"), t, { recursive: true });
  if (kind === "reference") fs.cpSync(path.join(B, "tasks", task, "reference"), t, { recursive: true });
  if (kind === "change") execFileSync("git", ["apply", "-p1", path.join(B, "changes", task, change + ".diff")], { cwd: t });
  return t; };
const out = { task, change };
for (const kind of ["project", "reference", "change"]) {
  const t = mk(kind);
  const run = d.run ?? ["node", "--test", d.path];
  const r = await eng.runAcceptance(t, { path: d.path, code: d.code, run, py: false }, undefined, 90);
  const fails = eng.parseTestOutcomes(r.output ?? "").filter((x) => !x.ok && !x.skipped).map((x) => x.name + (x.failure?.message ? " :: " + String(x.failure.message).split("\n")[0].slice(0, 160) : ""));
  out[kind] = { passed: r.passed, failed: r.failed, loadError: r.loadError, fails };
  fs.rmSync(t, { recursive: true, force: true });
}
if (process.argv.includes("--code")) out.code = d.code;
console.log(JSON.stringify(out, null, 1));
