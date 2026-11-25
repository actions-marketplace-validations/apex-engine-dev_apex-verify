import fs from "node:fs/promises";
import path from "node:path";
import { inTestSandbox, runCommand, runEnv, testSandboxAvailable, testSandboxProfile, type ModelClient } from "apex-verify-engine";
import type { Reason } from "./verify.js";

/**
 * Experiment (APEX_EXP_KEEP=1): did the change keep the behaviour the task did not ask to change?
 * The checker writes one probe script that calls code which already existed, on inputs the task is not about. The script
 * runs on the old and the new code; lines that differ (and are stable on the old code) go to a second look that decides
 * whether the task asked for that difference. Only JavaScript projects (ES modules or CommonJS .js/.mjs/.cjs).
 */
export interface KeptInput { client: ModelClient; model: string; task: string; oldDir: string; newDir: string; changes: { path: string; before: string | null; after: string | null }[]; signal?: AbortSignal; timeoutSec: number }

const msg = (role: "system" | "user", content: string) => ({ id: role, role, content, createdAt: new Date(0).toISOString() });

async function ask(c: KeptInput, system: string, user: string): Promise<string> {
  let text = "";
  for await (const ev of c.client.stream({ messages: [msg("system", system), msg("user", user)], tools: [], model: c.model, temperature: 0.2, maxTokens: 6000, signal: c.signal, purpose: "kept-behaviour" })) {
    if (ev.type === "text-delta") text += ev.text;
    if (ev.type === "error") throw new Error(ev.message);
  }
  return text;
}

const codeBlock = (t: string) => (t.match(/```(?:js|javascript|mjs)?\s*\n([\s\S]*?)```/) ?? [])[1] ?? "";

async function runProbe(dir: string, code: string, c: KeptInput): Promise<string[]> {
  const file = path.join(dir, ".apex-kept.mjs");
  await fs.writeFile(file, code);
  try {
    let cmd = process.execPath, args = [file];
    if (await testSandboxAvailable().catch(() => false)) ({ file: cmd, args } = inTestSandbox(testSandboxProfile({ writable: [dir] }), cmd, args));
    const r = await runCommand(cmd, args, { cwd: dir, env: runEnv(), timeoutMs: Math.min(c.timeoutSec, 60) * 1000, signal: c.signal });
    return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  } finally { await fs.rm(file, { force: true }); }
}

export async function keptBehaviour(c: KeptInput): Promise<{ calls: number; reason: Reason | null } | null> {
  const old = c.changes.filter((x) => x.before !== null && /\.(m|c)?js$/.test(x.path) && !/(^|\/)(test|tests|__tests__)\/|\.test\.|\.spec\./.test(x.path));
  if (!old.length) return null;
  const sources = old.map((x) => `--- ${x.path} (before the change)\n${x.before!.slice(0, 12000)}`).join("\n\n");
  const probeText = await ask(c, "You write one short probe script; you never change the project.",
    `<task>\n${c.task.slice(0, 2000)}\n</task>\n\n${sources}\n\nThe task above was given to a coding agent. Write an ES module script, run from the project folder, that imports the functions and classes that ALREADY exist in the files above (relative imports like "./src/x.js") and exercises the behaviour the task does NOT ask to change: return values, errors thrown, what methods return, edge cases of existing features. Skip anything the task asks to add, fix or change. 8 to 15 calls. Use fixed inputs and dates, never Date.now() or random. Wrap each call in try/catch and print exactly one line per call: console.log(LABEL + " => " + JSON.stringify(result)) or console.log(LABEL + " => throws " + e.name), where LABEL is a short fixed description of the call. Answer with one \`\`\`js block only.`);
  const code = codeBlock(probeText);
  if (!code.trim()) return { calls: 1, reason: null };
  const before1 = await runProbe(c.oldDir, code, c), before2 = await runProbe(c.oldDir, code, c), after = await runProbe(c.newDir, code, c);
  if (!before1.length) return { calls: 1, reason: null };
  const stable = new Set(before1.filter((l) => before2.includes(l)));
  const diffs: string[] = [];
  const label = (l: string) => l.split(" => ")[0]!;
  for (const b of stable) {
    if (after.includes(b)) continue;
    const a = after.find((l) => label(l) === label(b));
    diffs.push(`${label(b)}\n  before: ${b.slice(label(b).length + 4)}\n  after:  ${a ? a.slice(label(b).length + 4) : "(no output)"}`);
  }
  if (!diffs.length) return { calls: 1, reason: null };
  const judge = await ask(c, "You judge whether a behaviour change was requested. Answer in JSON only.",
    `<task>\n${c.task.slice(0, 2000)}\n</task>\n\nA probe called code that existed before the change, on the old and the new version. These results differ:\n\n${diffs.slice(0, 12).join("\n\n")}\n\nFor each difference, did the task ask for it (directly, or as a necessary consequence of what it asks)? A difference that fixes what the task describes is requested. Answer {"unrequested": [indexes from 0 of differences the task did not ask for], "reason": "one sentence"}.`);
  let un: number[] = [], why = "";
  try { const j = JSON.parse(judge.slice(judge.indexOf("{"), judge.lastIndexOf("}") + 1)); un = (j.unrequested ?? []).filter((i: unknown) => Number.isInteger(i) && (i as number) >= 0 && (i as number) < diffs.length); why = String(j.reason ?? ""); } catch { return { calls: 2, reason: null }; }
  if (!un.length) return { calls: 2, reason: null };
  return { calls: 2, reason: { kind: "check_failed", summary: `the change also altered ${un.length} behaviour${un.length === 1 ? "" : "s"} the task did not ask to change`, evidence: `${un.map((i) => diffs[i]).join("\n\n")}${why ? `\n\n${why}` : ""}`.slice(0, 1800), hint: "Keep the existing behaviour the task did not ask to change, or say in the task that it should change." } };
}
