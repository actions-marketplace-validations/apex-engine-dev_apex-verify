import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readRegularFile, stateDir, writePrivateFile } from "./state.js";
import { checkersFrom, parseVerifyArgs, runVerify } from "./verify-cmd.js";
import { verify } from "./verify.js";
import { openAiClient } from "./openai-client.js";
import { renderText } from "./report.js";

/**
 * The agent's stop hook (Claude Code, Codex; Gemini CLI's AfterAgent hook uses the same JSON: it sends `prompt` instead of a transcript and treats decision "block" as a retry). The agent says "done"; this runs `apex verify` on what it changed and, when
 * the change is not ready, hands the reasons back so the agent keeps working instead of stopping.
 *
 * Input (stdin, JSON): { cwd, transcript_path, session_id, stop_hook_active }. Output (stdout, JSON): { decision: "block",
 * reason } to keep the agent working, or { systemMessage } to just tell the user. Exit code 0 either way.
 *
 * Safety valves: it never blocks more than APEX_HOOK_MAX_BLOCKS times per session (default 3, so a wrong checker cannot
 * trap an agent), APEX_MODE=warn never blocks, nothing runs when nothing changed, and an unchanged change is not
 * verified twice.
 */
export interface HookInput { cwd?: string; transcript_path?: string; session_id?: string; stop_hook_active?: boolean; /** Gemini CLI's AfterAgent hook: the user's request (it sends no transcript). */ prompt?: string;
  /** Cursor's stop hook: the project folders, the run's end state, and the conversation id (it sends no cwd). */
  workspace_roots?: string[]; status?: string; conversation_id?: string; hook_event_name?: string }

/** The last thing the person asked for, from the agent's transcript (JSON lines). */
export function lastUserPrompt(transcript: string): string {
  let last = "";
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    let j: any; try { j = JSON.parse(line); } catch { continue; }
    const m = j?.message ?? j;
    if ((j?.type ?? m?.role) !== "user" && m?.role !== "user" && j?.role !== "user") continue;
    if (j?.isMeta || j?.isSidechain) continue;
    const c = m?.content ?? j?.content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) text = c.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("\n");
    text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
    if (text && !text.startsWith("<command-") && !text.startsWith("Caveat:")) last = text;
  }
  return last;
}

/** A fingerprint of everything that differs from HEAD, or null when nothing does. NUL-separated git output, so file names with spaces or non-ASCII characters are read as they are, and untracked files are hashed by their bytes. */
export function changeFingerprint(cwd: string): string | null {
  try {
    execFileSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], { stdio: "pipe" });
    const raw = execFileSync("git", ["-C", cwd, "status", "--porcelain=v1", "-z", "-uall"], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 }).toString("utf8");
    const entries = raw.split("\0").filter(Boolean);
    if (!entries.length) return null;
    const diff = execFileSync("git", ["-C", cwd, "diff", "HEAD", "--no-ext-diff", "--binary"], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
    const untracked: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!, code = e.slice(0, 2), file = e.slice(3);
      if (code[0] === "R" || code[0] === "C") i++; // a rename or copy carries its old path as the next entry
      if (code === "??") { try { untracked.push(file + ":" + createHash("sha1").update(fs.readFileSync(path.join(cwd, file))).digest("hex")); } catch { untracked.push(file + ":unreadable"); } }
    }
    untracked.sort();
    return createHash("sha256").update(diff).update("\n" + untracked.join("\n")).digest("hex");
  } catch { return null; }
}

export async function runHook(stdin: string, env: NodeJS.ProcessEnv = process.env, out: (s: string) => void = console.log): Promise<number> {
  let input: HookInput = {};
  try { input = JSON.parse(stdin || "{}"); } catch { /* no input */ }
  // Cursor sends workspace_roots instead of cwd, and wants {followup_message} to keep the agent going (decision/reason is also sent).
  const cursor = Array.isArray(input.workspace_roots) || typeof input.conversation_id === "string";
  if (cursor && input.status && input.status !== "completed") return 0; // aborted or errored: nothing to verify
  input.session_id ||= input.conversation_id;
  const cwd = input.cwd || input.workspace_roots?.[0] || process.cwd();
  const block = (reason: string) => JSON.stringify(cursor ? { decision: "block", reason, followup_message: reason } : { decision: "block", reason });
  const fp = changeFingerprint(cwd);
  if (!fp) return 0; // nothing changed (or not a git repository): nothing to verify
  const state = path.join(stateDir(), "hook", (input.session_id || "session").replace(/[^\w.-]/g, "_").slice(0, 120) + ".json");
  let st: { fp?: string; verdict?: string; message?: string; blocks?: number } = {};
  try { const raw = readRegularFile(state); if (raw) st = JSON.parse(raw); } catch { /* first run */ }
  const maxBlocks = Number(env.APEX_HOOK_MAX_BLOCKS ?? 3);
  const warnOnly = env.APEX_MODE === "warn";
  const save = () => { try { writePrivateFile(state, JSON.stringify(st)); } catch { /* best effort */ } };

  if (st.fp === fp && st.verdict) { // the same change was already judged
    if (st.verdict === "ready") return 0;
    if (st.verdict === "not_ready" && !warnOnly && (st.blocks ?? 0) < maxBlocks && st.message) { st.blocks = (st.blocks ?? 0) + 1; save(); out(block(st.message)); }
    return 0;
  }
  const task = (input.transcript_path && fs.existsSync(input.transcript_path) ? lastUserPrompt(fs.readFileSync(input.transcript_path, "utf8")) : "") || (typeof input.prompt === "string" ? input.prompt.trim() : "") || env.APEX_TASK || "";
  if (!task) return 0;
  try {
    const a = parseVerifyArgs(["--task", task, "--dir", cwd, "--quiet", ...(env.APEX_NO_MODEL === "1" ? ["--no-model"] : []), ...(env.APEX_BASE ? ["--base", env.APEX_BASE] : [])], env);
    const { checker, secondChecker } = checkersFrom(a);
    const report = await verify({ dir: a.dir, task: a.task, base: a.base, checker, secondChecker, freshInputs: a.freshInputs, timeoutSec: a.timeoutSec });
    const text = renderText(report);
    const message = `Apex verify says this change is ${report.verdict === "not_ready" ? "NOT READY" : report.verdict.toUpperCase()}. Do not stop yet.\n\n${text}`;
    st = { fp, verdict: report.verdict, message, blocks: st.blocks ?? 0 }; // the counter belongs to the session, not to one version of the change
    if (report.verdict === "not_ready" && !warnOnly && (st.blocks ?? 0) < maxBlocks) { st.blocks = (st.blocks ?? 0) + 1; save(); out(block(message)); return 0; }
    save();
    out(JSON.stringify({ systemMessage: report.verdict === "ready" ? `Apex verify: READY (${report.checks.passed} checks, ${report.tests.after?.passed ?? 0} tests pass)` : `Apex verify: ${report.verdict === "not_ready" ? "NOT READY (not blocking: " + (warnOnly ? "warn mode" : "block limit reached") + ")" : "UNKNOWN"}: ${report.reasons[0]?.summary ?? report.warnings[0] ?? ""}` }));
  } catch (e) {
    out(JSON.stringify({ systemMessage: `Apex verify could not verify: ${e instanceof Error ? e.message : String(e)}` }));
  }
  return 0;
}
