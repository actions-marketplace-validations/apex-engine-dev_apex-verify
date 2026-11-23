import { existsSync } from "node:fs";
import { checkCommand, inTestSandbox, readTestOutput, runCommand, testSandboxAvailable, testSandboxProfile } from "./test-runner.js";
import { bugEdgeChecks, coverageGate, exportParams, implicitCheckTap, missingExports, namedExports, outOfScope, requestOnly, requestRules, requestScope, resolveImports, securityFlags } from "./mechanical.js";
import { execFile } from "node:child_process";
import { promises as fs, constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
const execFileP = promisify(execFile);
import type { EventSink, ModelClient, ModelEvent, ModelMessage } from "./model.js";
import { engineSettings, type EngineOptions, CHECKS_BUDGET, GRAPH_CHECKS_THINKING, GRAPH_EDIT_THINKING, SCOPED_BUDGET, SECRET_PLACEHOLDER_MARK, graphThinking, slimChecksContext } from "./options.js";
import { fsWorkspace, listFiles, taskPackProvider, type TaskPackProvider, type Workspace } from "./workspace.js";
export { CHECKS_BUDGET, GRAPH_CHECKS_THINKING, GRAPH_EDIT_THINKING, SCOPED_BUDGET, graphThinking, slimChecksContext, listFiles };
import { cachedGraph, graphScope, isTestPath, type CodeGraph } from "./graph.js";
import { enclosingSymbol, renderRanges, scopedContext, scopeWords, shortOutline, withLead, wordRe, type Segments } from "./scoped-context.js";
import { outline } from "./symbols.js";
import { MASKED_SECRET_EDIT } from "./edit-match.js";
import { hasTrace } from "./trace.js";
import { screenChecks, selfExcludingChecks, splitQuote, traceCheckLines, SELF_EXCLUSION_HINT, type DroppedCheck } from "./check-screen.js";
import { adjudicate, checkResults, checksLoadError, checksVerdict, keyedOutcomes, missingCheckTests, parseTestOutcomes, passedKeys, provenKeys, splitAssumed, testKey, failureCounts, UNPROVEN_MESSAGE, type CheckProof, type CheckResult } from "./check-results.js";

/**
 * Surgical best-of-N: Apex compiles the context, the model answers in one call per candidate, tests pick the winner.
 *
 * Built for engines where a long agent loop is slow (a slow engine streaming a large model from disk) but works with any
 * provider: no tools, no multi-turn exploration. Each candidate is one request for search/replace edits. Candidates
 * run in parallel (on such an engine, separate cache slots, decoded as one batch), each is applied to a scratch copy of the
 * project and its test suite runs there. The best one is applied for real. If none passes everything, the best gets
 * one repair call with its failing test output.
 */
/** The model the versions step asks: any `ModelClient`. */
export type SurgicalGateway = ModelClient;

export interface SurgicalOptions {
  gateway: SurgicalGateway;
  model: string;
  root: string;
  task: string;
  /** Number of candidates. */
  n?: number;
  /** Repair rounds on the best candidate when none passes. */
  repairs?: number;
  /** Test command run in each scratch copy. Default `node --test`. */
  testCommand?: string[];
  /** Write the task checks first and show them to the writer (it codes against them). */
  specFirst?: boolean;
  /** The project has no tests: the checks written from the task are the proof, so every one must pass. */
  checksOnly?: boolean;
  /** Requirements the user approved (from draftChecks). The checks test exactly these, the writer sees them first,
   * and a failing one is always worth a repair: the user, not the model, said it must hold. */
  requirements?: string[];
  /** A bug fix: first write a test that reproduces the bug and confirm it fails on the current code; then a version
   * is kept only when that test passes. The test stays in the project as a regression test. */
  reproFirst?: boolean;
  /** Start the other versions once the first one answers, so they read its prompt from a cloud cache. */
  staggerForCache?: boolean;
  /** Hidden-reasoning budget per candidate call (cloud models that think). Undefined: the provider default. */
  thinkingBudget?: number;
  /** End the wait as soon as one version passes everything (default on; off when all versions are wanted). */
  firstPassingWins?: boolean;
  /** Seconds one test run may take (default 90). */
  testTimeoutSec?: number;
  /** Ask the model for checks written from the task, used to rank candidates that pass the same tests. Default true. */
  taskChecks?: boolean;
  /** Files the AI may not see (ignore rules, secret files): left out of every prompt this step builds. Default: none hidden. */
  hidden?: (rel: string) => boolean;
  /** Write the winner into `root` (default true). False: only return the changes, for the caller to apply. */
  apply?: boolean;
  /**
   * Scope guard (default on): a version that edits files the request does not need (not named, not a task-pack
   * target, not a test) scores lower, and such edits are dropped from the chosen version unless the tests need them.
   */
  scopeGuard?: boolean;
  /** Files the caller's task pack marked as targets (its packFiles). Default: Apex computes the pack itself (top 3). */
  scopeTargets?: string[];
  /** Cap on tokens per answer. Default 8192 (QA: Qwen versions hit 4096 on 6 of 8 calls, a cut file is wasted). */
  maxTokens?: number;
  /** Characters of compiled context. */
  budgetChars?: number;
  /**
   * The code graph of `root` (policy flag `graph`). With it the context is scoped to what the request names
   * (compileContextX); a repair after an edit that did not apply gets the wider whole-files form. Default: the
   * graph cached for `root` when the policy is on, else none.
   */
  graph?: CodeGraph | null;
  /**
   * A working checks file from an earlier turn ("Fix the failing checks"): reused as is, and only tests for checks it
   * does not cover yet are added. Never regenerated (measured: a retry that rewrote the checks lost the ones that had
   * caught the overdue bug). Default: none (a new file is written).
   */
  reuseChecks?: { content: string };
  /**
   * Adaptive attempts (for weaker models on one slot): one attempt first, with up to 2 repair rounds; only when it does
   * not pass the tests and every proven check, the other attempts, each with a different framing and temperature.
   * Default false (all attempts in parallel, the first that passes everything wins).
   */
  adaptive?: boolean;
  /** One version or repair call may take this long (seconds, default 150); then it is stopped and asked once more with little thinking. */
  callSeconds?: number;
  /** After this long (seconds, default 360) no new version or repair starts; the best so far is used. */
  maxSeconds?: number;
  /** When two or more versions pass everything, run inputs on which they may differ and keep the majority (S*). Default true. */
  tieBreak?: boolean;
  /**
   * Files this turn already changed before the versions were asked for (a rename Apex did itself): a version that
   * does not edit them has not skipped them. Measured: after such a rename the file the request names was already
   * done, every version was sent to repair for "not touching" it, and two more versions were written.
   */
  alreadyChanged?: string[];
  /**
   * Graph policy: when a version passes the project's tests and most checks while a few proven checks fail, one
   * short call says whether those checks or the change is at fault (judgeFailingChecks), before any repair or
   * further version. Checks at fault: the versions step ends there with that version (never "ready").
   */
  secondLook?: boolean;
  /** A separate (usually stronger) model that writes the checks and judges failing checks; the main model only writes the change. */
  checker?: { gateway: SurgicalOptions["gateway"]; model: string };
  signal?: AbortSignal;
  /** Progress events (versions started, a candidate's result, ...). The host maps them to its own UI or log. */
  onEvent?: EventSink;
  /** Where the project's files are read and the chosen change is written. Default: the node file system under `root`. */
  workspace?: Workspace;
  /** Source of the task pack (files a request points at). Default: the one a host registered, else none. */
  taskPack?: TaskPackProvider;
  /** Knobs that default to environment variables (see EngineOptions). */
  engine?: EngineOptions;
}

export interface FileEdit {
  path: string;
  /** Absent for a whole new file. */
  search?: string;
  replace: string;
}

export interface CandidateResult {
  index: number;
  edits: FileEdit[];
  applyErrors: string[];
  passed: number;
  failed: number;
  testOutput: string;
  repaired: boolean;
  /** Task checks (tests the model wrote from the task) that this candidate passes, when there were any. */
  checksPassed?: number;
  checksFailed?: number;
  /** Changed files that do not parse, as "file: error". */
  syntax?: string[];
  /** What the failing task checks printed (for one repair round). */
  checksOutput?: string;
  /** Files the task names that this version did not change. */
  skippedNamed?: string[];
  /** The task checks' whole output (passing and failing), for per-check results. */
  checksRun?: string;
  /** The project's own test run on this version: seconds taken and the runner's exit code. */
  testSeconds?: number;
  testExitCode?: number | null;
  /** Changed files outside the request's scope (see scopeGuard). */
  outOfScope?: string[];
  /** Exports the request names that this version lacks (checked before its tests run; the tests did not run). */
  interfaceMissing?: string[];
}

export interface SurgicalResult {
  /** Apex's generated checks file could not be made to load (first line of its error): no version was checked. */
  checksError?: string;
  chosen: CandidateResult | null;
  candidates: CandidateResult[];
  changes: { path: string; before: string; after: string }[];
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** reproFirst: a test reproduced the bug (failed on the code before the change). */
  reproduced?: boolean;
  /** Input tokens the provider served from its prompt cache. */
  cachedTokens?: number;
  contextChars: number;
  ms: number;
  /** Where the task checks were written (relative to the project), when there were any. */
  checkPath?: string;
  /** Files the scope guard removed from the chosen version (the tests still passed without them). */
  droppedOutOfScope?: string[];
  /** Out-of-scope files kept because the tests failed without them. */
  keptOutOfScope?: string[];
  /** Security-weakening changes found in the chosen version (also a failed "[implicit]" check in checksRun). */
  securityFlags?: string[];
  /** The checks file the versions were judged by (to pass back as `reuseChecks` on "Fix the failing checks"). */
  checksFile?: { path: string; content: string };
  /** The checks judged: approved lines plus any the coverage gate (and, for a fix, the edge cases) added. */
  requirements?: string[];
  /** Checks dropped before they could block the change (quote not in the request, contradicts it, vague, beyond a crash report). */
  droppedChecks?: DroppedCheck[];
  /** The generated checks file never loaded (even after repair): no check ran, so none can hold the change. */
  checksNotLoaded?: string;
  /**
   * Every check also passed on the code before the change, and no failing project test was fixed: the checks do not
   * show that the change does what was asked (the reason, as a sentence). The verdict is then "unverified", never "ready".
   */
  vacuousChecks?: string;
  /** The versions step stopped early: the model's answers in a row were unusable in the same way (see unusableStreak). */
  gaveUp?: string;
  /** The second look at failing checks (see SurgicalOptions.secondLook), when one was taken. */
  secondLook?: { verdict: "test" | "code" | "unknown"; reason: string };
  /** Lines added to the approved checks: rules of the request no approved line covered, and a fix's edge cases. */
  addedChecks?: string[];
  /** Per-check results for the chosen version with proof applied: unproven failures and missing tests are null. */
  checkResults?: CheckResult[];
  /**
   * The outcome the evidence supports: ready only when the project's tests pass, every proven check passes and no
   * check is pending; not_ready on a proven failing check; unverified when a check is pending (unproven or unchecked).
   * When unverified, `checksError` carries the reason too (older callers treat that as "unverified").
   */
  verdict?: { outcome: "ready" | "not_ready" | "unverified"; reason?: string };
}

const FORMAT = `Answer with edits only, in this exact format, and nothing else:

=== FILE: relative/path.js
<<<<<<< SEARCH
exact lines copied from the current file
=======
the new lines
>>>>>>> REPLACE

- SEARCH must match the current file exactly (copy it). Keep it short but unique. Several blocks per file are fine.
- For a new file, or to replace a file whole, use an empty SEARCH section.
- Reuse the helpers that exist; do not rewrite them. Keep the existing tests passing.
- Write each edit once. After the last edit, write the line === END and stop.`;

/**
 * Graph policy, a second look before the step-by-step loop: a draft passes the project's tests and most of the
 * checks written from the request, and a few checks fail. Either the draft misses something or the check is wrong
 * (it asks for more than the request, or builds its input wrongly). One short call reads the request, the change
 * and the failing tests and says which. Measured (Flash, large set): such drafts went to the loop, which spent
 * 50-100k input tokens and ended on the same draft, marked unverified.
 * "test": the checks are at fault; "code": the change is; "unknown": no clear answer (treated as "code").
 * The verdict never makes a change "ready": the caller writes the draft as unverified, or goes on to the loop.
 */
export async function judgeFailingChecks(o: {
  gateway: Pick<SurgicalGateway, "stream">; model: string; task: string; changes: Array<{ path: string; before: string | null; after: string }>;
  checksFile: string; failureOutput: string; passed: number; failed: number; signal?: AbortSignal; thinkingBudget?: number;
  /** The call's token use, when the provider reports it. */ onUsage?: (u: { inputTokens: number; outputTokens: number; cachedTokens: number }) => void;
}): Promise<{ verdict: "test" | "code" | "unknown"; reason: string }> {
  const diff = o.changes.map((c) => `--- ${c.path}\n${lineDiff(c.before ?? "", c.after).join("\n")}`).join("\n").slice(0, 6000);
  const messages = [
    msg("system", "You settle a disagreement between a code change and a test written for it. First line of your answer: exactly TEST or CODE. Second line: one sentence saying why."),
    msg("user", `<request>\n${requestOnly(o.task).slice(0, 4000)}\n</request>\n\n<change note="lines added (+) and removed (-); it passes the project's own tests">\n${diff}\n</change>\n\n<acceptance tests note="written from the request by someone else, before the change">\n${o.checksFile.slice(0, 7000)}\n</acceptance tests>\n\n<failures note="${o.passed} of these tests pass on the change, ${o.failed} fail">\n${failures(o.failureOutput, 2500)}\n</failures>\n\nFor the failing tests, decide who is wrong.\nAnswer TEST when the failing test is at fault: it demands something the request does not ask for, expects a value the request does not fix, builds its input wrongly, or fails for a reason unrelated to the request.\nAnswer CODE when the change is at fault: the failing test checks something the request asks for and the change does not do it.\nWhen you cannot tell, answer CODE.`),
  ];
  let text = "";
  try {
    for await (const ev of o.gateway.stream({ messages, tools: [], model: o.model, temperature: 0, maxTokens: 300, thinkingBudget: o.thinkingBudget ?? SHORT_THINKING, segments: { arbiter: 1, diff: diff.length, checks: Math.min(7000, o.checksFile.length) }, signal: o.signal })) {
      if (ev.type === "text-delta") text += ev.text;
      if (ev.type === "message-complete" && !text) text = ev.message.content ?? "";
      if (ev.type === "usage") o.onUsage?.({ inputTokens: ev.inputTokens ?? 0, outputTokens: ev.outputTokens ?? 0, cachedTokens: ev.cachedTokens ?? 0 });
      if (ev.type === "error") throw new Error(ev.message);
    }
  } catch (err) {
    if (o.signal?.aborted) throw err;
    return { verdict: "unknown", reason: "" };
  }
  return readVerdict(text);
}

/** The arbiter's answer: its first word decides; anything else is "unknown". */
export function readVerdict(text: string): { verdict: "test" | "code" | "unknown"; reason: string } {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const m = /^\W*(TEST|CODE)\b/.exec(clean);
  const reason = clean.replace(/^\W*(TEST|CODE)\b[\s:.,-]*/, "").split("\n").map((l) => l.trim()).filter(Boolean)[0]?.slice(0, 300) ?? "";
  return { verdict: m ? (m[1] === "TEST" ? "test" : "code") : "unknown", reason };
}

/** Where the useful answer ends: at "=== END", or where a finished edit block repeats an earlier one. -1 to keep going. */
export function endOfEdits(text: string): number {
  const end = text.indexOf("=== END");
  if (end >= 0) return end;
  const seen = new Set<string>();
  let file = "";
  const re = /^===\s*FILE:\s*(.+?)\s*$|<{5,}\s*SEARCH\s*\n[\s\S]*?>{5,}\s*REPLACE/gm;
  for (const m of text.matchAll(re)) {
    if (m[1] !== undefined) { file = m[1]; continue; }
    const key = file + "\0" + m[0];
    if (seen.has(key)) return m.index!;
    seen.add(key);
  }
  return -1;
}

/** Parse search/replace blocks. Tolerant of code fences and blank lines around markers. */
export function parseEdits(text: string): FileEdit[] {
  const edits: FileEdit[] = [];
  const clean = text.replace(/^```[a-z]*\s*$/gim, "");
  const fileRe = /^===\s*FILE:\s*(.+?)\s*$/gm;
  const heads = [...clean.matchAll(fileRe)];
  heads.forEach((h, i) => {
    const file = h[1].replace(/^\.?\//, "").replace(/`/g, "");
    const body = clean.slice(h.index! + h[0].length, i + 1 < heads.length ? heads[i + 1].index : undefined);
    const blockRe = /<{5,}\s*SEARCH\s*\n([\s\S]*?)\n?={5,}\s*\n([\s\S]*?)\n?>{5,}\s*REPLACE/g;
    for (const b of body.matchAll(blockRe)) {
      const search = b[1];
      edits.push(search.trim() ? { path: file, search, replace: b[2] } : { path: file, replace: b[2] });
    }
  });
  return edits;
}

const SHORT_THINKING = 1024;

/**
 * Characters read after an answer is complete (its closing fence, "=== END") while waiting for the provider's usage
 * event, which comes last. A model that has closed its answer stops there, so this costs nothing; one that keeps
 * writing is left after this much (about 100 tokens), and the call's tokens are then estimated from its text.
 */
export const DRAIN_CHARS = 400;

/**
 * Reads one answer's text from a model stream. `done(text)`: the answer is complete; the text is kept as it is and
 * the stream is read on only for its usage event (bounded by DRAIN_CHARS). `loop(text)`: the model is repeating
 * itself; the stream is left at once (waiting would let it run to its token cap).
 */
export async function streamText(events: AsyncIterable<ModelEvent>, o: { done?: (text: string) => boolean; loop?: (text: string) => boolean; onUsage?: (u: { inputTokens: number; outputTokens: number; cachedTokens: number }) => void } = {}): Promise<string> {
  let text = "";
  let complete = false;
  let extra = 0;
  for await (const ev of events) {
    if (ev.type === "text-delta") {
      if (complete) { extra += ev.text.length; if (extra > DRAIN_CHARS) break; continue; }
      text += ev.text;
      if (o.loop?.(text)) break;
      if (o.done?.(text)) complete = true;
    }
    if (ev.type === "thinking-delta" && complete) { extra += ev.text.length; if (extra > DRAIN_CHARS) break; }
    if (ev.type === "message-complete" && !text) text = ev.message.content ?? "";
    if (ev.type === "usage") { o.onUsage?.({ inputTokens: ev.inputTokens ?? 0, outputTokens: ev.outputTokens ?? 0, cachedTokens: ev.cachedTokens ?? 0 }); if (complete) break; }
    if (ev.type === "error") throw new Error(ev.message);
  }
  return text;
}

/** A complete fenced code block in an answer. */
export const hasFencedBlock = (text: string): boolean => /```[a-z]*\n[\s\S]*?\n```/.test(text);

/**
 * Graph policy, hidden thinking: with the scoped context a call that writes edits or checks is given a thinking
 * budget instead of the provider's default (unbounded). Measured (Flash, large set, d48359d): thinking was 85% of
 * the output tokens (a checks call thought 4k tokens on average, up to 10k, to write a 700-token test file), and 9 of
 * 39 version calls thought past the time limit and were asked again with 1024 anyway.
 * APEX_GRAPH_THINKING / APEX_GRAPH_CHECKS_THINKING: a number of tokens, or "default" for the provider's default.
 */
// GRAPH_EDIT_THINKING, GRAPH_CHECKS_THINKING and graphThinking(): options.ts (re-exported above).
/**
 * Graph policy: the call that writes the checks gets a smaller scoped context (the functions the request names, by
 * their definitions, and outlines) than the call that writes the edit: a test calls the code, it does not change it,
 * so callers and callees are left out. APEX_GRAPH_CHECKS_CONTEXT=full sends the edit's context as before.
 */
// CHECKS_BUDGET and slimChecksContext(): options.ts (re-exported above).

/** A signal that also fires after `ms`; `timedOut()` says whether the time limit (not the caller) stopped it. */
export function boundedCall(parent: AbortSignal | undefined, ms: number): { signal: AbortSignal; timedOut: () => boolean; done: () => void } {
  const ctl = new AbortController();
  let timedOut = false;
  const onParent = () => ctl.abort();
  if (parent?.aborted) ctl.abort(); else parent?.addEventListener("abort", onParent, { once: true });
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, ms);
  return { signal: ctl.signal, timedOut: () => timedOut, done: () => { clearTimeout(timer); parent?.removeEventListener("abort", onParent); } };
}

/** Apply edits under root. Exact match first, then a match that ignores leading/trailing whitespace per line. */
export async function applyEdits(root: string, edits: FileEdit[], o: { secretMark?: string } = {}): Promise<{ errors: string[]; touched: Map<string, string> }> {
  const secretMark = o.secretMark ?? SECRET_PLACEHOLDER_MARK;
  const errors: string[] = [];
  const touched = new Map<string, string>(); // path -> content before
  for (const e of edits) {
    const abs = path.resolve(root, e.path);
    if (!abs.startsWith(path.resolve(root) + path.sep)) { errors.push(`${e.path}: outside the project`); continue; }
    let cur = "";
    try { cur = await fs.readFile(abs, "utf8"); } catch { /* new file */ }
    if (!touched.has(e.path)) touched.set(e.path, cur);
    let next: string | null;
    if (e.search === undefined) next = e.replace.endsWith("\n") ? e.replace : e.replace + "\n";
    // The model repeated an edit, or quoted text it already replaced: what it wants is already there. (Only for
    // a replacement long enough to be unmistakable, and only when the quoted text is not in the file as written.)
    else if (!cur.includes(e.search) && e.replace.trim().length >= 40 && cur.includes(e.replace.trim())) continue;
    else next = replaceOnce(cur, e.search, e.replace);
    if (next !== null && next.includes(secretMark)) { errors.push(`${e.path}: ${MASKED_SECRET_EDIT}`); continue; }
    if (next === null) {
      const near = nearest(cur, e.search ?? "");
      errors.push(`${e.path}: SEARCH text not found${near ? `. The file has, near there, exactly:\n${near}` : ""}`);
      continue;
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, next);
  }
  return { errors, touched };
}

function replaceOnce(cur: string, search: string, replace: string): string | null {
  const i = cur.indexOf(search);
  if (i >= 0) return cur.slice(0, i) + replace + cur.slice(i + search.length);
  const lines = cur.split("\n");
  const want = search.split("\n").map((l) => l.trim());
  while (want.length && !want[want.length - 1]) want.pop();
  while (want.length && !want[0]) want.shift();
  if (!want.length) return null;
  for (let s = 0; s + want.length <= lines.length; s++) {
    if (want.every((w, k) => lines[s + k].trim() === w)) {
      return [...lines.slice(0, s), replace, ...lines.slice(s + want.length)].join("\n");
    }
  }
  // One line quoted with a slip (a dropped brace, a changed word): when every other line of a block of three
  // or more matches, in exactly one place, and the odd line is close, it is that block.
  if (want.length >= 3) {
    const hits: number[] = [];
    for (let s = 0; s + want.length <= lines.length; s++) {
      const off = want.map((w, k) => (lines[s + k].trim() === w ? -1 : k)).filter((k) => k >= 0);
      if (off.length === 1 && similar(lines[s + off[0]].trim(), want[off[0]]) >= 0.8) hits.push(s);
    }
    if (hits.length === 1) return [...lines.slice(0, hits[0]), replace, ...lines.slice(hits[0] + want.length)].join("\n");
  }
  // Anchored: the quoted block's first and last lines are each in the file once, in order, about as far apart as
  // quoted, and most lines between them match. A weaker model often rewords a line or two in the middle of what it
  // quotes (measured: 2-3 of 6-8 edits per version did not apply), so the exact and one-slip matches miss it.
  if (want.length >= 4) {
    const first = want[0], last = want[want.length - 1];
    const firsts = lines.map((l, k) => (l.trim() === first ? k : -1)).filter((k) => k >= 0);
    // The last line (often a lone "}") need not be unique: the first one after the block's start, within reach.
    const reach = Math.ceil(want.length * 1.4) + 1;
    const b0 = firsts.length === 1 ? lines.findIndex((l, k) => k > firsts[0] && k < firsts[0] + reach && l.trim() === last) : -1;
    if (firsts.length === 1 && b0 > 0 && first.length >= 8) {
      const a = firsts[0], b = b0;
      const span = b - a + 1;
      if (b > a && span >= want.length * 0.7 && span <= want.length * 1.4 + 1) {
        const inner = new Set(lines.slice(a, b + 1).map((l) => l.trim()));
        const matched = want.filter((w) => inner.has(w)).length;
        if (matched / want.length >= 0.6) return [...lines.slice(0, a), replace, ...lines.slice(b + 1)].join("\n");
      }
    }
  }
  return null;
}

/** For a repair: the lines of the file nearest to a SEARCH that did not match, so the model can copy them exactly. */
function nearest(cur: string, search: string): string {
  const lines = cur.split("\n");
  const first = search.split("\n").map((l) => l.trim()).find((l) => l.length >= 6) ?? "";
  if (!first) return "";
  let best = -1, score = 0;
  lines.forEach((l, k) => { const sc = similar(l.trim(), first); if (sc > score) { score = sc; best = k; } });
  if (best < 0 || score < 0.5) return "";
  return lines.slice(Math.max(0, best - 2), best + Math.max(4, search.split("\n").length + 2)).join("\n");
}

/** How alike two lines are, 0 to 1: shared prefix plus shared suffix over the longer length. */
function similar(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (!max) return 1;
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return (pre + suf) / max;
}

// listFiles(): workspace.ts (re-exported above).

/** What a compiled context is made of: its text, the size of each part, and which form it took. */
export interface Compiled { text: string; segments: Segments; form: "legacy" | "files" | "scoped" }
/** What a compiled context is built with. */
export interface ContextOptions {
  graph?: CodeGraph | null; form?: "auto" | "files";
  /** A bug fix looks below the named function; a change looks at its callers. */ kind?: "fix" | "change" | "checks";
  /** Files the AI may not see: never listed, read or shown. */ hidden?: (rel: string) => boolean;
  /** Where the project's files are read from. Default: the node file system under `root`. */ workspace?: Workspace;
  /** Source of the task pack. Default: the one a host registered (registerTaskPack), else none. */ taskPack?: TaskPackProvider;
  /** Budgets and other knobs (each falls back to its environment variable). */ engine?: EngineOptions;
}
/** A dependency lock file (package-lock.json, yarn.lock, Cargo.lock, …): never useful in a prompt. Not clock.js or blocklist.py. */
export const isLockFile = (f: string): boolean => /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.ya?ml|bun\.lockb?|[^/]*\.lock)$/i.test(f);
/** With the code graph: the scoped form (symbol ranges) aims at this size, the whole-files form at the second. */
// SCOPED_BUDGET: options.ts (re-exported above).
/** A budget from the environment (for measuring another size), or the default. */
export const FILES_BUDGET = 20_000;
const SCOPED_NOTE = "in part: lines not shown are unchanged, and SEARCH text must come from the lines shown";

/** The file list for a prompt, cut at `maxChars` on a line boundary with a count of what is left out. */
function listing(files: string[], maxChars = Number.MAX_SAFE_INTEGER): string {
  let body = files.join("\n");
  if (body.length > maxChars) {
    const kept: string[] = [];
    let used = 0;
    for (const f of files) { if (used + f.length + 1 > maxChars) break; kept.push(f); used += f.length + 1; }
    body = `${kept.join("\n")}\n… ${files.length - kept.length} more files`;
  }
  return `<project-files>\n${body}\n</project-files>`;
}

/**
 * The compiled context: the file list, the task pack's matches, then the whole source of the files most likely to be
 * edited and of the tests, last, right before the task. Copy-friendly: the code to edit is in the prompt, so an engine
 * with prompt-lookup drafts writes SEARCH blocks almost for free.
 *
 * With the code graph (policy flag `graph`) the budget is not filled with unrelated files:
 *  - "scoped": the functions the request names, their callers (graph ∪ text search) and callees, exactly as they
 *    are in the files, plus outlines of the rest (scoped-context.ts);
 *  - "files": only the named files, the graph-ranked files and the files of direct dependents, whole or excerpted
 *    (used when the request names no symbol, and as the wider context of a repair);
 *  - a project small enough to fit anyway, or no graph: "legacy", as before.
 */
export async function compileContextX(root: string, task: string, budgetChars = 40_000, o: ContextOptions = {}): Promise<Compiled> {
  const hidden = o.hidden ?? (() => false);
  const ws = o.workspace ?? fsWorkspace(root);
  const settings = engineSettings(o.engine);
  const files = (await ws.list()).filter((f) => !hidden(f));
  const code = files.filter((f) => /\.(m?[jt]sx?|json|html|css|py|go|rs|md)$/.test(f) && !isLockFile(f));
  const pack = await taskPackProvider(o.taskPack)(root, task, hidden, 6000).catch(() => ({ text: "", packFiles: [] as string[] }));
  const named = code.filter((f) => task.includes(f) || task.includes(path.basename(f)));
  const tests = code.filter((f) => /(^|\/)tests?\//.test(f) || /\.test\./.test(f));
  const own = requestOnly(task);
  const names = codeNames(own);
  const graph = graphScope() === "off" ? null : o.graph !== undefined ? o.graph : cachedGraph(root);
  if (graph) {
    let total = 0;
    for (const f of code) { total += ws.size ? await ws.size(f) : Buffer.byteLength((await ws.read(f)) ?? ""); if (total > SCOPED_BUDGET) break; }
    // A project that fits anyway has nothing to cut.
    if (total > SCOPED_BUDGET) {
      const ownNamed = code.filter((f) => own.includes(f) || own.includes(path.basename(f)));
      // The graph matches words loosely ("and" finds a class And): only names written in the request as they are in the code.
      const seeds = graph.seeds(own).filter((n) => !n.isFile && !n.note && !isTestPath(n.file) && n.name.length >= 4 && wordRe(n.name).test(own));
      const strong = new Set(names);
      // Names written as code first; when the request writes none, the graph's looser matches (words that are symbols).
      const scopeNames = names.length ? [...new Set([...names, ...seeds.map((n) => n.name).filter((n) => strong.has(n))])] : [...new Set(seeds.map((n) => n.name))].slice(0, 6);
      const ranked = [...new Set([...graph.rankFiles(own, 8), ...pack.packFiles])].filter((f) => files.includes(f));
      const words = scopeWords(own);
      if (o.form !== "files" && graphScope() === "scoped" && (scopeNames.length || words.length)) {
        const sc = await scopedContext({ root, files, names: scopeNames, words, graph, budgetChars: Math.min(budgetChars, settings.scopedBudget()), named: ownNamed, ranked, hidden, mode: o.kind === "checks" ? "question" : o.kind === "fix" ? "fix" : "edit" }).catch(() => null);
        if (sc && sc.blocks.length) {
          const list = listing(files.filter((f) => !isTestPath(f) || sc.blocks.some((b) => b.path === f)), 1200);
          sc.segments.names = sc.names.length;
          const parts = [list];
          if (sc.outlines) parts.push(`<outline note="line ranges and signatures of the files shown in part below (and of related files); bodies not shown here are unchanged">\n${sc.outlines}\n</outline>`);
          if (sc.callSites.length) parts.push(`<uses note="every line outside its definition that uses ${sc.names.slice(0, 6).join(", ")} (text search and code graph). A change to a name or a signature must update each of them">\n${sc.callSites.join("\n")}\n</uses>`);
          for (const b of sc.blocks) parts.push(b.whole ? `<file path="${b.path}">\n${b.text}\n</file>` : `<file path="${b.path}" lines="${b.lines}" shown="${SCOPED_NOTE}">\n${b.text}\n</file>`);
          return { text: parts.join("\n\n"), segments: { listing: list.length, ...sc.segments }, form: "scoped" };
        }
      }
      // Whole files, but only the ones the request and the graph point at: no top-up with the rest of the project.
      const deps: string[] = [];
      for (const n of scopeNames) for (const d of graph.dependentIds(n, 1)) if (!deps.includes(d.file) && !hidden(d.file)) deps.push(d.file);
      const order = [...new Set([...ownNamed, ...ranked, ...deps.sort((x, y) => Number(isTestPath(x)) - Number(isTestPath(y)))])].filter((f) => code.includes(f));
      if (order.length) {
        const budget = Math.min(budgetChars, FILES_BUDGET);
        const list = listing(files, 1500);
        const seg: Segments = { listing: list.length, named: 0, ranked: 0, tests: 0, outlines: 0 };
        const parts = [list];
        let used = list.length;
        let excerpted = 0;
        const outs: string[] = [];
        for (const f of order) {
          const body = (await ws.read(f)) ?? "";
          if (!body) continue;
          let block = `<file path="${f}">\n${body}\n</file>`;
          if (body.length > 8000 || used + block.length > budget) {
            if (excerpted >= 6 || !/\.(m?[jt]sx?|cjs|py|go|rs|java|kt|rb)$/.test(f)) continue;
            // In part: the functions in this file that the request names or is about.
            const part = await scopedContext({ root, files: [f], names: scopeNames, words, graph, hidden, budgetChars: Math.min(9000, Math.max(3000, Math.floor((budget - used) * 0.6))), mode: o.kind === "checks" ? "question" : o.kind === "fix" ? "fix" : "edit" }).catch(() => null);
            const b = part?.blocks[0];
            if (!b) continue;
            block = b.whole ? block : `<file path="${f}" lines="${b.lines}" shown="${SCOPED_NOTE}">\n${b.text}\n</file>`;
            if (used + block.length > budget) continue;
            excerpted++;
            if (part.outlines && used + block.length + part.outlines.length <= budget) { outs.push(part.outlines); used += part.outlines.length; seg.outlines += part.outlines.length; }
          }
          parts.push(block);
          used += block.length;
          seg[ownNamed.includes(f) ? "named" : isTestPath(f) ? "tests" : "ranked"] += block.length;
        }
        if (parts.length > 1) {
          if (outs.length) parts.splice(1, 0, `<outline note="line ranges and signatures of the files shown in part">\n${outs.join("\n\n")}\n</outline>`);
          return { text: parts.join("\n\n"), segments: seg, form: "files" };
        }
      }
    }
  }
  // Order: named in the task, then pack files, then the rest of the source, then tests. Small files first within each.
  const order = [...new Set([...named, ...pack.packFiles.filter((f) => files.includes(f)), ...code.filter((f) => !tests.includes(f)), ...tests])];
  const parts: string[] = [`<project-files>\n${files.join("\n")}\n</project-files>`];
  const seg: Segments = { listing: parts[0].length, pack: pack.text.length, named: 0, ranked: 0, filler: 0, tests: 0 };
  if (pack.text) parts.push(pack.text);
  let used = parts.join("\n").length;
  // A file too large to show whole is shown in part: the lines around every use of the names the request writes
  // as code, exactly as they are in the file (measured on larger projects: the writer never saw the 50 KB file
  // holding the callers, guessed its text, and 3 of 5 edits did not apply).
  let excerpted = 0;
  for (const f of order) {
    const body = (await ws.read(f)) ?? "";
    if (!body) continue;
    let block = `<file path="${f}">\n${body}\n</file>`;
    if (body.length > 12_000) {
      if (!names.length || excerpted >= 8 || !/\.(m?[jt]sx?|cjs|py|go|rs|java|kt|rb)$/.test(f)) continue;
      const ex = excerptAround(body, names, Math.min(7000, Math.max(1500, Math.floor((budgetChars - used) / 2))));
      if (!ex) continue;
      block = `<file path="${f}" shown="in part: the lines around ${names.slice(0, 6).join(", ")}; lines not shown are unchanged, and SEARCH text must come from the lines shown">\n${ex}\n</file>`;
      if (used + block.length > budgetChars) continue;
      excerpted++;
    }
    if (used + block.length > budgetChars) continue;
    parts.push(block);
    used += block.length;
    seg[named.includes(f) ? "named" : pack.packFiles.includes(f) ? "ranked" : tests.includes(f) ? "tests" : "filler"] += block.length;
  }
  return { text: parts.join("\n\n"), segments: seg, form: "legacy" };
}

export async function compileContext(root: string, task: string, budgetChars = 40_000, o: ContextOptions = {}): Promise<string> {
  return (await compileContextX(root, task, budgetChars, o)).text;
}

/** Names a request writes as code: inside backticks, or snake_case / camelCase / dotted words. Longest first. */
export function codeNames(task: string): string[] {
  const out = new Set<string>();
  const add = (w: string) => { for (const part of w.split(".")) if (part.length >= 4 && !/^\d/.test(part) && !COMMON_NAMES.has(part.toLowerCase())) out.add(part); };
  for (const m of task.matchAll(/`([^`\n]{2,120})`/g)) for (const w of m[1].matchAll(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g)) add(w[0]);
  for (const m of task.matchAll(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g)) if (/[_$]/.test(m[0]) || /[a-z][A-Z]/.test(m[0])) add(m[0]);
  return [...out].sort((a, b) => b.length - a.length).slice(0, 12);
}
const COMMON_NAMES = new Set("true false null none undefined self this return function class const import from export default index name value data error errors test tests type string number list dict object array".split(" "));

/**
 * The lines of a large file around each use of `names` (whole-word), with line numbers in the gap markers, at most
 * `maxChars`. A name used on too many lines to show (a common word) is skipped. Empty when no name is used.
 */
export function excerptAround(body: string, names: string[], maxChars = 6000, around = 6): string {
  const lines = body.split("\n");
  const hits = new Set<number>();
  for (const n of names) {
    const re = new RegExp(`(^|[^\\w$])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w$])`);
    const at = lines.map((l, i) => (re.test(l) ? i : -1)).filter((i) => i >= 0);
    if (!at.length || at.length > 40) continue;
    for (const i of at) hits.add(i);
  }
  if (!hits.size) return "";
  const sorted = [...hits].sort((a, b) => a - b);
  const build = (pad: number): string => {
    const ranges: Array<[number, number]> = [];
    for (const i of sorted) {
      const a = Math.max(0, i - pad), b = Math.min(lines.length - 1, i + pad);
      const last = ranges[ranges.length - 1];
      if (last && a <= last[1] + 2) last[1] = Math.max(last[1], b); else ranges.push([a, b]);
    }
    const out: string[] = [];
    let prev = -1;
    for (const [a, b] of ranges) {
      if (a > prev + 1) out.push(`… (lines ${prev + 2}-${a} not shown)`);
      out.push(...lines.slice(a, b + 1));
      prev = b;
    }
    if (prev < lines.length - 1) out.push(`… (lines ${prev + 2}-${lines.length} not shown)`);
    return out.join("\n");
  };
  for (const pad of [around, 3, 1]) { const t = build(pad); if (t.length <= maxChars) return t; }
  return build(1).slice(0, maxChars);
}

/**
 * What must be true when the task is done, as short sentences a person can read and correct before anything is
 * built. Rules the task leaves open come back marked "(assumed)", so the user sees the guess instead of discovering
 * it in the code (measured: web-planner never states its sort order, and every path guessed it differently).
 */
const STOP = new Set("a an the and or of to in on for with without by is are be it its this that when then each per as at from into returns return get set should must".split(" "));
const words = (t: string) => (t.toLowerCase().match(/[a-z0-9_/.]+/g) ?? []).map((w) => w.replace(/^[./]+|[./]+$/g, "")).filter((w) => w.length > 1 && !STOP.has(w));

/**
 * A check the request states outright is not an assumption. Small models mark nearly every line "(assumed)"
 * (measured: 8 of 8 on a request that named the route, the 401, the sort and the flag); a line whose words
 * are mostly in the request drops the mark, so the person is only asked about what the request left open.
 */
export function unassumeStated(line: string, task: string): string {
  if (!/\(assumed\)\s*$/i.test(line)) return line;
  const lineWords = words(line.replace(/\(assumed\)\s*$/i, ""));
  if (!lineWords.length) return line;
  const taskWords = new Set(words(task));
  const stemIn = (w: string) => taskWords.has(w) || [...taskWords].some((t) => t.length > 3 && w.length > 3 && (t.startsWith(w.slice(0, 5)) || w.startsWith(t.slice(0, 5))));
  const covered = lineWords.filter(stemIn).length / lineWords.length;
  return covered >= 0.75 ? line.replace(/\s*\(assumed\)\s*$/i, "") : line;
}

const CHECKER_EDGE_HINT = "\n\nYou are the independent checker: the change is written by a weaker model that tends to handle only the cases the task spells out. Beyond the stated rules, also write tests for the behaviour that standard practice makes unambiguous for this kind of function even when the task does not mention it (for example for a CSV parser: CRLF line endings, a last row without a trailing newline, empty input; for a number or date parser: negative values, zero, empty or invalid input; for a collection: empty, one item, duplicates, input order left unchanged). Only where the correct result is certain; never guess a format the task leaves open.";
export async function draftChecks(opts: { gateway: SurgicalOptions["gateway"]; model: string; root: string; task: string; signal?: AbortSignal; thinkingBudget?: number; budgetChars?: number; hidden?: (rel: string) => boolean; workspace?: Workspace; taskPack?: TaskPackProvider; engine?: EngineOptions }): Promise<{ items: string[]; dropped: DroppedCheck[]; inputTokens: number; outputTokens: number }> {
  // A crash report: the checks are only that the crash is gone and nothing else changed (measured: checks demanding
  // behaviour for null, undefined and missing headers the report never specified held a correct fix).
  if (hasTrace(requestOnly(opts.task))) return { items: traceCheckLines(requestOnly(opts.task)), dropped: [], inputTokens: 0, outputTokens: 0 };
  const context = await compileContext(opts.root, opts.task, opts.budgetChars ?? 24_000, { hidden: opts.hidden, workspace: opts.workspace, taskPack: opts.taskPack, engine: opts.engine });
  const messages = [
    msg("system", "You turn a coding request into acceptance criteria. You never write code."),
    msg("user", `${context}\n\n<task>\n${opts.task}\n</task>\n\nList what must be true when this task is done, as acceptance criteria a test can check: one per line, starting with "- ", at most 8, each one short and concrete (names, values, status codes, order). Write one line per rule the task states: when it lists several (a route, a status code for signed-out requests, what is included, what is left out, an order, a flag), each gets its own line, usually 5 to 8 in all. Never repeat a line, and never write two lines that differ only in how a request is rejected (one line per status code). Prefer lines a test can check without guessing exact values (an order between two items, a property every item has, a shape, "does not throw"); keep exact values only where the task states them. Use the project's real function and file names. End every line with the exact words of the task it tests, in double quotes after a dash, for example: - todayTasks leaves out done tasks — "done tasks are left out". Test only rules the task states; never one it does not, and never the opposite of one it states. When the task leaves a detail of a stated rule open (an order, a format, an edge case), choose the most sensible one from the project's code and put "(assumed)" before the quote. Nothing else.`),
  ];
  let text = "";
  let inputTokens = 0, outputTokens = 0;
  for await (const ev of opts.gateway.stream({ messages, tools: [], model: opts.model, temperature: 0.2, maxTokens: 800, ...(opts.thinkingBudget !== undefined ? { thinkingBudget: opts.thinkingBudget } : {}), signal: opts.signal, scope: opts.root })) {
    if (ev.type === "text-delta") text += ev.text;
    if (ev.type === "message-complete" && !text) text = ev.message.content ?? "";
    if (ev.type === "usage") { inputTokens += ev.inputTokens ?? 0; outputTokens += ev.outputTokens ?? 0; }
    if (ev.type === "error") throw new Error(ev.message);
  }
  // Coverage gate: one line per rule the request states (status-code variants collapsed, missing rules added in the
  // request's own words), so the list cannot be eight variants of "401".
  // Each line must quote the request; a line whose quote is not there, that contradicts the request, or that is
  // vague is dropped before it can block a change (and listed as dropped).
  const own = requestOnly(opts.task);
  const lines = checkLines(text).map((line) => {
    const { text: t, quote } = splitQuote(line);
    return `${unassumeStated(t, opts.task)}${quote !== null ? ` — "${quote}"` : ""}`;
  });
  const screen = screenChecks(own, dedupeChecks(lines), { requireQuote: true });
  return { items: coverageGate(opts.task, screen.kept).checks, dropped: screen.dropped, inputTokens, outputTokens };
}

/** The criteria answer as clean lines: list marks removed, thinking dropped, repeats removed, at most 8. */
export function checkLines(text: string): string[] {
  return dedupeChecks(text.replace(/<think>[\s\S]*?<\/think>/g, "").split("\n")
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((l) => l.length >= 8 && l.length <= 300 && !/^```/.test(l)))
    .slice(0, 8);
}

/**
 * The same check said twice (measured on the sample: "The task ID is not reused for different tasks (assumed)"
 * three times): kept once, the first time. Same words ignoring case, punctuation and the "(assumed)" mark, or one
 * line's words all inside the other's (the longer, more specific line wins).
 */
export function dedupeChecks(lines: string[]): string[] {
  const key = (l: string) => l.replace(/\(assumed\)/gi, "").toLowerCase().replace(/[^a-z0-9/:_.-]+/g, " ").replace(/[.:-]+(?=\s|$)/g, "").trim();
  const wordsOf = (l: string) => new Set(key(l).split(" ").filter((w) => w.length > 2 && !/^(the|and|for|with|are|that|is|its|not)$/.test(w)));
  const out: string[] = [];
  for (const line of lines) {
    const k = key(line);
    if (!k) continue;
    const w = wordsOf(line);
    const twin = out.findIndex((o) => {
      if (key(o) === k) return true;
      const ow = wordsOf(o);
      const shared = [...w].filter((x) => ow.has(x)).length;
      return w.size > 2 && ow.size > 2 && shared === Math.min(w.size, ow.size) && Math.abs(w.size - ow.size) <= 2;
    });
    if (twin < 0) out.push(line);
    else if (wordsOf(out[twin]).size < w.size) out[twin] = line;
  }
  return out;
}

/** How a generated check must build its inputs (measured: a Today check called todayTasks(store, null, now)). */
export const CHECKS_INPUTS = `\n\nUse the project's public API the way the task describes it. When the task names a route (for example GET /api/today), call that route through the project's router or server helper the way the existing tests do, not only the function behind it. Build valid inputs: a real session or token from the project's own sign-in or auth helper (never null or a made-up object, except in the one test for the signed-out case), and a store or data seeded with exactly the records the test needs, through the project's own functions. Every assert carries a message saying what was expected.`;

/**
 * One or two existing tests to copy the style of: the ones that share the most words with the task, with a test
 * that calls a route first when the task names one (it shows how to sign in and call the router).
 */
export async function testExamples(root: string, allFiles: string[], task: string, py: boolean, max = 2, workspace: Workspace = fsWorkspace(root)): Promise<Array<{ path: string; body: string }>> {
  const tests = allFiles.filter((f) => (py ? /(^|\/)(test_[^/]*|[^/]*_test)\.py$/ : /\.test\.m?[jt]s$/).test(f) && !/apex-task-check|test_apex_task_check/.test(f));
  const taskWords = new Set(words(task));
  const route = /\b(GET|POST|PUT|PATCH|DELETE)\s+\/|\broute\b|\bendpoint\b|\/api\//i.test(task);
  const scored = await Promise.all(tests.slice(0, 40).map(async (f) => {
    const body = (await workspace.read(f)) ?? "";
    const w = new Set(words(`${f} ${body}`));
    let score = [...taskWords].filter((t) => w.has(t)).length;
    if (route && /\b(route|router|request|fetch|supertest|inject|status)\b/i.test(body) && /\b(session|token|sign|auth|login|bearer)\w*/i.test(body)) score += 20;
    return { path: f, body, score };
  }));
  return scored.filter((x) => x.body).sort((a, b) => b.score - a.score).slice(0, max).map(({ path: p, body }) => ({ path: p, body }));
}

export function examplesBlock(examples: Array<{ path: string; body: string }>, py: boolean, maxEach?: number): string {
  if (!examples.length) return "";
  const each = maxEach ?? (examples.length > 1 ? 1800 : 2500);
  return `\n\nFollow the style of ${examples.length > 1 ? "these existing tests" : "this existing test"} (how they import, set up inputs and call the code). Import each name once, only the ones you use:` +
    examples.map((e) => `\n${e.path}:\n\`\`\`${py ? "python" : "js"}\n${e.body.slice(0, each)}\n\`\`\``).join("");
}

/**
 * For a repair: the changed files and the project files its failure output names, whole; the rest by name only.
 * With `scope` (graph policy): a changed file too large for the budget is shown in part (the functions the edits
 * touched and the lines around the request's names) instead of being left out.
 */
export async function focusedContextX(root: string, changed: string[], failure: string, budgetChars = 40_000, scope?: { edits: FileEdit[]; names: string[] }, hidden: (rel: string) => boolean = () => false, workspace: Workspace = fsWorkspace(root)): Promise<Compiled> {
  const files = (await workspace.list()).filter((f) => !hidden(f));
  changed = changed.filter((f) => !hidden(f));
  const named = files.filter((f) => !changed.includes(f) && /\.(m?[jt]sx?|json|py|go|rs)$/.test(f) && failure.includes(f));
  const parts: string[] = [scope ? listing(files, 1500) : `<project-files>\n${files.join("\n")}\n</project-files>`];
  const seg: Segments = { listing: parts[0].length, changed: 0, helpers: 0 };
  let used = parts[0].length;
  for (const f of [...changed, ...named]) {
    const body = (await workspace.read(f)) ?? "";
    if (!body) continue;
    let block = `<file path="${f}">\n${body}\n</file>`;
    const isChanged = scope?.edits.some((e) => e.path === f);
    if (scope && (isChanged ? body.length > budgetChars * 0.5 : body.length > 6000) && /\.(m?[jt]sx?|cjs|py|go|rs|java|kt|rb)$/.test(f)) {
      const lines = body.split("\n");
      const entries = outline(f, body);
      const ranges: Array<{ a: number; b: number }> = [];
      // The functions the edits touched: found by the first substantial line of each replacement.
      for (const e of scope.edits.filter((x) => x.path === f)) {
        for (const probe of e.replace.split("\n").map((l) => l.trim()).filter((l) => l.length >= 8).slice(0, 3)) {
          const at = lines.findIndex((l) => l.trim() === probe);
          if (at < 0) continue;
          const sym = enclosingSymbol(entries, at + 1);
          ranges.push(sym && sym.end - sym.start <= 150 ? { a: withLead(lines, sym.start - 1), b: sym.end - 1 } : { a: at - 15, b: at + 15 });
        }
      }
      for (const n of scope.names) { const re = wordRe(n); const at = lines.map((l, i) => (re.test(l) ? i : -1)).filter((i) => i >= 0); if (at.length && at.length <= 30) for (const i of at) { const sym = enclosingSymbol(entries, i + 1); ranges.push(sym && sym.kind !== "class" && sym.end - sym.start <= 80 ? { a: withLead(lines, sym.start - 1), b: sym.end - 1 } : { a: i - 4, b: i + 4 }); } }
      if (!ranges.length) { if (!isChanged) continue; ranges.push({ a: 0, b: 40 }); }
      const text = renderRanges(lines, ranges);
      block = `<file path="${f}" lines="${lines.length}" shown="${SCOPED_NOTE}">\n${text}\n</file>`;
      if (isChanged) { const ol = shortOutline(f, entries, lines.length, 1500); block = `<outline note="line ranges and signatures; bodies not shown are unchanged">\n${ol}\n</outline>\n\n${block}`; }
    }
    if (used + block.length > budgetChars) continue;
    parts.push(block);
    used += block.length;
    seg[changed.includes(f) && (!scope || isChanged) ? "changed" : "helpers"] += block.length;
  }
  return { text: parts.join("\n\n"), segments: seg, form: scope ? "files" : "legacy" };
}

/** Folders never copied or compared, wherever they are (git's, Apex's, dependencies, bytecode caches). */
const JUNK_ANYWHERE = new Set([".git", ".apex", "node_modules", "__pycache__"]);
/** Build output and environments: skipped only at the project root (a source folder called `target` or `coverage` deeper down is source). */
const JUNK_AT_ROOT = new Set([".venv", "venv", ".next", ".turbo", ".cache", "coverage", "target", ".parcel-cache"]);
/** Whether a path (as parts, relative to the project) is junk. `diffOnly` also hides root-level `dist` and `build` from comparisons (they are copied, never reported as changes). */
export function isJunkPath(parts: string[], diffOnly = false): boolean {
  if (parts.some((p) => JUNK_ANYWHERE.has(p))) return true;
  const top = parts[0];
  return top !== undefined && (JUNK_AT_ROOT.has(top) || (diffOnly && (top === "dist" || top === "build")));
}

export async function copyProject(src: string, dest: string): Promise<void> {
  // Cloned on APFS, so nearly free. Symlinks that lead out of the project are not copied: a test could write through one into the real tree.
  const realSrc = await fs.realpath(src);
  await fs.cp(src, dest, { recursive: true, mode: fsConstants.COPYFILE_FICLONE, filter: async (p) => {
    const rel = path.relative(src, p);
    if (isJunkPath(rel.split(path.sep).filter(Boolean))) return false;
    try {
      if ((await fs.lstat(p)).isSymbolicLink()) { const real = await fs.realpath(p); return real === realSrc || real.startsWith(realSrc + path.sep); }
    } catch { return false; } // a dangling link
    return true;
  } });
  // Which project this copy is of (a copy of a copy: the first one's), for the test sandbox's choice per project.
  copyOf.set(path.resolve(dest), copyOf.get(path.resolve(src)) ?? path.resolve(src));
  if (copyOf.size > 500) copyOf.delete(copyOf.keys().next().value!);
  // Only when the project has one: a link to a folder that does not exist makes Node 20's test runner fail ("Could not find .../node_modules").
  if (existsSync(path.join(src, "node_modules"))) try { await fs.symlink(path.join(src, "node_modules"), path.join(dest, "node_modules"), "dir"); } catch { /* none */ }
}

/**
 * Python imports the code in this folder first. A project installed editable into its .venv points at the real
 * project's src/, so a version tested in a copy would otherwise be judged on the unchanged code (QA: itsdangerous,
 * a copy with a raise appended still passed 298/298).
 */
export function pythonPathFor(cwd: string): { PYTHONPATH?: string } {
  const dirs = [path.join(cwd, "src"), cwd].filter((d) => existsSync(d));
  if (!existsSync(path.join(cwd, "pyproject.toml")) && !existsSync(path.join(cwd, "setup.py")) && !existsSync(path.join(cwd, "setup.cfg"))) return {};
  return { PYTHONPATH: [...dirs, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) };
}

/**
 * The environment for code Apex did not write itself (the project's tests on a version a model wrote, generated
 * checks, probe scripts): what a test runner needs to start, and nothing that names a key, token or password. The
 * the host's own variables (control tokens, provider keys) never reach such code.
 */
const RUN_ENV_KEEP = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TERM|TMPDIR|TEMP|TMP|PWD|SystemRoot|ComSpec|PATHEXT|APPDATA|LOCALAPPDATA|USERPROFILE|ELECTRON_RUN_AS_NODE|NODE_PATH|NODE_ENV|NVM_DIR|NVM_BIN|VOLTA_HOME|PNPM_HOME|COREPACK_HOME|VIRTUAL_ENV|PYTHONPATH|PYTHONHOME|PYENV_ROOT|CONDA_PREFIX|CONDA_DEFAULT_ENV|UV_CACHE_DIR|XDG_[A-Z_]+|GOPATH|GOROOT|GOCACHE|GOMODCACHE|GOFLAGS|CARGO_HOME|RUSTUP_HOME|JAVA_HOME|DOTNET_ROOT|HOMEBREW_PREFIX)$/i;
const RUN_ENV_SECRET = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i;
export function runEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) if (v !== undefined && RUN_ENV_KEEP.test(k) && !RUN_ENV_SECRET.test(k)) env[k] = v;
  return env;
}

export interface TestRun { passed: number; failed: number; output: string; exitCode: number | null; seconds: number; /** The run was inside the test sandbox. */ sandboxed?: boolean }

/** Scratch copies made by copyProject, each with the project it is a copy of. */
const copyOf = new Map<string, string>();
const projectOf = (dir: string) => copyOf.get(path.resolve(dir)) ?? path.resolve(dir);
/**
 * Per project: whether its tests run inside the test sandbox, decided by a run of code no model wrote (trustedTestRun).
 * `on` is pending while that run goes on; other runs for the project wait for it. `failing`: tests seen failing the
 * same way inside and outside the sandbox (not asked about again).
 */
const sandboxChoice = new Map<string, { command: string; on: Promise<boolean>; failing: Set<string> }>();
/** For tests: forget what was decided per project. */
export function resetTestSandboxChoices(): void { sandboxChoice.clear(); }

/**
 * Runs a test command in `cwd` and reads its counts. Where a sandbox is available (macOS; see testSandboxProfile) the
 * run is inside it: the command may write only in `cwd`, the temporary folders and package caches, reaches no other
 * machine, and cannot read the usual credential stores. `cwd` is a scratch copy in every caller, and what runs is
 * often code a model wrote (a version, generated checks). Without a sandbox, or for a project whose own tests were
 * found not to run inside it (trustedTestRun), the run is as before: a scrubbed environment, nothing else.
 * The command's whole process group is killed on a timeout or a stop.
 */
export async function runTests(cwd: string, cmd: string[], signal?: AbortSignal, timeoutSec = 90, o: { sandbox?: boolean } = {}): Promise<TestRun> {
  const started = Date.now();
  const project = projectOf(cwd);
  const sandboxed = o.sandbox !== undefined ? o.sandbox && (await testSandboxAvailable()) : (await testSandboxAvailable()) && (await (sandboxChoice.get(project)?.on ?? true));
  let file = cmd[0] === "node" ? process.execPath : cmd[0];
  let args = cmd.slice(1);
  if (sandboxed) {
    // The project's own cache folders under node_modules (linked into the copy) stay writable: vitest and babel write there.
    const caches = [".cache", ".vite", ".vitest"].map((d) => path.join(project, "node_modules", d)).filter((d) => existsSync(d));
    ({ file, args } = inTestSandbox(testSandboxProfile({ writable: [cwd, ...caches], readable: [project] }), file, args));
  }
  const r = await runCommand(file, args, { cwd, timeoutMs: timeoutSec * 1000, maxBuffer: 8 << 20, signal, env: { ...runEnv(), CI: "1", FORCE_COLOR: "0", ...pythonPathFor(cwd) } });
  const output = r.stdout + r.stderr;
  // A run that was killed (timeout, stop) or exited with an error is never a clean pass.
  const t = readTestOutput(output, r.failed);
  return { passed: t.passed, failed: t.failed, output, exitCode: r.failed ? r.exitCode : 0, seconds: Math.round((Date.now() - started) / 100) / 10, ...(sandboxed ? { sandboxed: true } : {}) };
}

/**
 * A test run of code no model wrote (the project as it was before the change, in a copy `dir`): it also settles
 * whether this project's tests run inside the test sandbox. Sandboxed first; when tests fail there that were not seen
 * failing before, the same run outside it. Fewer failures or more passes outside: the project's tests need something
 * the sandbox denies (another machine, a folder outside the copy), so its runs stay outside, as they were before
 * the sandbox. Only such a run decides: a failing run of code a model wrote never moves a run outside the sandbox.
 */
export async function trustedTestRun(dir: string, command: string[], signal?: AbortSignal, timeoutSec = 90): Promise<TestRun & { sandbox: "on" | "off" | "none" }> {
  if (!(await testSandboxAvailable())) return { ...(await runTests(dir, command, signal, timeoutSec, { sandbox: false })), sandbox: "none" };
  const project = projectOf(dir);
  const key = command.join(" ");
  const had = sandboxChoice.get(project);
  const before = had && had.command === key ? had : null;
  if (before && !(await before.on)) return { ...(await runTests(dir, command, signal, timeoutSec, { sandbox: false })), sandbox: "off" };
  let settle: (on: boolean) => void = () => {};
  const entry = { command: key, on: new Promise<boolean>((r) => { settle = r; }), failing: before?.failing ?? new Set<string>() };
  sandboxChoice.set(project, entry);
  try {
    const inside = await runTests(dir, command, signal, timeoutSec, { sandbox: true });
    const names = readTestOutput(inside.output, false).failedNames;
    const known = inside.passed > 0 && inside.failed > 0 && names.length > 0 && names.every((n) => entry.failing.has(n));
    if ((inside.failed === 0 && inside.passed > 0) || known || signal?.aborted) { settle(true); return { ...inside, sandbox: "on" }; }
    const outside = await runTests(dir, command, signal, timeoutSec, { sandbox: false });
    if (signal?.aborted) { settle(true); return { ...inside, sandbox: "on" }; }
    if (outside.failed < inside.failed || outside.passed > inside.passed) { settle(false); return { ...outside, sandbox: "off" }; }
    for (const n of names) entry.failing.add(n);
    settle(true);
    return { ...inside, sandbox: "on" };
  } finally {
    // Never leave other runs waiting (a throw above); a stopped run decides nothing for later turns.
    settle(true);
    if (signal?.aborted && sandboxChoice.get(project) === entry) { if (before) sandboxChoice.set(project, before); else sandboxChoice.delete(project); }
  }
}

/**
 * Settles the test sandbox for `root` when nothing has yet (see trustedTestRun): the project's tests on a copy with
 * `takeOut` put back to what it was before this turn. Does nothing when it is already settled for this command.
 */
export async function calibrateTestSandbox(root: string, command: string[], timeoutSec: number, signal?: AbortSignal, takeOut: Array<{ path: string; before: string | null }> = []): Promise<void> {
  if (sandboxChoice.get(path.resolve(root))?.command === command.join(" ") || !(await testSandboxAvailable())) return;
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "apex-sandbox-"));
  try {
    const dir = path.join(scratch, "p");
    await copyProject(root, dir);
    for (const c of takeOut) {
      const f = path.resolve(dir, c.path);
      if (!f.startsWith(dir + path.sep)) continue;
      if (c.before === null) await fs.rm(f, { force: true });
      else { await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, c.before); }
    }
    await trustedTestRun(dir, command, signal, timeoutSec);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Runs the project's tests on a copy of the project as it is now (the real folder is never touched, so no
 * approval is needed) and returns the counts with the failing tests' first error lines.
 */
export async function verifyChange(root: string, command: string[], timeoutSec: number, signal?: AbortSignal): Promise<{ passed: number; failed: number; failures: string }> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "apex-verify-"));
  try {
    const dir = path.join(scratch, "p");
    await copyProject(root, dir);
    const t = await runTests(dir, command, signal, timeoutSec);
    return { passed: t.passed, failed: t.failed, failures: t.failed ? failures(t.output, 2500) : "" };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Where a looping answer starts repeating itself: its last 240 characters already appear twice before. -1 if not. */
export function repeatStart(text: string): number {
  const tail = text.slice(-240);
  if (tail.trim().length < 60) return -1;
  const first = text.indexOf(tail);
  if (first < 0 || first >= text.length - 240) return -1;
  const second = text.indexOf(tail, first + 1);
  if (second < 0 || second >= text.length - 240) return -1;
  // Keep through the first copy: what came before the loop plus one round of it.
  return second;
}

/** How many tests failed before a change: the project in a copy with the change taken back out. */
export async function failuresBefore(root: string, changes: Array<{ path: string; before: string | null }>, command: string[], timeoutSec: number, signal?: AbortSignal): Promise<number> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "apex-before-"));
  try {
    const dir = path.join(scratch, "p");
    await copyProject(root, dir);
    for (const c of changes) {
      const f = path.join(dir, c.path);
      if (c.before === null) await fs.rm(f, { force: true });
      else { await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, c.before); }
    }
    return (await runTests(dir, command, signal, timeoutSec)).failed;
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Failing tests only, with their first error lines: what a repair needs, not the whole log. */
export function failures(output: string, max = 4000): string {
  const lines = output.split("\n");
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (/^not ok \d+ - /.test(l)) out.push(l, ...lines.slice(i + 1, i + 14).filter((x) => /error|expected|actual|message|at .*\.(m?js|ts):/i.test(x)).slice(0, 6));
  });
  return (out.join("\n") || output.slice(-max)).slice(0, max);
}

const msg = (role: ModelMessage["role"], content: string): ModelMessage => ({ id: randomUUID(), role, content, createdAt: new Date().toISOString() });


/** Added (+) and removed (-) lines of `after` against `before` (LCS line diff; no context lines). */
export function lineDiff(before: string, after: string): string[] {
  const a = before.split("\n"), b = after.split("\n");
  if (a.length * b.length > 4_000_000) return [...a.map((l) => "- " + l), ...b.map((l) => "+ " + l)];
  const n = a.length, m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { i++; j++; }
    else if (j < m && (i >= n || dp[i][j + 1] > dp[i + 1][j])) out.push("+ " + b[j++]);
    else out.push("- " + a[i++]);
  }
  return out.filter((l) => l.trim() !== "+" && l.trim() !== "-");
}


/**
 * Whether the checks tell the change from no change: true when a check that did not pass on the code before the
 * change (`original`: the checks' output there) passes on the chosen version (`chosen`). False when every passing
 * check passed before as well. Null when it cannot be said (the checks were not run on the original code, or did
 * not load on the version).
 */
export function checksShowChange(original: string | null, chosen: string, expectedLoad?: (error: string) => boolean): boolean | null {
  if (original === null || checksLoadError(chosen) !== null) return null;
  const now = keyedOutcomes(chosen);
  if (!now.size) return null;
  // The file did not load before the change and its tests run now (a name the request adds was missing): they show it.
  const loadError = checksLoadError(original);
  if (loadError !== null) return expectedLoad === undefined || expectedLoad(loadError) || [...now.values()].some((o) => o.ok);
  const before = keyedOutcomes(original);
  return [...now].some(([key, o]) => o.ok && !before.get(key)?.ok);
}

/** Files whose change a test can show (code), as opposed to text and data. */
const CODE_PATH = /\.(m?[jt]sx?|cjs|py|go|rs|java|kt|rb|php|cs|swift|c|cc|cpp|h|hpp|scala|vue|svelte|sh)$/i;

/** A request that asks for the same behaviour in another shape (a rename, a refactor, comments, formatting): its checks pass before and after. */
export function keepsBehaviour(task: string): boolean {
  return KEEPS_BEHAVIOUR.test(task);
}
const KEEPS_BEHAVIOUR = /\b(renam(e|es|ed|ing)|refactor\w*|extract(s|ed|ing)?\s+(\w+\s+){0,2}(function|method|helper|component|class|module|constant|variable|logic|code|hook|type|interface)s?|inline[ds]?|reorgani[sz]\w*|restructur\w*|clean(s|ed|ing)?[ -]?up|simplif\w*|dedup\w*|tidy|mov(e|es|ed|ing)\s+(\w+\s+){0,3}(to|into)\s+(a\s+|the\s+)?(new\s+|separate\s+|its own\s+)?(file|module|folder|directory|package)|migrat\w*|convert(s|ed|ing)?\s+(\w+\s+){0,3}to\s+(typescript|async|await|es\s?modules?|esm|classes|hooks|promises|python\s*3|type\s+hints?)|port(s|ed|ing)?\s+(\w+\s+){0,3}to\b|split(s|ting)?\s+(\w+\s+){0,3}into|optimi[sz]\w*|speed(s|ing)?\s+up|faster|performance|without changing (the |its |any )?behaviou?r|no (behaviou?r|functional) changes?|same behaviou?r|behaviou?r (must |should )?(stays?|remains?) the same|typos?|(add|adding|update|updating|fix|fixing|improve|improving|remove|removing|write|writing|clarify|translate)\s+((the|some|more|missing|explanatory|inline|code|helpful|useful|better|outdated|old)\s+)*comments?|docstrings?|jsdoc|reformat\w*|formatting|lint\w*|type (hints?|annotations?)|deprecat\w*)\b/i;

/**
 * Giving up sooner: answers in a row that are unusable in the same way. A model that twice in a row writes no edit in
 * the required format (the second time after being told so), three times edits of which none applies, or the same
 * answer three times, will not do better on the next version: measured on a small weaker model, six version and
 * repair calls in a row had no edits, and every one of 16 runs spent its whole budget that way.
 * Nothing here knows which model answers. A call that failed (provider error, time limit) is not an answer and is
 * not counted; an answer with at least one edit that applied ends the streak.
 */
export function unusableStreak(): { note(reply: { text: string; edits: number; notApplied: number; errored?: boolean }): void; stop(): string | null } {
  let kind: "" | "no-edits" | "not-applied" | "repeat" = "";
  let count = 0;
  let last = "";
  return {
    note(reply) {
      if (reply.errored) return;
      const text = reply.text.trim();
      const same = text.length > 0 && text === last;
      last = text;
      const now = reply.edits === 0 ? "no-edits" as const : reply.notApplied >= reply.edits ? "not-applied" as const : "" as const;
      if (same) {
        // The same answer again: it continues whatever streak there was; after a usable answer it starts one of two.
        if (kind) count++; else { kind = "repeat"; count = 2; }
        return;
      }
      if (!now) { kind = ""; count = 0; return; }
      if (now === kind) count++; else { kind = now; count = 1; }
    },
    stop() {
      if (kind === "no-edits" && count >= 2) return `the model's last ${count} answers had no edits in the required format`;
      if (kind === "not-applied" && count >= 3) return `none of the edits in the model's last ${count} answers matched the files`;
      if (kind === "repeat" && count >= 3) return `the model gave the same answer ${count} times`;
      return null;
    },
  };
}

export async function surgicalBestOfN(opts: SurgicalOptions): Promise<SurgicalResult> {
  const t0 = Date.now();
  const n = Math.max(1, opts.n ?? 3);
  const testCommand = opts.testCommand ?? ["node", "--test"];
  const testTimeout = opts.testTimeoutSec ?? 90;
  // Task checks are written for node:test or pytest (checkCommand, shared with the proof gate); other runners are
  // judged by the project's own tests alone.
  const checkKind = checkCommand(testCommand, "x");
  const nodeTests = Boolean(checkKind && !checkKind.py);
  const pyTests = Boolean(checkKind?.py);
  const hidden = opts.hidden ?? (() => false);
  const ws = opts.workspace ?? fsWorkspace(opts.root);
  const settings = engineSettings(opts.engine);
  const stats = { modelCalls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  opts.onEvent?.({ kind: "versions", text: `${n} version${n === 1 ? "" : "s"}`, n });
  const graph = graphScope() === "off" ? null : opts.graph !== undefined ? opts.graph : cachedGraph(opts.root);
  const kind = opts.reproFirst ? "fix" as const : "change" as const;
  const compiled = await compileContextX(opts.root, opts.task, opts.budgetChars, { graph, kind, hidden, workspace: ws, taskPack: opts.taskPack, engine: opts.engine });
  const context = compiled.text;
  // Prompt size per part, for the eval trace (calls.jsonl): keyed by the user message a call ends with.
  const segOf = new WeakMap<ModelMessage, Segments>();
  const tagged = (m: ModelMessage, seg: Segments, extra: Segments = {}): ModelMessage => { segOf.set(m, { ...seg, task: opts.task.length, ...extra }); return m; };
  const baseSeg: Segments = { ...compiled.segments, [`form_${compiled.form}`]: 1 };
  // The checks call's own, smaller context (graph policy, scoped form only; see CHECKS_BUDGET).
  const checksCompiled = compiled.form === "scoped" && settings.slimChecks() ? await compileContextX(opts.root, opts.task, settings.checksBudget(), { graph, kind: "checks", hidden, workspace: ws, taskPack: opts.taskPack, engine: opts.engine }).catch(() => compiled) : compiled;
  const checksContext = checksCompiled.form === "scoped" ? checksCompiled.text : context;
  const checksSeg: Segments = checksCompiled.form === "scoped" && checksCompiled !== compiled ? { ...checksCompiled.segments, form_scoped: 1, slim: 1 } : baseSeg;
  const system = msg("system", "You are a senior engineer making a focused change to the project below. " + FORMAT);
  const user = tagged(msg("user", `${context}\n\n<task>\n${opts.task}\n</task>\n\nWrite the edits now.`), baseSeg);


  // Writing edits from a compiled context needs little hidden reasoning; unbounded thinking was most of the time and
  // output tokens on cloud models (web-planner, Flash: ~100k output tokens per run). APEX_SURGICAL_THINKING overrides.
  // Graph policy with a scoped context: a budget by default (graphThinking); the profile's or the caller's number wins.
  const scopedForm = compiled.form !== "legacy";
  const thinkingBudget = opts.thinkingBudget ?? (settings.surgicalThinking() !== undefined ? settings.surgicalThinking() : scopedForm ? settings.graphThinking("edit") : undefined);
  const checksThinking = scopedForm ? settings.graphThinking("checks") : undefined;
  // Cloud prompt caches fill when a request's prompt has been read: versions sent at the same moment all miss it.
  // The first version goes alone; the others start once it answers (its prompt is cached by then), or after a few
  // seconds at most. Measured cachedTokens was 0 for every Flash run with all three sent together.
  let primeDone: () => void = () => {};
  const primed = new Promise<void>((r) => { primeDone = r; });
  // A version call is bounded in time: unbounded thinking on a larger project took 2–4 minutes per call (measured),
  // which used up the whole turn. A call past the limit is stopped and asked once more with little thinking.
  const callMs = (opts.callSeconds ?? (settings.versionCallSeconds() || 150)) * 1000;
  const startedAt = Date.now();
  const overBudget = () => Date.now() - startedAt > (opts.maxSeconds ?? (settings.versionsMaxSeconds() || 360)) * 1000;
  const ask = async (messages: ModelMessage[], i: number, temperature: number, signal: AbortSignal | undefined = opts.signal): Promise<string> => {
    const bounded = boundedCall(signal, callMs);
    try {
      return await askOnce(messages, i, temperature, bounded.signal, thinkingBudget);
    } catch (err) {
      if (!bounded.timedOut() || signal?.aborted) throw err;
      opts.onEvent?.({ kind: "candidate", text: `#${i}: the model took over ${Math.round(callMs / 1000)} s on one answer; asking again with less thinking` });
      const again = boundedCall(signal, callMs);
      try {
        return await askOnce(messages, i, temperature, again.signal, Math.min(thinkingBudget ?? SHORT_THINKING, SHORT_THINKING));
      } catch (err2) {
        if (again.timedOut() && !signal?.aborted) throw new Error(`The model took over ${Math.round(callMs / 1000)} s twice on one answer.`);
        throw err2;
      } finally { again.done(); }
    } finally { bounded.done(); }
  };
  const askOnce = async (messages: ModelMessage[], i: number, temperature: number, signal: AbortSignal | undefined, thinkingBudget: number | undefined): Promise<string> => {
    stats.modelCalls++;
    let text = "";
    let sawUsage = false;
    // The answer is complete at `cut`; the stream is then read on only for its usage event (see DRAIN_CHARS).
    let cut = -1, extra = 0;
    const estimate = () => { if (!sawUsage) { stats.inputTokens += Math.round(JSON.stringify(messages).length / 4); stats.outputTokens += Math.round(text.length / 4); } };
    const segments = segOf.get(messages[messages.length - 1]);
    for await (const ev of opts.gateway.stream({ messages, tools: [], model: opts.model, temperature, slot: i + 1, maxTokens: opts.maxTokens ?? 8192, stop: ["=== END"], ...(thinkingBudget !== undefined ? { thinkingBudget } : {}), ...(segments ? { segments } : {}), signal })) {
      if (ev.type === "text-delta") {
        if (i === 0) primeDone();
        if (cut >= 0) { extra += ev.text.length; if (extra > DRAIN_CHARS) break; continue; }
        text += ev.text;
        // Engines that ignore `stop`, or a model that starts repeating its edits: cut the answer there.
        const end = endOfEdits(text);
        if (end >= 0) {
          // At "=== END" the model is done: wait (briefly) for the usage event. At a repeated edit it is looping: leave.
          const finished = text.indexOf("=== END") >= 0;
          text = text.slice(0, end);
          if (!finished) { estimate(); return text; }
          cut = end; continue;
        }
        // A model caught in a loop (the same lines again and again) runs to the token cap: 8192 tokens is minutes
        // locally (QA: 5 of 6 Qwen calls for a one-line fix). Stop at the first repeat.
        const loop = text.length > 2000 && text.length % 400 < ev.text.length + 1 ? repeatStart(text) : -1;
        if (loop >= 0) { text = text.slice(0, loop); estimate(); return text; }
      }
      if (ev.type === "message-complete" && !text) text = ev.message.content ?? "";
      if (ev.type === "usage") { sawUsage = true; stats.inputTokens += ev.inputTokens ?? 0; stats.cachedTokens += ev.cachedTokens ?? 0; stats.outputTokens += ev.outputTokens ?? 0; if (cut >= 0) break; }
      if (ev.type === "error") throw new Error(ev.message);
    }
    if (cut >= 0) estimate();
    return text;
  };

  // The token cap is higher with a scoped context: measured there, check files ran to 5,000+ characters and one cut
  // at the cap had no closing fence, so no check was usable and the draft went to the step-by-step loop.
  const askChecks = async (messages: ModelMessage[]): Promise<string> => {
    stats.modelCalls++;
    // Done at the closing fence; stop a model that starts repeating lines.
    // (Test files repeat their setup lines, so only a line seen many times counts as a loop.)
    return streamText((opts.checker?.gateway ?? opts.gateway).stream({ messages, tools: [], model: opts.checker?.model ?? opts.model, temperature: 0.3, slot: n + 1, maxTokens: opts.checker ? 16000 : compiled.form === "legacy" ? 1500 : 2200, ...(checksThinking !== undefined ? { thinkingBudget: checksThinking } : {}), segments: { ...checksSeg, task: opts.task.length, checksCall: 1 }, signal: opts.signal }), {
      done: hasFencedBlock, loop: (t) => repeatsALine(t, 8),
      onUsage: (u) => { stats.inputTokens += u.inputTokens; stats.cachedTokens += u.cachedTokens; stats.outputTokens += u.outputTokens; },
    });
  };

  // Task checks: one extra call writes tests from the task alone. They rank candidates; when the task asks for tests
  // and the chosen version passes every check, they are kept as a real test file (see keepChecks).
  const allFiles = await ws.list();
  const examples = await testExamples(opts.root, allFiles, opts.task, Boolean(pyTests), 2, ws);
  const sample = examples[0] ?? null;
  const testDir = allFiles.map((f) => /^(.*\/)?tests?\//.exec(f)?.[0]).find(Boolean) ?? "test/";
  const checkPath = pyTests ? `${testDir === "test/" && !allFiles.some((f) => f.startsWith("test/")) ? "tests/" : testDir}test_apex_task_check.py` : `${testDir}apex-task-check.test.js`;
  const checkRun = checkCommand(testCommand, checkPath)?.run ?? ["node", "--test", checkPath];
  const ownTask = requestOnly(opts.task);
  const wantedExports = namedExports(ownTask);
  // The checks judged: the approved lines, plus a line for each rule of the request none of them covers (coverage
  // gate). A fix gets its edge cases instead (many repeats after a gap, empty input, the result's type).
  const rules = requestRules(ownTask);
  // Approved checks screened again before any can block (a quote the request lacks, a contradiction, a vague line;
  // for a crash report anything beyond "the crash is gone" and "nothing else changed"). Listed as dropped.
  const traced = hasTrace(ownTask);
  const screened = opts.requirements?.length ? screenChecks(ownTask, opts.requirements, { trace: traced }) : { kept: [] as string[], dropped: [] as DroppedCheck[] };
  const droppedChecks = screened.dropped;
  if (droppedChecks.length) opts.onEvent?.({ kind: "checks", text: `Dropped ${droppedChecks.length} check${droppedChecks.length === 1 ? "" : "s"} that could not block the change: ${droppedChecks.map((d) => `${d.text} (${d.reason})`).join("; ")}` });
  const approved = traced && opts.requirements?.length && !screened.kept.length ? traceCheckLines(ownTask) : screened.kept;
  const gate = approved.length && !opts.reproFirst && !traced ? coverageGate(ownTask, approved) : null;
  const addedChecks = gate ? gate.added : [];
  const reqs = approved.length ? [...approved, ...addedChecks] : [];
  if (addedChecks.length) opts.onEvent?.({ kind: "checks", text: `Added ${addedChecks.length} check${addedChecks.length === 1 ? "" : "s"} for rules of the request no check covered: ${addedChecks.join("; ")}` });
  const edgeChecks = opts.reproFirst && !traced ? bugEdgeChecks(ownTask, wantedExports[0] ? await exportParams(opts.root, wantedExports[0].file, wantedExports[0].name, ws) : []) : [];
  const requestedNames = [...new Set([...wantedExports.map((w) => w.name), ...(ownTask.match(/`([A-Za-z_$][\w$]*)\(/g) ?? []).map((m) => m.slice(1, -1))])];
  // The exact imports the checks need, relative to the tests folder, with the [cN] naming: weaker models guessed the
  // path ("../src/priority.js" for src/tasks/priority.js) and left the numbers out, so the whole file failed to load.
  const importHint = checksImportHint(wantedExports, checkPath, Boolean(pyTests), reqs.length, /\brequire\(/.test(sample?.body ?? ""));
  // Its own system prompt: under the edit-maker's prompt, small models solve the task instead of testing it.
  const checkSystem = msg("system", `You write tests; you never change the project's code. Answer with one \`\`\`${pyTests ? "python" : "js"} code block holding the whole new test file, and nothing else.`);
  const checkAsk = msg("user", `${checksContext}\n\n<task>\n${opts.task.replace(/<the whole request, for reference only>[\s\S]*?<\/the whole request>/, "")}\n</task>\n\nDo not solve the task. Write one new test file, ${checkPath}, with ${pyTests ? "pytest (plain assert; import the project's modules the way its code is laid out, adding the project folder to sys.path from the test file's location when needed)" : "node:test and node:assert"}, that checks each requirement of the task against the project's public functions, the way the existing tests do. When the task shows a command line (for example \`node src/main.js --flag file\`), also run exactly that with ${pyTests ? "subprocess.run([sys.executable, ...args], cwd=<the project folder>, capture_output=True, text=True)" : 'execFileSync(process.execPath, [...args], { cwd: <the project folder>, encoding: "utf8" })'} on a small temporary file and check what it prints. Import with paths relative to ${testDir}. List the requirements the task states (each rule, condition, ordering, format, error and status code), then write at least one test per requirement and one for its boundary case (for example a time zone near midnight, empty or missing input, done or overdue items, ties in an ordering, the unauthenticated case). Short and exact; test only what the task states. Prefer assertions that need no guessed exact value: an order between two items, a property every item has, a shape, a count relation, "does not throw"; use exact values only where the task states them.${reqs.length ? `\n\nThe user approved exactly these requirements. Write one test per line below, in this order (no tests outside these numbers). Inside each line's test, also assert its boundary cases the task's rules decide (a time near midnight in the user's time zone, overdue and done items, ties in an ordering, empty input), so each line is checked at its edges, not only on the easy case. Name each test with its number and text, ${pyTests ? "as def test_c<number>_<short_words>() (for example test_c3_rejects_empty_title)" : 'starting with "[c<number>] " (for example test("[c3] rejects an empty title", ...))'}, so each result maps to its line:\n${reqs.map((r, i) => `${i + 1}. ${r.replace(/\s*\(assumed\)\s*/gi, " ").trim()}`).join("\n")}` : rules.length ? `\n\nCover each of these rules of the task with at least one test:\n${rules.map((r) => `- ${r.text}`).join("\n")}` : ""}${importHint}${CHECKS_INPUTS}${SELF_EXCLUSION_HINT}${opts.checker ? CHECKER_EDGE_HINT : ""}${examplesBlock(examples, Boolean(pyTests))}`);
  if (opts.reproFirst) {
    // The bug first: a test that fails now because of it, not tests of every requirement.
    checkAsk.content = `${checksContext}\n\n<bug report>\n${opts.task}\n</bug report>\n\nDo not fix the bug. Write one new test file, ${checkPath}, with ${pyTests ? "pytest (plain assert)" : "node:test and node:assert"}, that reproduces this bug: 1 to 3 tests that FAIL on the code above because of the bug and will pass once it is fixed, plus 1 or 2 tests that pin nearby behaviour that works today and must not change (for example the normal case, formats, numbering or defaults); those pass now and must still pass after the fix. Call the project's real functions, the way its existing tests do; import with paths relative to ${testDir}. Test only the behaviour the report describes.${checksCompiled !== compiled && checksCompiled.form === "scoped" ? examplesBlock(examples.slice(0, 1), Boolean(pyTests), 1500) : ""}\n\nAlso write one test for each of these edge cases (each must pass once the bug is fixed; use the project's own functions, and a loop for repeats):\n${edgeChecks.map((e) => `- ${e}`).join("\n")}`;
  }
  // A working checks file from an earlier turn is reused, never rewritten: only tests for uncovered checks are added.
  const reuse = opts.reuseChecks?.content?.trim() ? opts.reuseChecks.content : null;
  if (reuse) opts.onEvent?.({ kind: "checks", text: "Reusing the checks file from the earlier turn; only adding tests it lacks" });
  const checksText = reuse ? Promise.resolve("```\n" + reuse.replace(/\n+$/, "") + "\n```") : (opts.taskChecks === false && !opts.reproFirst) || !(nodeTests || pyTests) ? Promise.resolve("") : askChecks([checkSystem, checkAsk]).catch(() => "");

  const checkFile: Promise<string | null> = checksText.then((t) => {
    const code = checkCode(t);
    const tests = (code.match(pyTests ? /^\s*def test_/gm : /\b(?:test|it)\(/g) ?? []).length;
    if ((pyTests || /node:test/.test(code)) && tests) { opts.onEvent?.({ kind: "checks", text: `task checks: ${tests} tests` }); return code + "\n"; }
    opts.onEvent?.({ kind: "checks", text: "task checks: none usable" });
    // APEX_SURGICAL_DEBUG=<folder>: the answer no check file could be read from.
    if (settings.debugDir()) void fs.appendFile(path.join(settings.debugDir()!, "checks-unusable.txt"), `--- ${tests} tests found\n${t}\n`).catch(() => undefined);
    return null;
  });
  // Reproduce: the test must fail on the code as it is now; otherwise it does not capture the bug and only the
  // project's tests judge the versions.
  let reproCode: string | null = null;
  // The checks run on the ORIGINAL code: a check that fails there for the reason the request explains has proven itself.
  let originalRun: string | null = null;
  const reproduced: Promise<boolean> = !opts.reproFirst ? Promise.resolve(false) : checkFile.then(async (code) => {
    if (!code) { opts.onEvent?.({ kind: "checks", text: "Could not write a test that reproduces the bug; judging by the project's tests" }); return false; }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "apex-repro-"));
    try {
      await copyProject(opts.root, dir);
      await fs.mkdir(path.dirname(path.join(dir, checkPath)), { recursive: true });
      await fs.writeFile(path.join(dir, checkPath), selfExcludingChecks(code, Boolean(pyTests)));
      let r = await runTests(dir, checkRun, opts.signal);
      // A test that passes on the buggy code reproduces nothing: show the model what happened and ask once more.
      if (r.failed === 0 && !opts.signal?.aborted) {
        opts.onEvent?.({ kind: "checks", text: "The first test did not reproduce the bug; asking again with what it showed" });
        const retry = checkCode(await askChecks([checkSystem, msg("user", `${checkAsk.content}\n\nYour first attempt below PASSED on the current code, so it does not reproduce the bug. Write a test that fails now because of the bug described (call the code path the report describes, with the inputs it describes).\n\n<your first attempt>\n${code}\n</your first attempt>\n<its output on the current code>\n${r.output.slice(-1500)}\n</its output on the current code>`)]).catch(() => ""));
        if (retry && (pyTests || /node:test/.test(retry))) {
          await fs.writeFile(path.join(dir, checkPath), selfExcludingChecks(retry + "\n", Boolean(pyTests)));
          const r2 = await runTests(dir, checkRun, opts.signal);
          if (r2.failed > 0) { r = r2; reproCode = retry + "\n"; }
        }
      }
      const ok = r.failed > 0;
      originalRun = r.output;
      opts.onEvent?.({ kind: "checks", text: ok ? `Reproduced the bug: ${r.failed === 1 ? "1 test fails" : `${r.failed} tests fail`} on the current code` : "The test written for the bug passes on the current code, so it does not reproduce it; judging by the project's tests" });
      return ok;
    } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined); }
  });
  // A part of a larger request carries the whole request for reference: only the part itself names what this call
  // must export and touch.
  const fixTask = /\b(fix(es|ed|ing)?|fail(s|ing|ed|ure)?|broken|bugs?|errors?|crash(es|ing)?|pass(es|ing)?)\b/i.test(opts.task);
  // The project's tests as they are now, run once beside the model calls, on a copy: the project's own folder is
  // never run in (a test run may write files there).
  const baselineRun = async (): Promise<{ output: string }> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "apex-base-"));
    try {
      await copyProject(opts.root, path.join(dir, "p"));
      // The project as it is, before any version: this run also settles whether its tests run inside the test sandbox.
      const t = await trustedTestRun(path.join(dir, "p"), testCommand, opts.signal, testTimeout);
      if (t.sandbox === "off") opts.onEvent?.({ kind: "checks", text: "The project's tests need something the test sandbox denies (another machine, or files outside the project); running them outside it" });
      return t;
    }
    finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined); }
  };
  const baseline: Promise<Set<string>> = (opts.checksOnly ? Promise.resolve({ output: "" }) : baselineRun()).then((t) => {
    const names = new Set(failedNames(t.output));
    if (names.size && !fixTask) opts.onEvent?.({ kind: "checks", text: `${names.size} test${names.size === 1 ? "" : "s"} already failed before the change; not counted against a version` });
    return names;
  }, () => new Set<string>());
  // Source files the task names by path or file name.
  // By its path, or by its file name alone. A file name the task writes as part of another file's path (or that is
  // a file at the project's top) names that file, not every file called the same (measured: "classes/semver.js"
  // and "index.js" in the task made bin/semver.js and classes/index.js "named", and a correct version was sent to
  // repair for not touching them).
  const namedInTask = allFiles.filter((f) => !hidden(f) && !/\.test\.[mc]?[jt]s$/.test(f) && f.includes("/") && (ownTask.includes(f) || (new RegExp(`(^|[\\s\`'"(/])${path.basename(f).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[\\s\`'".,;:)])`).test(ownTask) && !allFiles.some((g) => g !== f && path.basename(g) === path.basename(f) && ownTask.includes(g)))));
  // The chosen version passes the project's tests but fails most of the checks written from the task: worth one
  // repair round. A single failing check among several passing ones is more often a wrong check.
  // Except when every version written independently fails a check: agreement means the check is probably right
  // (measured on web-planner: all 3 Flash versions failed the same rule check, and so did the hidden test).
  const evaluated: CandidateResult[] = [];
  const failingNames = (c: CandidateResult) => new Set((c.checksOutput ?? "").split("\n").map((l) => l.trimStart()).filter((l) => /^not ok \d+ - /.test(l)).map((l) => l.replace(/^not ok \d+ - /, "").trim()));
  const sharedCheckFailure = (c: CandidateResult) => {
    const first = evaluated.filter((x) => !x.repaired && x.checksPassed !== undefined);
    if (first.length < 2 || !first.every((x) => (x.checksFailed ?? 0) > 0)) return false;
    const mine = failingNames(c);
    return [...mine].some((n) => first.every((x) => failingNames(x).has(n))) || !mine.size;
  };
  const reproOk = await reproduced;
  // A reproduction that only the retry produced replaces the first test file everywhere it is used.
  // Before any version is scored: the checks file must load on the original code (assertions failing there is
  // expected for new behaviour; a syntax error, a wrong import path or export name is not), and must hold one
  // "[cN] " test per approved check. Repaired by the model up to twice; one more call writes missing checks.
  const dirs = new Set(allFiles.map((f) => path.dirname(f)));
  const newNamed = [...new Set(ownTask.match(/[\w-]+(?:\/[\w.-]+)+\.(?:m?[jt]sx?|cjs|py|html|css|go|rs|java|kt|rb)\b/g) ?? [])]
    .filter((f) => !allFiles.includes(f) && dirs.has(path.dirname(f)) && !/\.test\.|(^|\/)tests?\//.test(f));
  let checksError: string | undefined;
  let checksNotLoaded: string | undefined;
  const finalCheckFile: Promise<string | null> = (reproCode ? Promise.resolve(reproCode) : checkFile).then(async (code) => {
    if (!code || opts.reproFirst) return code;
    const v = await validateChecks(code, {
      reuse: Boolean(reuse),
      run: async (c) => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "apex-checks-"));
        try {
          await copyProject(opts.root, dir);
          await fs.mkdir(path.dirname(path.join(dir, checkPath)), { recursive: true });
          await fs.writeFile(path.join(dir, checkPath), selfExcludingChecks(c, Boolean(pyTests)));
          return (await runTests(dir, checkRun, opts.signal)).output;
        } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined); }
      },
      ask: async (prompt) => checkCode(await askChecks([checkSystem, msg("user", `${checkAsk.content}\n\n${prompt}`)]).catch(() => "")),
      count: reqs.length,
      py: Boolean(pyTests),
      expected: expectedLoadError(wantedExports, newNamed),
      onEvent: (text) => opts.onEvent?.({ kind: "checks", text }),
    });
    if (v.error) { checksError = v.error; checksNotLoaded = v.error; }
    if (v.original !== undefined) originalRun = v.original;
    return v.error ? null : v.code;
  });
  const checksWorthFixing = (c: CandidateResult) => c.failed === 0 && (c.checksFailed ?? 0) > 0 && (opts.checksOnly === true || reproOk || Boolean(opts.requirements?.length) || (c.checksFailed ?? 0) >= (c.checksPassed ?? 0) || sharedCheckFailure(c));
  let evalCount = 0;
  // New files the task names by path in a folder the project already has (public/index.html when public/ exists):
  // a version that does not create them skipped part of the job (measured: a weaker model asked for the frontend
  // edited only src/server.js, and passed its checks).
  const scopeOn = opts.scopeGuard !== false;
  const targets = scopeOn ? (opts.scopeTargets ?? (await taskPackProvider(opts.taskPack)(opts.root, ownTask, hidden, 5000).catch(() => ({ packFiles: [] as string[] }))).packFiles.filter((f) => !namedInTask.includes(f)).slice(0, 3)) : [];
  const scope = scopeOn ? requestScope({ named: namedInTask, newNamed, targets, extra: [checkPath] }) : new Set<string>();
  // Without named files or targets there is nothing to compare against: the guard stays off.
  if (scopeOn && !namedInTask.length && !newNamed.length && !targets.length) scope.clear();
  // A request for a change across the project ("rename X everywhere", "in all files") has no file list to hold edits
  // to: the guard would drop exactly the places the user asked for (QA: __init__.py and the docs left out of a rename).
  const projectWide = /\b(everywhere|every (file|place|use|usage|occurrence|reference)|all (files|places|uses|usages|occurrences|references)|across the (project|codebase|repo)|rename\b)/i.test(opts.task);
  const outside = (edits: FileEdit[]) => (projectWide ? [] : outOfScope(edits.map((e) => e.path), scope));
  const skippedIn = (edits: FileEdit[]) => (edits.length ? [...namedInTask, ...newNamed].filter((f) => !edits.some((e) => e.path === f) && !opts.alreadyChanged?.includes(f)) : []);
  // Spec first: the checks are written before the versions and shown to the writer, so it codes against concrete
  // examples instead of its own reading of the task. (Without this the checks are written beside the versions and
  // only used to rank them afterwards.)
  // A reproduced bug: the writer sees the failing test, so it fixes the cause the test shows.
  if (opts.specFirst || opts.requirements?.length || reproOk) {
    const spec = await finalCheckFile;
    if (spec) user.content = user.content.replace("\n\nWrite the edits now.", `\n\n<acceptance tests written from the task, as ${checkPath}>\n${spec.trim()}\n</acceptance tests>\nYour change must make every one of these pass, and keep the project's existing tests passing. They will be run against your change. Do not create this test file yourself.\n\nWrite the edits now.`);
  }

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "apex-surgical-"));
  // Every checks run so far: a check some version passes has proven it can pass.
  const checkRuns: string[] = [];
  const expectedOriginal = expectedLoadError(wantedExports, newNamed);
  const proofNow = (): CheckProof => ({ proven: provenKeys(originalRun, checkRuns, requestedNames, expectedOriginal), passed: passedKeys(checkRuns), names: requestedNames });
  let interfaceRepairs = 0;
  const evaluate = async (index: number, edits: FileEdit[], base: string, repaired: boolean): Promise<CandidateResult & { dir: string }> => {
    // Its own folder for every evaluation: a second repair of the same version used to get the folder it was
    // being copied from ("cp: src and dest cannot be the same"), which failed the whole run.
    const dir = path.join(scratch, `c${index}${repaired ? "r" : ""}-${++evalCount}`);
    await copyProject(base, dir);
    const { errors } = await applyEdits(dir, edits, { secretMark: settings.secretMark() });
    // Interface first, without running anything: every export the request names must be there by that exact name.
    // A miss is repaired at once (measured: 8+ runs had hidden tests 0/5 and existing tests 5/5 because the
    // function had another name).
    const missingFirst = edits.length && wantedExports.length && interfaceRepairs < 2 ? await missingExports(dir, wantedExports) : [];
    if (missingFirst.length) {
      opts.onEvent?.({ kind: "candidate", text: `#${index}${repaired ? " repaired" : ""}: the interface the request names is missing (${missingFirst.join("; ")}); not running the tests` });
      return { index, edits, applyErrors: errors, passed: 0, failed: missingFirst.length, testOutput: missingFirst.map((m) => `not ok 0 - interface: ${m}`).join("\n"), repaired, dir, interfaceMissing: missingFirst };
    }
    // No tests of its own (checksOnly): nothing to run but the checks (pytest exits 5 on "no tests collected").
    const t: { passed: number; failed: number; output: string; exitCode?: number | null; seconds?: number } = !edits.length ? { passed: 0, failed: 1, output: "no edits" } : opts.checksOnly ? { passed: 0, failed: 0, output: "" } : await runTests(dir, testCommand, opts.signal, testTimeout);
    // Tests that already failed before the change are not held against a version: only failures it adds count.
    // (Without this, one failing test in a project meant no version could ever be accepted.)
    // Not when the task is to fix something: there the failing tests are the point, and every one must pass.
    const already = fixTask ? new Set<string>() : await baseline;
    if (edits.length && already.size) {
      const now = failedNames(t.output);
      const added = now.filter((n) => !already.has(n)).length;
      t.failed = Math.max(0, t.failed - (now.length - added));
    }
    // A file the task names must be touched: a version that skips one did half the job (the miss on 3-file changes).
    const skipped = repaired ? [] : skippedIn(edits);
    // The tests may not load every changed file: a file that does not even parse fails the version.
    const changedFiles = [...new Set(edits.map((e) => e.path))];
    // Files node cannot parse even untouched (JSX or Flow in .js) are not held against the version.
    const alreadyBroken = new Set((edits.length ? await syntaxErrors(opts.root, changedFiles) : []).map((l) => l.split(": ")[0]));
    const broken = (edits.length ? await syntaxErrors(dir, changedFiles) : []).filter((l) => !alreadyBroken.has(l.split(": ")[0]));
    if (broken.length) { t.failed += broken.length; t.output = `${broken.join("\n")}\n${t.output}`; }
    const syntax = broken;
    // The interface the task names (exported function, file, parameters): checked without a model.
    const missing = edits.length && wantedExports.length ? await missingExports(dir, wantedExports) : [];
    if (missing.length) { t.failed += missing.length; t.output = `${missing.map((m) => `not ok 0 - interface: ${m}`).join("\n")}\n${t.output}`; }
    let checks: { passed: number; failed: number; output?: string } | null = null;
    const check = await finalCheckFile;
    if (check && edits.length) {
      await fs.mkdir(path.dirname(path.join(dir, checkPath)), { recursive: true });
      await fs.writeFile(path.join(dir, checkPath), selfExcludingChecks(check, Boolean(pyTests)));
      checks = await runTests(dir, checkRun, opts.signal);
      await fs.rm(path.join(dir, checkPath), { force: true });
      // Only a check that has proven itself counts as failed; the others are pending, never a reason to hold.
      checkRuns.push(checks.output ?? "");
      const adj = adjudicate(checks.output ?? "", proofNow());
      if (checksLoadError(checks.output ?? "") === null && (adj.passed + adj.provenFailed.length + adj.unprovenFailed.length) > 0) {
        checks.passed = adj.passed;
        checks.failed = adj.provenFailed.length;
      }
    }
    opts.onEvent?.({ kind: "candidate", text: `#${index}${repaired ? " repaired" : ""}: ${edits.length} edits, ${errors.length} not applied, tests ${t.passed} ok / ${t.failed} failed${checks ? `, task checks ${checks.passed} ok / ${checks.failed} failed` : ""}` });
    // APEX_SURGICAL_DEBUG=<folder>: the edits that did not apply, for diagnosing a context that lacked text.
    if (errors.length && settings.debugDir()) await fs.appendFile(path.join(settings.debugDir()!, "apply-errors.txt"), `--- version ${index}${repaired ? " (repair)" : ""}\n${errors.join("\n")}\n`).catch(() => undefined);
    return { index, edits, applyErrors: errors, passed: t.passed, failed: t.failed, testOutput: t.output, repaired, dir, ...(syntax.length ? { syntax } : {}), ...(skipped.length ? { skippedNamed: skipped } : {}), ...(outside(edits).length ? { outOfScope: outside(edits) } : {}), ...(checks ? { checksPassed: checks.passed, checksFailed: checks.failed, checksRun: checks.output ?? "", ...(checks.failed ? { checksOutput: checks.output ?? "" } : {}) } : {}), ...(t.seconds !== undefined ? { testSeconds: t.seconds, testExitCode: t.exitCode ?? null } : {}) };
  };
  // The project's tests decide; task checks (possibly wrong themselves) only break ties between equal test results.
  /** S* tie-break: one short call writes probe inputs from the request; each passing version runs them; the majority wins. */
  const tieBreak = async (passing: Array<CandidateResult & { dir: string }>): Promise<(CandidateResult & { dir: string }) | null> => {
    const imports = [...new Set(wantedExports.map((w) => w.file))].map((f) => `import { ${wantedExports.filter((w) => w.file === f).map((w) => w.name).join(", ")} } from "./${f}";`).join("\n");
    stats.modelCalls++;
    let text = "";
    for await (const ev of (opts.checker?.gateway ?? opts.gateway).stream({ messages: [
      msg("system", "You write one short probe script; you never change the project."),
      msg("user", `<task>\n${ownTask.slice(0, 2000)}\n</task>\n\nWrite an ES module script, run from the project folder, that starts with exactly:\n${imports}\nand then calls these functions on 4 to 6 inputs where two implementations of this task could differ (the boundaries and ties the task's rules decide: empty input, equal keys, a time near midnight in another time zone, done or overdue items). Build inputs with the project's own functions where needed. Use fixed dates, never Date.now() or random. Wrap each call in try/catch and print one line per call: console.log(JSON.stringify(result)) or console.log("throws " + e.name). Answer with one \`\`\`js block only.`),
    ], tools: [], model: opts.checker?.model ?? opts.model, temperature: 0.2, maxTokens: opts.checker ? 8000 : 900, signal: opts.signal })) {
      if (ev.type === "text-delta") text += ev.text;
      if (ev.type === "usage") { stats.inputTokens += ev.inputTokens ?? 0; stats.outputTokens += ev.outputTokens ?? 0; }
      if (ev.type === "error") return null;
    }
    const probe = checkCode(text);
    if (!probe.trim()) return null;
    const outputs = await Promise.all(passing.map(async (c) => {
      const file = path.join(c.dir, ".apex-probe.mjs");
      try {
        await fs.writeFile(file, probe);
        // A script the model wrote: inside the test sandbox where there is one.
        const cmd = (await testSandboxAvailable()) ? inTestSandbox(testSandboxProfile({ writable: [c.dir], readable: [projectOf(c.dir)] }), process.execPath, [file]) : { file: process.execPath, args: [file] };
        const r = await runCommand(cmd.file, cmd.args, { cwd: c.dir, timeoutMs: 15_000, maxBuffer: 1 << 20, env: runEnv() });
        return r.failed ? null : r.stdout;
      } catch { return null; } finally { await fs.rm(file, { force: true }); }
    }));
    const group = majorityGroup(outputs);
    if (group.length === passing.length) return null;
    return group.map((i) => passing[i]).reduce((a, b) => (score(b) > score(a) ? b : a));
  };
  const score = (c: CandidateResult) => (c.edits.length ? 1000 : 0) + c.passed * 10 - c.failed * 10 - c.applyErrors.length * 0.5 + (c.checksPassed ?? 0) - (c.checksFailed ?? 0) * 0.5 - (c.skippedNamed?.length ?? 0) * 3 - (c.outOfScope?.length ?? 0) * 4;

  try {
    // Temperatures spread so candidates differ; the first stays near-greedy.
    // Each version is tested as soon as it is written. The first one that passes everything (applies cleanly, the
    // project's tests, every task check, every named file) ends the wait: the versions still being written are
    // cancelled instead of everyone waiting for the slowest. Deep modes and the background review read all
    // versions, so they keep them all.
    const firstWins = n > 1 && opts.firstPassingWins !== false;
    const others = new AbortController();
    const onStop = () => others.abort();
    opts.signal?.addEventListener("abort", onStop, { once: true });
    // An edit that did not apply does not matter once the tests and the checks written from the request all pass
    // without it (measured: a passing version was sent to a 4-minute repair for one such edit).
    const provenWithout = (c: CandidateResult) => c.failed === 0 && c.passed > 0 && (c.checksPassed ?? 0) > 0 && (c.checksFailed ?? 0) === 0 && c.applyErrors.length < c.edits.length;
    const clean = (c: CandidateResult) => c.edits.length > 0 && (!c.applyErrors.length || provenWithout(c)) && c.failed === 0 && (c.passed > 0 || (opts.checksOnly === true && (c.checksPassed ?? 0) > 0)) && !c.skippedNamed?.length && !c.syntax?.length && (c.checksFailed ?? 0) === 0;
    const candidates: Array<CandidateResult & { dir: string }> = [];
    let secondLook: { verdict: "test" | "code" | "unknown"; reason: string } | null = null;
    let settled: (CandidateResult & { dir: string }) | null = null;
    let judging = false;
    // Adaptive attempts run one after another, so "in a row" is well defined there (see unusableStreak).
    const streak = unusableStreak();
    let gaveUp: string | null = null;
    let lastRepair: { text: string; edits: number; notApplied: number; errored: boolean } | null = null;
    // One repair round on a version: the failing assertions (trimmed), the source of the files it changed and of the
    // helpers they import or the failure names, and a one-line worked example when a check has concrete values.
    const repairOnce = async (c: CandidateResult & { dir: string }): Promise<CandidateResult & { dir: string }> => {
      const changed = [...new Set(c.edits.map((e) => e.path))];
      const failureText = `${c.testOutput}\n${c.checksOutput ?? ""}\n${c.applyErrors.join("\n")}`;
      const helpers: string[] = [];
      for (const f of [...changed, ...namedInTask]) for (const h of await resolveImports(c.dir, f).catch(() => [] as string[])) if (!helpers.includes(h) && !changed.includes(h)) helpers.push(h);
      // With the graph: an edit that did not apply (or no edit at all) means the writer lacked the text it needed, so
      // the repair gets the wider whole-files form; a failing test gets the changed files, large ones in part.
      const lacked = !c.edits.length || c.applyErrors.length > 0;
      const freshC: Compiled = c.edits.length && !c.skippedNamed?.length && !c.interfaceMissing?.length && !(graph && lacked)
        ? await focusedContextX(c.dir, [...changed, ...helpers], failureText, graph ? Math.min(opts.budgetChars ?? 40_000, FILES_BUDGET + 4000) : opts.budgetChars, graph ? { edits: c.edits, names: codeNames(ownTask) } : undefined, hidden)
        : await compileContextX(c.dir, opts.task, opts.budgetChars, { graph, kind, hidden, ...(graph && lacked ? { form: "files" as const } : {}) });
      const fresh = freshC.text;
      const example = checksWorthFixing(c) ? workedExample(c.checksOutput ?? "") : "";
      const problem = [
        c.interfaceMissing?.length ? `The task names this interface, and your change does not provide it with that exact name and export:\n${c.interfaceMissing.join("\n")}\nAdd or rename it exactly as the task says (same name, exported from that file, same parameters).` : "",
        c.applyErrors.length ? `These edits could not be applied:\n${c.applyErrors.join("\n")}` : "",
        c.syntax?.length ? `These files no longer parse after your change (count the brackets on that line):\n${c.syntax.join("\n")}` : "",
        !c.interfaceMissing?.length && c.failed > (c.syntax?.length ?? 0) ? `Failing tests after your change:\n${failures(c.testOutput, 2500)}` : "",
        !c.edits.length ? "Your answer had no edits in the required format." : "",
        checksWorthFixing(c) ? `These checks, written from the task, fail on your change (a check can be wrong: fix the code only where the task supports the check):\n${failures(c.checksOutput ?? "", 2500)}${example ? `\n${example}` : ""}` : "",
        c.skippedNamed?.length ? `The task names ${c.skippedNamed.join(", ")}, which you did not create or change. Write those files too, as the task asks.` : "",
        helpers.length ? `The helpers your code uses (${helpers.join(", ")}) are in the files above: read what they return before changing how you call them.` : "",
      ].filter(Boolean).join("\n\n");
      if (c.interfaceMissing?.length) interfaceRepairs++;
      let errored = false;
      const fix = await ask([system, tagged(msg("user", `${fresh}\n\n<task>\n${opts.task}\n</task>\n\n${problem}\n\nThe files above already include your earlier change. Write only the edits that fix this.`), { ...freshC.segments, [`form_${freshC.form}`]: 1 }, { repair: 1, problem: problem.length })], c.index, 0.15).catch(() => { errored = true; return ""; });
      const r = await evaluate(c.index, parseEdits(fix), c.dir, true);
      lastRepair = { text: fix, edits: r.edits.length, notApplied: r.applyErrors.length, errored };
      r.edits = [...c.edits, ...r.edits];
      r.skippedNamed = skippedIn(r.edits);
      return r;
    };
    const needsRepair = (c: CandidateResult) => c.failed > 0 || (c.applyErrors.length > 0 && !provenWithout(c)) || !c.edits.length || (c.skippedNamed?.length ?? 0) > 0 || Boolean(c.interfaceMissing?.length) || checksWorthFixing(c);
    const whyRepair = (c: CandidateResult) => [c.failed > 0 ? `${c.failed} failing` : "", c.applyErrors.length > 0 && !provenWithout(c) ? `${c.applyErrors.length} edits did not apply` : "", !c.edits.length ? "no edits" : "", c.skippedNamed?.length ? `did not touch ${c.skippedNamed.join(", ")}` : "", c.interfaceMissing?.length ? "the named interface is missing" : "", checksWorthFixing(c) ? `${c.checksFailed} checks fail` : ""].filter(Boolean).join("; ");
    // Framings for later attempts: a different emphasis, not the same prompt again (diverse sampling).
    const framings = [
      "",
      `\n\nBefore writing, go through each rule the task states and find the line of code where it must hold${rules.length ? `:\n${rules.map((r) => `- ${r.text}`).join("\n")}\n` : ". "}Then write the smallest edits that make every rule true, reusing the helpers the files already import.`,
      "\n\nWork from the tests: read the existing tests and the acceptance tests above, and make each one pass in turn. Use exactly the names, exports and parameters the task gives.",
    ];
    // Graph policy, escalation: the first version works from the scoped context. A later one is only written when
    // that did not pass, so it gets the wide context (whole files up to the full budget, as without the graph):
    // what the first lacked may be code the scope left out. With all versions written at once, only the last does.
    let wideP: Promise<Compiled> | null = null;
    const wide = (i: number) => compiled.form !== "legacy" && i > 0 && (opts.adaptive || i === n - 1);
    const framed = async (i: number): Promise<ModelMessage> => {
      if (!(i > 0 && (framings[i % framings.length] || wide(i)))) return user;
      const base = wide(i) ? await (wideP ??= compileContextX(opts.root, opts.task, opts.budgetChars, { graph: null, hidden, workspace: ws, taskPack: opts.taskPack, engine: opts.engine })) : null;
      const content = base ? `${base.text}\n\n<task>\n${opts.task}\n</task>\n\nWrite the edits now.` : user.content;
      return tagged(msg("user", content.replace("\n\nWrite the edits now.", `${framings[i % framings.length]}\n\nWrite the edits now.`)), base ? { ...base.segments, form_wide: 1 } : baseSeg);
    };
    // The second look (opts.secondLook), taken once: on the first version that the project's tests accept while a
    // minority of proven checks fail. Measured without it (Flash, large set): repair, two more versions on the wide
    // context and their repairs all failed the same wrong check, 55-65k input tokens, before the draft was kept anyway.
    const judgeOnce = async (c: CandidateResult & { dir: string }): Promise<void> => {
      if (secondLook || judging || !opts.secondLook || opts.checksOnly) return;
      const bad = c.checksFailed ?? 0;
      if (!(c.edits.length && !c.applyErrors.length && c.failed === 0 && c.passed > 0 && bad > 0 && (c.checksPassed ?? 0) > bad && !c.skippedNamed?.length && !c.syntax?.length && !c.interfaceMissing?.length)) return;
      // Taken once: two versions finishing together must not both ask.
      judging = true;
      const check = await finalCheckFile;
      if (!check) { judging = false; return; }
      const changed: Array<{ path: string; before: string | null; after: string }> = [];
      for (const rel of new Set(c.edits.map((e) => e.path))) changed.push({ path: rel, before: await ws.read(rel), after: await fs.readFile(path.join(c.dir, rel), "utf8").catch(() => "") });
      stats.modelCalls++;
      secondLook = await judgeFailingChecks({ gateway: opts.checker?.gateway ?? opts.gateway, model: opts.checker?.model ?? opts.model, task: opts.task, changes: changed, checksFile: check, failureOutput: c.checksOutput ?? "", passed: c.checksPassed ?? 0, failed: bad, signal: opts.signal, onUsage: (u) => { stats.inputTokens += u.inputTokens; stats.cachedTokens += u.cachedTokens; stats.outputTokens += u.outputTokens; } });
      opts.onEvent?.({ kind: "checks", text: secondLook.verdict === "test" ? `A second look: the failing check${bad === 1 ? " looks" : "s look"} wrong, not the change (${secondLook.reason.slice(0, 160)}); no more versions` : `A second look: the change looks incomplete${secondLook.reason ? ` (${secondLook.reason.slice(0, 160)})` : ""}` });
      if (secondLook.verdict === "test") settled = c;
    };
    const attempt = async (i: number, temperature: number, signal?: AbortSignal, ownRepairs = 0) => {
      const text = await ask([system, await framed(i)], i, temperature, signal).catch((e) => `ERROR ${e}`);
      if (signal?.aborted && /^ERROR/.test(text)) return null; // cancelled because another version already passed
      let c = await evaluate(i, parseEdits(text), opts.root, false);
      candidates.push(c);
      evaluated.push(c);
      const gaveUpNow = () => {
        if (!opts.adaptive || gaveUp) return Boolean(gaveUp);
        gaveUp = streak.stop();
        if (gaveUp) opts.onEvent?.({ kind: "candidate", text: `Stopping the versions here: ${gaveUp}` });
        return Boolean(gaveUp);
      };
      streak.note({ text, edits: c.edits.length, notApplied: c.applyErrors.length, errored: /^ERROR /.test(text) });
      if (gaveUpNow()) return c;
      await judgeOnce(c);
      if (settled) return c;
      // An interface miss is repaired at once (cheap: no test run); then up to `ownRepairs` repair rounds.
      for (let r = 0; r < ownRepairs + (c.interfaceMissing?.length ? 1 : 0) && needsRepair(c) && !signal?.aborted && !overBudget(); r++) {
        opts.onEvent?.({ kind: "candidate", text: `#${i}: one repair round (${whyRepair(c)})` });
        lastRepair = null;
        const fixed = await repairOnce(c);
        candidates.push(fixed);
        if (lastRepair) streak.note(lastRepair);
        if (gaveUpNow()) { if (score(fixed) >= score(c)) c = fixed; break; }
        const stalled = !c.interfaceMissing?.length && fixed.failed + (fixed.checksFailed ?? 0) >= c.failed + (c.checksFailed ?? 0);
        if (score(fixed) >= score(c)) c = fixed;
        // Stall stop: a round that did not reduce failing tests + checks ends the repairs (a fresh attempt is better).
        if (stalled) break;
      }
      return c;
    };
    if (opts.adaptive) {
      // One attempt first (weaker models share one slot, so attempts run one after another); more only on failure.
      const ownRepairs = Math.min(2, opts.repairs ?? 2);
      const first = await attempt(0, 0.15, opts.signal, ownRepairs);
      if (!(first && clean(first)) && !settled && !gaveUp && n > 1 && !opts.signal?.aborted && !overBudget()) {
        opts.onEvent?.({ kind: "candidate", text: "The first version did not pass everything; writing other versions with different framings" });
        for (let i = 1; i < n && !opts.signal?.aborted && !overBudget(); i++) {
          const c = await attempt(i, 0.15 + (0.6 * i) / (n - 1), opts.signal, ownRepairs);
          if ((c && clean(c)) || settled || gaveUp) break;
        }
      }
    } else {
      await Promise.all(Array.from({ length: n }, async (_, i) => {
        if (i > 0 && opts.staggerForCache) await Promise.race([primed, new Promise((r) => setTimeout(r, 6000))]);
        const c = await attempt(i, n === 1 ? 0.15 : 0.15 + (0.6 * i) / (n - 1), others.signal, 0);
        if (settled && !others.signal.aborted) others.abort();
        if (c && firstWins && clean(c) && !others.signal.aborted) {
          opts.onEvent?.({ kind: "candidate", text: `#${i} passes everything; not waiting for the others` });
          others.abort();
        }
      }));
    }
    opts.signal?.removeEventListener("abort", onStop);
    if (opts.signal?.aborted) throw new Error("Cancelled.");
    candidates.sort((a, b) => a.index - b.index || Number(a.repaired) - Number(b.repaired));
    if (!candidates.length) candidates.push(await evaluate(0, [], opts.root, false));
    let best = candidates.reduce((a, b) => (score(b) > score(a) ? b : a));
    // The second look blamed the checks: that version is the result (a later one cannot do better on a wrong check).
    if (settled && !candidates.some(clean)) best = settled;
    // Several versions pass everything: run inputs on which they may differ, keep the majority's behaviour (S*).
    const passingAll = candidates.filter(clean);
    if (passingAll.length >= 2 && opts.tieBreak !== false && nodeTests && wantedExports.length && !opts.signal?.aborted) {
      const pick = await tieBreak(passingAll).catch(() => null);
      if (pick && pick !== best) { best = pick; opts.onEvent?.({ kind: "candidate", text: `#${pick.index} kept: most passing versions behave like it on inputs where they could differ` }); }
    }

    // Repairs on the best version (parallel mode; adaptive attempts were repaired as they went). At most 2 rounds:
    // self-repair saturates after 2-3 rounds, and a fresh attempt is the better next step.
    // Not after a second look that blamed the checks: a repair would bend the change toward a check judged wrong.
    for (let r = 0; !opts.adaptive && !settled && r < Math.min(2, opts.repairs ?? 1) + (best.syntax?.length ? 1 : 0) && needsRepair(best) && !opts.signal?.aborted && !overBudget(); r++) {
      const repaired = await repairOnce(best);
      candidates.push(repaired);
      const stalled = !best.interfaceMissing?.length && repaired.failed + (repaired.checksFailed ?? 0) >= best.failed + (best.checksFailed ?? 0);
      if (score(repaired) >= score(best)) best = repaired;
      if (stalled) { opts.onEvent?.({ kind: "candidate", text: "The repair did not reduce the failures; stopping repairs and keeping the best version" }); break; }
    }

    // Scope guard: edits to files the request does not need are dropped, unless the tests fail without them.
    let droppedOutOfScope: string[] | undefined, keptOutOfScope: string[] | undefined;
    const extraFiles = best.edits.length ? outside(best.edits) : [];
    if (extraFiles.length) {
      const trimmed = best.edits.filter((e) => !extraFiles.includes(e.path));
      const t = trimmed.length ? await evaluate(best.index, trimmed, opts.root, best.repaired) : null;
      if (t && !t.applyErrors.length && t.failed === 0 && (t.checksFailed ?? 0) <= (best.checksFailed ?? 0) && !t.syntax?.length) {
        best = t; droppedOutOfScope = extraFiles;
        opts.onEvent?.({ kind: "scope", text: `left out changes to ${extraFiles.join(", ")}: the request does not need them and the tests pass without them` });
      } else {
        keptOutOfScope = extraFiles;
        opts.onEvent?.({ kind: "scope", text: `kept changes to ${extraFiles.join(", ")}: the request does not name them, but the tests need them` });
      }
    }

    // The chosen version's checks judged with everything known now (a check another version passed has proven itself).
    if (best.checksRun !== undefined && checksLoadError(best.checksRun) === null) {
      const adj = adjudicate(best.checksRun, proofNow());
      if (adj.passed + adj.provenFailed.length + adj.unprovenFailed.length > 0) {
        best.checksPassed = adj.passed;
        best.checksFailed = adj.provenFailed.length;
        if (!best.checksFailed) delete best.checksOutput;
      }
    }

    // The task asked for tests: keep Apex's checks (written from the request, all passing) as a test file in the
    // project, next to whatever test the version wrote. Kept only if the project's tests still pass with it.
    const check = await finalCheckFile;
    if (check && best.edits.length && best.failed === 0 && (best.checksPassed ?? 0) > 0 && best.checksFailed === 0 && (asksForTests(opts.task) || reproOk)) {
      const keptPath = keptCheckPath(path.dirname(checkPath) + "/", opts.task, allFiles, pyTests);
      await fs.mkdir(path.dirname(path.join(best.dir, keptPath)), { recursive: true });
      await fs.writeFile(path.join(best.dir, keptPath), check);
      const t = await runTests(best.dir, testCommand, opts.signal, testTimeout);
      if (t.failed === 0) {
        best.edits = [...best.edits, { path: keptPath, replace: check }];
        best.passed = t.passed;
        opts.onEvent?.({ kind: "checks", text: `kept ${best.checksPassed} task checks as ${keptPath}` });
      } else await fs.rm(path.join(best.dir, keptPath), { force: true });
    }

    const changes: SurgicalResult["changes"] = [];
    if (best.edits.length) {
      // Copy the winner's final files into the real project.
      for (const rel of new Set(best.edits.map((e) => e.path))) {
        const abs = path.resolve(opts.root, rel);
        if (!abs.startsWith(path.resolve(opts.root) + path.sep)) continue;
        const after = await fs.readFile(path.join(best.dir, rel), "utf8").catch(() => null);
        if (after === null) continue;
        const before = (await ws.read(rel)) ?? "";
        if (before === after) continue;
        if (opts.apply !== false) await ws.write(rel, after);
        changes.push({ path: rel, before, after });
      }
    }
    // The implicit check: no security-weakening change (error details in responses, auth or expiry checks loosened,
    // secrets logged). It fails the version's checks, so the caller holds the change (callers that judge the verdict pass
    // `apply: false`; with the default the files are already written above and the verdict says not ready).
    const flags = changes.flatMap((c) => securityFlags(c.path, c.before, c.after));
    const problems = flags;
    if (best.edits.length && (problems.length || best.checksRun !== undefined)) {
      const line = implicitCheckTap(problems);
      best.checksRun = `${best.checksRun ?? ""}\n${line}\n`;
      if (problems.length) {
        best.checksPassed = best.checksPassed ?? 0;
        best.checksFailed = (best.checksFailed ?? 0) + 1;
        best.checksOutput = `${best.checksOutput ?? ""}\n${line}\n`;
      }
    }
    // The verdict: ready only when the project's tests pass, every proven check passes, and nothing is pending.
    const finalCheck = await finalCheckFile;
    const proof = proofNow();
    let results: CheckResult[] | undefined;
    if (finalCheck && best.checksRun !== undefined && !checksError) {
      const run = best.checksRun;
      results = reqs.length ? checkResults(reqs, run, proof) : unnumberedResults(run, proof);
    }
    const testsOk = Boolean(best.edits.length && changes.length && best.failed === 0 && !best.applyErrors.length && (opts.checksOnly ? (best.checksPassed ?? 0) > 0 : best.passed > 0));
    let verdict = checksError ? (testsOk ? { outcome: "unverified" as const, reason: `Apex's checks couldn't run (its generated test file has an error: ${checksError}); judged by the project's tests only` } : null) : checksVerdict(testsOk, results ?? []);
    // Older callers read checksError as "unverified": a pending check must never let them say "ready".
    if (verdict?.outcome === "unverified" && !checksError) checksError = verdict.reason;
    // "Ready" needs checks that show the change: when every one of them passed on the code before the change too, and
    // no project test that failed before passes now, nothing run here tells this change from no change at all. Not for
    // a request that keeps the behaviour (a rename, a refactor): there the checks passing before and after is the point.
    let vacuousChecks: string | undefined;
    if (verdict?.outcome === "ready" && best.checksRun !== undefined && !keepsBehaviour(ownTask) && changes.some((c) => CODE_PATH.test(c.path)) && checksShowChange(originalRun, best.checksRun, expectedOriginal) === false) {
      const failingNow = new Set(failedNames(best.testOutput));
      if (![...(await baseline)].some((name) => !failingNow.has(name))) {
        vacuousChecks = "the checks written from the request pass on the code before the change too, so they do not show that the change does what was asked";
        verdict = { outcome: "unverified", reason: vacuousChecks };
      }
    }
    if (verdict) opts.onEvent?.({ kind: "checks", text: `Outcome: ${verdict.outcome}${verdict.reason ? ` (${verdict.reason})` : ""}` });

    const strip = ({ dir: _d, ...c }: CandidateResult & { dir: string }) => c;
    return { chosen: best.edits.length ? strip(best) : null, candidates: candidates.map(strip), changes, reproduced: reproOk, ...(finalCheck ? { checkPath, checksFile: { path: checkPath, content: finalCheck } } : {}), ...(checksError ? { checksError } : {}), ...(checksNotLoaded ? { checksNotLoaded } : {}), ...(droppedChecks.length ? { droppedChecks } : {}), ...(reqs.length ? { requirements: reqs } : {}), ...(addedChecks.length || edgeChecks.length ? { addedChecks: [...addedChecks, ...edgeChecks] } : {}), ...(results ? { checkResults: results } : {}), ...(verdict ? { verdict } : {}), ...(secondLook ? { secondLook } : {}), ...(gaveUp ? { gaveUp } : {}), ...(vacuousChecks ? { vacuousChecks } : {}), ...stats, contextChars: context.length, ms: Date.now() - t0, ...(droppedOutOfScope ? { droppedOutOfScope } : {}), ...(keptOutOfScope ? { keptOutOfScope } : {}), ...(flags.length ? { securityFlags: flags } : {}) };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** "add a test", "with tests", "cover it with a test": the task asks for tests. */
export function asksForTests(task: string): boolean {
  // "add a test", "with tests", "and tests for it", "cover it with tests"; not "fix the failing test" or "make the tests pass".
  return /\b(add|write|include|create|cover(ed)?|with|plus|and)\b[^.?!]{0,30}\b(unit[- ])?(tests?|specs?|test cases?)\b/i.test(task)
    && !/\b(no|without|don'?t (add|write)) tests?\b/i.test(task)
    && !/\b(fix|failing|broken|pass(es|ing)?)\b[^.?!]{0,20}\btests?\b/i.test(task);
}

/** A test file name from the task ("Add GET /api/tasks/count ..." -> tests/tasks-count.test.js), never an existing file. */
export function keptCheckPath(testDir: string, task: string, existing: string[], python = false): string {
  const stop = new Set(["add", "a", "an", "the", "and", "to", "for", "with", "that", "of", "in", "on", "test", "tests", "get", "post", "put", "delete", "api", "make", "it", "new", "endpoint", "returns", "return"]);
  const words = task.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 1 && !stop.has(w)).slice(0, 3);
  const base = words.join("-") || "task";
  const file = (i?: number) => python ? `${testDir}test_${base.replace(/-/g, "_")}${i ? `_${i}` : ""}.py` : `${testDir}${base}${i ? `-${i}` : ""}.test.js`;
  let name = file();
  for (let i = 2; existing.includes(name); i++) name = file(i);
  return name;
}

/** Changed JavaScript files that do not parse (`node --check`), as "file: error" lines. */
export async function syntaxErrors(dir: string, files: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const rel of files.filter((f) => /\.(m?js|cjs)$/.test(f))) {
    const abs = path.join(dir, rel);
    try { await fs.access(abs); } catch { continue; }
    try { await execFileP(process.execPath, ["--check", abs], { timeout: 15_000 }); }
    catch (err) { out.push(`${rel}: ${String((err as { stderr?: string }).stderr ?? err).split("\n").find((l) => /Error/.test(l))?.trim() ?? "does not parse"}`); }
  }
  return out;
}

/** Names of the top-level tests that failed in a `node --test` run. */
export function failedNames(output: string): string[] {
  return readTestOutput(output, false).failedNames;
}

/** True when one line of 12 or more characters appears `times` or more: a model stuck in a loop. */
export function repeatsALine(text: string, times: number): boolean {
  const seen = new Map<string, number>();
  for (const l of text.split("\n")) {
    const line = l.trim();
    if (line.length < 12) continue;
    const n = (seen.get(line) ?? 0) + 1;
    if (n >= times) return true;
    seen.set(line, n);
  }
  return false;
}

/**
 * The test file from the checks answer: the fenced block, or, when the answer was cut before its closing fence,
 * everything up to the last complete test (a line that is just "});").
 */
export function checkCode(answer: string): string {
  const fenced = /```[a-z]*\n([\s\S]*?)\n```/.exec(answer)?.[1];
  if (fenced) return fenced;
  const open = /```[a-z]*\n([\s\S]*)$/.exec(answer)?.[1] ?? "";
  const end = open.lastIndexOf("\n});");
  return end >= 0 ? open.slice(0, end + 4) : "";
}


/** Import lines (relative to the checks file) for the names the request exports, plus the [cN] naming, with a tiny example. */
export function checksImportHint(wanted: Array<{ name: string; file: string }>, checkPath: string, py: boolean, count: number, cjs = false): string {
  if (py) return count ? `\n\nName every test def test_c<number>_<short_words>(), for example:\n\`\`\`python\ndef test_c1_returns_true_when_done():\n    assert is_done({"done": True}) is True\n\`\`\`` : "";
  const byFile = new Map<string, string[]>();
  for (const w of wanted) byFile.set(w.file, [...new Set([...(byFile.get(w.file) ?? []), w.name])]);
  const rel = (f: string) => { const r = path.posix.relative(path.posix.dirname(checkPath), f); return r.startsWith(".") ? r : `./${r}`; };
  const imports = [...byFile].map(([f, names]) => cjs ? `const { ${names.join(", ")} } = require("${rel(f)}");` : `import { ${names.join(", ")} } from "${rel(f)}";`);
  if (!imports.length && !count) return "";
  const head = cjs ? `const test = require("node:test");\nconst assert = require("node:assert/strict");` : `import test from "node:test";\nimport assert from "node:assert/strict";`;
  const first = wanted[0];
  const example = `${head}\n${imports.join("\n")}\n\ntest("[c1] ${first ? `${first.name} returns the expected value` : "does what line 1 says"}", () => {\n  assert.equal(${first ? `${first.name}(/* input */)` : "/* call */"}, /* expected */);\n});`;
  return `\n\n${imports.length ? `This file is ${checkPath}. Import exactly this (the path is relative to the test file; these names are what the task exports):\n${imports.join("\n")}\n` : ""}${count ? `Every test's name starts with "[c<number>] " (the bracketed number, then a space), one test per numbered line, from [c1] to [c${count}].\n` : ""}Shape:\n\`\`\`js\n${example}\n\`\`\``;
}

/** A load error on the ORIGINAL code that the change itself will clear: an export or file the request adds. */
export function expectedLoadError(wanted: Array<{ name: string; file: string }>, newFiles: string[]): (error: string) => boolean {
  return (error) => {
    const exp = /export named '([^']+)'|has no exported member '([^']+)'|cannot import name '([^']+)'/i.exec(error);
    const name = exp && (exp[1] ?? exp[2] ?? exp[3]);
    if (name && wanted.some((w) => w.name === name)) return true;
    if (/ERR_MODULE_NOT_FOUND|Cannot find module|No module named/i.test(error)) return newFiles.some((f) => error.includes(path.basename(f).replace(/\.\w+$/, "")));
    return false;
  };
}

/**
 * Makes the checks file load and name a test for every check: runs it (on the original code), and while it fails to
 * LOAD for a reason the change will not clear, asks for a repaired file (at most twice). Then, for numbered checks:
 * a file covering fewer than 60% of them is redrafted once (never a reused file); tests still missing are written by
 * one call that writes ONLY those tests, merged into the file (kept only if it still loads and covers more).
 * error: the first line of the load error the file still has. original: the file's last run on the original code.
 */
export async function validateChecks(code: string, io: {
  run: (code: string) => Promise<string>;
  ask: (prompt: string) => Promise<string>;
  count: number;
  py: boolean;
  expected?: (error: string) => boolean;
  onEvent?: (text: string) => void;
  /** A working file reused from an earlier turn: repaired or added to, never redrafted. */
  reuse?: boolean;
}): Promise<{ code: string; error?: string; original?: string }> {
  let original: string | undefined;
  const loadErr = async (c: string) => {
    const out = await io.run(c);
    const e = checksLoadError(out);
    const bad = e !== null && !io.expected?.(e) ? e : null;
    return { bad, out };
  };
  let probe = await loadErr(code);
  let err = probe.bad;
  original = probe.out;
  for (let attempt = 1; err !== null && attempt <= 2; attempt++) {
    io.onEvent?.(`The checks file does not load (${err}); asking for a fixed one (${attempt} of 2)`);
    const fixed = await io.ask(`Your test file below does not load, so none of its tests ran. Fix that error: check the import path is relative to the test file and the imported names are the ones the task names. Answer with the whole fixed file.\n\n<your test file>\n${code}\n</your test file>\n<the error>\n${err}\n</the error>`);
    if (!fixed.trim()) continue;
    code = fixed + "\n";
    probe = await loadErr(code);
    err = probe.bad;
    original = probe.out;
  }
  if (err !== null) { io.onEvent?.(`The checks file still does not load (${err}); the checks could not run`); return { code, error: err, original }; }
  let missing = io.count ? missingCheckTests(code, io.count, io.py) : [];
  // Too little of the list covered to judge anything: one redraft of the whole file before any version is scored.
  if (missing.length && !io.reuse && (io.count - missing.length) / io.count < 0.6) {
    io.onEvent?.(`The checks file covers ${io.count - missing.length} of ${io.count} checks; asking for a full one`);
    const more = await io.ask(`Your test file below has no test for numbered line${missing.length === 1 ? "" : "s"} ${missing.join(", ")}. Answer with the whole file, keeping its tests and adding one test for each missing line, named ${io.py ? "def test_c<number>_<short_words>()" : '"[c<number>] ..."'}.\n\n<your test file>\n${code}\n</your test file>`);
    if (more.trim() && missingCheckTests(more, io.count, io.py).length < missing.length) {
      const p2 = await loadErr(more + "\n");
      if (p2.bad === null) { code = more + "\n"; original = p2.out; missing = missingCheckTests(code, io.count, io.py); }
    }
  }
  if (missing.length) {
    io.onEvent?.(`No test for check${missing.length === 1 ? "" : "s"} ${missing.join(", ")}; asking for ${missing.length === 1 ? "it" : "them"} only`);
    const add = await io.ask(`Your test file below has no test for numbered line${missing.length === 1 ? "" : "s"} ${missing.join(", ")}. Write ONLY the missing test${missing.length === 1 ? "" : "s"}, one per missing line, named ${io.py ? "def test_c<number>_<short_words>()" : '"[c<number>] ..."'}, plus any import line they need that the file does not have. Do not repeat the file's existing tests.\n\n<your test file>\n${code}\n</your test file>`);
    if (add.trim()) {
      const merged = mergeTests(code, add, io.py);
      if (missingCheckTests(merged, io.count, io.py).length < missing.length) {
        const p3 = await loadErr(merged);
        if (p3.bad === null) { code = merged; original = p3.out; }
      }
    }
  }
  return { code, original };
}

/**
 * Adds tests to a checks file: the addition's import lines the file lacks go after its imports; its tests whose
 * check number the file already has are dropped; the rest are appended. The file's own tests are never rewritten.
 */
export function mergeTests(code: string, addition: string, py = false): string {
  const isImport = (l: string) => py ? /^\s*(import\s+\w|from\s+\S+\s+import\b)/.test(l) : /^\s*import\s[\s\S]*from\s+["']|^\s*import\s+["']|^\s*const\s+[\w{}\s,:]+=\s*require\(/.test(l);
  const have = new Set(code.split("\n").map((l) => l.trim()));
  const lines = addition.replace(/\n+$/, "").split("\n");
  const imports = lines.filter((l) => isImport(l) && !have.has(l.trim()))
    // node:test and assert are already imported by the file under some name.
    .filter((l) => !(/["']node:(test|assert)/.test(l) && /["']node:(test|assert)/.test(code)));
  const start = py ? /^def test_/ : /^\s*(test|it)\s*\(/;
  const chunks: string[][] = [];
  for (const l of lines) {
    if (start.test(l)) chunks.push([l]);
    else if (chunks.length) chunks[chunks.length - 1].push(l);
  }
  const existing = new Set([...code.matchAll(py ? /def test_c(\d+)_/g : /\[c(\d+)\]/g)].map((m) => Number(m[1])));
  const fresh = chunks.filter((c) => {
    const n = checkIndexOfLine(c[0], py);
    return n === null || !existing.has(n);
  }).map((c) => c.join("\n"));
  if (!fresh.length && !imports.length) return code;
  let out = code.replace(/\n+$/, "");
  if (imports.length) {
    const ls = out.split("\n");
    let last = -1;
    ls.forEach((l, i) => { if (isImport(l)) last = i; });
    ls.splice(last + 1, 0, ...imports);
    out = ls.join("\n");
  }
  return `${out}\n\n${fresh.join("\n\n")}\n`;
}

function checkIndexOfLine(line: string, py: boolean): number | null {
  const m = py ? /def test_c(\d+)_/.exec(line) : /\[c(\d+)\]/.exec(line);
  return m ? Number(m[1]) : null;
}

/**
 * The versions whose behaviour most versions share (S*): `outputs[i]` is what version i printed for the same probe
 * inputs (null when it could not run). Returns the indexes in the largest group of identical outputs; all indexes
 * when no group is larger than one, or nothing ran.
 */
export function majorityGroup(outputs: Array<string | null>): number[] {
  const groups = new Map<string, number[]>();
  outputs.forEach((o, i) => { if (o !== null) groups.set(o.trim(), [...(groups.get(o.trim()) ?? []), i]); });
  const best = [...groups.values()].sort((a, b) => b.length - a.length)[0];
  if (!best || best.length < 2 || [...groups.values()].filter((g) => g.length === best.length).length > 1) return outputs.map((_, i) => i);
  return best;
}

/** One line for a repair when a failing check has concrete values: what it was given back against what it wanted. */
export function workedExample(checksOutput: string): string {
  for (const t of parseTestOutcomes(checksOutput)) {
    if (t.ok || !t.failure || (t.failure.expected === undefined && t.failure.actual === undefined)) continue;
    return `Worked example: "${t.name}" expected ${t.failure.expected ?? "(see the message)"} but your code gave ${t.failure.actual ?? "(see the message)"}. Trace that input through your code and the helpers it calls, line by line, to find where it goes wrong.`;
  }
  return "";
}

/** Per-check results when the checks are not numbered: each top-level test is a check, with proof applied. */
export function unnumberedResults(run: string, proof: CheckProof): CheckResult[] {
  const out: CheckResult[] = [];
  for (const t of parseTestOutcomes(run).filter((x) => x.top)) {
    const implicit = /^\[implicit\]\s*/i.test(t.name);
    const { text, assumed } = splitAssumed(t.name.replace(/^\[c\d+\]\s*/i, "").replace(/^\[implicit\]\s*/i, ""));
    if (t.ok) out.push({ text, assumed, passed: true });
    else if (implicit || failureCounts(testKey(t.name), t.failure, proof)) out.push({ text, assumed, passed: false, failure: t.failure ?? { message: "failed" } });
    else out.push({ text, assumed, passed: null, failure: { message: `${UNPROVEN_MESSAGE} It said: ${(t.failure?.message ?? "failed").split("\n")[0].slice(0, 200)}` } });
  }
  return out;
}
