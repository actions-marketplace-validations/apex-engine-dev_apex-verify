import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseVerifyArgs, runVerify } from "./verify-cmd.js";
import { verify } from "./verify.js";
import { openAiClient } from "./openai-client.js";
import { renderText } from "./report.js";

/**
 * The agent's stop hook (Claude Code, Codex). The agent says "done"; this runs `apex verify` on what it changed and, when
 * the change is not ready, hands the reasons back so the agent keeps working instead of stopping.
 *
 * Input (stdin, JSON): { cwd, transcript_path, session_id, stop_hook_active }. Output (stdout, JSON): { decision: "block",
 * reason } to keep the agent working, or { systemMessage } to just tell the user. Exit code 0 either way.
 *
 * Safety valves: it never blocks more than APEX_HOOK_MAX_BLOCKS times per session (default 3, so a wrong checker cannot
 * trap an agent), APEX_MODE=warn never blocks, nothing runs when nothing changed, and an unchanged change is not
 * verified twice.
 */
export interface HookInput { cwd?: string; transcript_path?: string; session_id?: string; stop_hook_active?: boolean }

/** The last thing the person asked for, from the agent's transcript (JSON lines). */
export function lastUserPrompt(transcript: string): string {
  let last = "";
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    let j: any; try { j = JSON.parse(line); } catch { continue; }
    const m = j?.message ?? j;
    if ((j?.type ?? m?.role) !== "user" && m?.role !== "user") continue;
    if (j?.isMeta || j?.isSidechain) continue;
    const c = m?.content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) text = c.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("\n");
    text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
    if (text && !text.startsWith("<command-") && !text.startsWith("Caveat:")) last = text;
  }
  return last;
}

function changeFingerprint(cwd: string): string | null {
  try {
    execFileSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], { stdio: "pipe" });
    const status = execFileSync("git", ["-C", cwd, "status", "--porcelain=v1", "-uall"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (!status.trim()) return null;
    const diff = execFileSync("git", ["-C", cwd, "diff", "HEAD"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const untracked = status.split("\n").filter((l) => l.startsWith("??")).map((l) => l.slice(3)).sort().map((f) => { try { return f + ":" + createHash("sha1").update(fs.readFileSync(path.join(cwd, f))).digest("hex"); } catch { return f; } });
    return createHash("sha256").update(diff + "\n" + untracked.join("\n")).digest("hex");
  } catch { return null; }
}

export async function runHook(stdin: string, env: NodeJS.ProcessEnv = process.env, out: (s: string) => void = console.log): Promise<number> {
  let input: HookInput = {};
  try { input = JSON.parse(stdin || "{}"); } catch { /* no input */ }
  const cwd = input.cwd || process.cwd();
  const fp = changeFingerprint(cwd);
  if (!fp) return 0; // nothing changed (or not a git repository): nothing to verify
  const state = path.join(os.tmpdir(), "apex-hook", (input.session_id || "session").replace(/[^\w.-]/g, "_") + ".json");
  let st: { fp?: string; verdict?: string; message?: string; blocks?: number } = {};
  try { st = JSON.parse(fs.readFileSync(state, "utf8")); } catch { /* first run */ }
  const maxBlocks = Number(env.APEX_HOOK_MAX_BLOCKS ?? 3);
  const warnOnly = env.APEX_MODE === "warn";
  const save = () => { try { fs.mkdirSync(path.dirname(state), { recursive: true }); fs.writeFileSync(state, JSON.stringify(st)); } catch { /* best effort */ } };

  if (st.fp === fp && st.verdict) { // the same change was already judged
    if (st.verdict === "ready") return 0;
    if (st.verdict === "not_ready" && !warnOnly && (st.blocks ?? 0) < maxBlocks && st.message) { st.blocks = (st.blocks ?? 0) + 1; save(); out(JSON.stringify({ decision: "block", reason: st.message })); }
    return 0;
  }
  const task = (input.transcript_path && fs.existsSync(input.transcript_path) ? lastUserPrompt(fs.readFileSync(input.transcript_path, "utf8")) : "") || env.APEX_TASK || "";
  if (!task) return 0;
  try {
    const a = parseVerifyArgs([task, "--dir", cwd, "--quiet", ...(env.APEX_NO_MODEL === "1" ? ["--no-model"] : []), ...(env.APEX_BASE ? ["--base", env.APEX_BASE] : [])], env);
    const checker = a.noModel ? null : { client: openAiClient({ baseUrl: a.baseUrl, apiKey: a.apiKey }), model: a.model! };
    const report = await verify({ dir: a.dir, task: a.task, base: a.base, checker, timeoutSec: a.timeoutSec });
    const text = renderText(report);
    const message = `Apex verify says this change is ${report.verdict === "not_ready" ? "NOT READY" : report.verdict.toUpperCase()}. Do not stop yet.\n\n${text}`;
    st = { fp, verdict: report.verdict, message, blocks: st.fp === fp ? st.blocks ?? 0 : 0 };
    if (report.verdict === "not_ready" && !warnOnly && (st.blocks ?? 0) < maxBlocks) { st.blocks = (st.blocks ?? 0) + 1; save(); out(JSON.stringify({ decision: "block", reason: message })); return 0; }
    save();
    out(JSON.stringify({ systemMessage: report.verdict === "ready" ? `Apex verify: READY (${report.checks.passed} checks, ${report.tests.after?.passed ?? 0} tests pass)` : `Apex verify: ${report.verdict === "not_ready" ? "NOT READY (not blocking: " + (warnOnly ? "warn mode" : "block limit reached") + ")" : "UNKNOWN"}: ${report.reasons[0]?.summary ?? report.warnings[0] ?? ""}` }));
  } catch (e) {
    out(JSON.stringify({ systemMessage: `Apex verify could not verify: ${e instanceof Error ? e.message : String(e)}` }));
  }
  return 0;
}
