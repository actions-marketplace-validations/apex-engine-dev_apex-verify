#!/usr/bin/env node
// Re-measure the gate: run `apex verify` on every labelled AI-written change in benchmark/changes and report how many wrong
// changes it blocks and how many right ones it wrongly blocks.
//
//   node benchmark/run-gate.mjs --no-model                                   # tests + cheating scan only (free, no key)
//   GEMINI_API_KEY=... node benchmark/run-gate.mjs --model gemini-3.1-pro-preview [--limit 40] [--task slugify] [--concurrency 3]
//
// Extra flags after "--" go to `apex verify` (for example: -- --provider openai --model gpt-...).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const run = promisify(execFile);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const CLI = [path.join(HERE, "..", "dist", "apex.mjs"), path.join(HERE, "..", "packages", "cli", "dist", "main.js")].find((p) => fs.existsSync(p));
if (!CLI) { console.error("build first: npm install (the prepare step builds dist/apex.mjs)"); process.exit(2); }

const argv = process.argv.slice(2);
const dd = argv.indexOf("--");
const own = dd < 0 ? argv : argv.slice(0, dd), pass = dd < 0 ? [] : argv.slice(dd + 1);
const flag = (n, d) => { const i = own.indexOf(`--${n}`); return i < 0 ? d : own[i + 1]; };
const noModel = own.includes("--no-model");
const limit = Number(flag("limit", 0)), onlyTask = flag("task", ""), conc = Number(flag("concurrency", 3));
const model = flag("model", "");
const verifyArgs = noModel ? ["--no-model"] : model ? ["--model", model] : [];

let items = JSON.parse(fs.readFileSync(path.join(HERE, "changes", "manifest.json"), "utf8"));
if (onlyTask) items = items.filter((m) => m.task === onlyTask);
if (limit) { // balanced: half right, half wrong
  const right = items.filter((m) => m.correct), wrong = items.filter((m) => !m.correct), h = Math.ceil(limit / 2);
  items = [...right.slice(0, h), ...wrong.slice(0, h)];
}
const prompt = (t) => JSON.parse(fs.readFileSync(path.join(HERE, "tasks", t, "task.json"), "utf8")).prompt;
const cache = fs.mkdtempSync(path.join(os.tmpdir(), "apex-bench-cache-")); // a fresh draft of the checks for every change
console.error(`${items.length} changes; ${noModel ? "no model" : `checker ${model || "(default)"}`}; cli ${path.relative(process.cwd(), CLI)}`);

let i = 0, done = 0;
const results = [];
await Promise.all(Array.from({ length: conc }, async () => {
  while (i < items.length) {
    const it = items[i++];
    const key = crypto.createHash("sha1").update(it.task + it.change).digest("hex").slice(0, 8);
    let verdict = "error";
    try {
      const r = await run(process.execPath, [CLI, prompt(it.task), "--dir", path.join(HERE, "tasks", it.task, "project"), "--diff", path.join(HERE, "changes", it.task, `${it.change}.diff`), "--format", "json", ...verifyArgs, ...pass], { env: { ...process.env, APEX_CACHE_DIR: path.join(cache, key) }, maxBuffer: 32 << 20 });
      verdict = JSON.parse(r.stdout).verdict;
    } catch (e) { try { verdict = JSON.parse(e.stdout).verdict; } catch { verdict = "error"; } }
    results.push({ ...it, verdict });
    console.error(`[${++done}/${items.length}] ${it.task}:${it.change} correct=${it.correct} -> ${verdict}`);
  }
}));

const wilson = (k, n) => { if (!n) return [0, 0]; const p = k / n, z = 1.96, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d; return [Math.round(100 * (c - h)), Math.round(100 * (c + h))]; };
const ok = results.filter((r) => r.verdict !== "error");
const wrong = ok.filter((r) => !r.correct), right = ok.filter((r) => r.correct);
const count = (xs, v) => xs.filter((r) => r.verdict === v).length;
const caught = count(wrong, "not_ready"), alarms = count(right, "not_ready"), ready = ok.filter((r) => r.verdict === "ready");
console.log(`\n${ok.length} changes judged (${right.length} right, ${wrong.length} wrong), ${results.length - ok.length} errors`);
console.log(`wrong changes blocked:         ${caught}/${wrong.length} = ${Math.round(100 * caught / Math.max(wrong.length, 1))}%  (95% CI ${wilson(caught, wrong.length).join("-")}%)`);
console.log(`right changes wrongly blocked: ${alarms}/${right.length} = ${Math.round(100 * alarms / Math.max(right.length, 1))}%  (95% CI ${wilson(alarms, right.length).join("-")}%)`);
if (ready.length) console.log(`READY verdicts that were right: ${ready.filter((r) => r.correct).length}/${ready.length}`);
console.log(`unknown: wrong ${count(wrong, "unknown")}, right ${count(right, "unknown")}`);
const out = flag("out", "");
if (out) fs.writeFileSync(out, JSON.stringify(results, null, 1));
