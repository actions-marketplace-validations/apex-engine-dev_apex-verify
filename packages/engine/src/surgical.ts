import { existsSync, mkdirSync } from "node:fs";
import { inTestSandbox, readTestOutput, runCommand, testSandboxAvailable, testSandboxProfile } from "./test-runner.js";
import { requestOnly } from "./mechanical.js";
import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ModelClient, ModelEvent, ModelMessage } from "./model.js";
import { engineSettings, type EngineOptions, SCOPED_BUDGET } from "./options.js";
import { fsWorkspace, taskPackProvider, type TaskPackProvider, type Workspace } from "./workspace.js";
import { cachedGraph, graphScope, isTestPath, type CodeGraph } from "./graph.js";
import { scopedContext, scopeWords, wordRe, type Segments } from "./scoped-context.js";

/**
 * Helpers the proof gate uses: the context a checks call is given, a scratch copy of a project, and running its tests
 * there. (In the larger project this file also holds the code-writing loop; that part is not published here.)
 */

/** The model the versions step asks: any `ModelClient`. */
export type SurgicalGateway = ModelClient;

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
export const hasFencedBlock = (text: string): boolean => fencedBody(text) !== null;

/**
 * The body of the first fenced code block, or null while it is not closed. A line of three backticks closes the block
 * only when it is not inside a Python triple-quoted string: a test that holds markdown in a docstring-style string has
 * such lines in its own code, and cutting there left half a file.
 */
export function fencedBody(text: string): string | null {
  const open = /```[a-z]*\n/.exec(text);
  if (!open) return null;
  const body = text.slice(open.index + open[0].length);
  const lines = body.split("\n");
  let pos = 0, dq = 0, sq = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (i > 0 && line.startsWith("```") && dq % 2 === 0 && sq % 2 === 0) return body.slice(0, pos - 1);
    dq += (line.match(/"""/g) ?? []).length; sq += (line.match(/'''/g) ?? []).length;
    pos += line.length + 1;
  }
  return null;
}

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
  await fs.cp(src, dest, { recursive: true, verbatimSymlinks: true, mode: fsConstants.COPYFILE_FICLONE, filter: async (p) => {
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
    // Vite and Vitest keep their caches inside node_modules; the folders they would create are made first, so they can be writable while the rest stays read-only.
    const nmDir = path.join(project, "node_modules");
    if (existsSync(path.join(nmDir, "vite")) || existsSync(path.join(nmDir, "vitest"))) for (const d of [".vite", ".vitest", ".vite-temp"]) { try { mkdirSync(path.join(nmDir, d), { recursive: true }); } catch { /* read-only install */ } }
    const caches = [".cache", ".vite", ".vitest", ".vite-temp"].map((d) => path.join(project, "node_modules", d)).filter((d) => existsSync(d));
    ({ file, args } = inTestSandbox(testSandboxProfile({ writable: [cwd, ...caches], readable: [project], readOnly: [path.join(project, "node_modules")] }), file, args));
  }
  const r = await runCommand(file, args, { cwd, timeoutMs: timeoutSec * 1000, maxBuffer: 8 << 20, signal, env: { ...runEnv(), CI: "1", FORCE_COLOR: "0", ...pythonPathFor(cwd) } });
  const output = r.stdout + r.stderr;
  // A run that was killed (timeout, stop) or exited with an error is never a clean pass.
  const t = readTestOutput(output, r.failed);
  return { passed: t.passed, failed: t.failed, output, exitCode: r.failed ? r.exitCode : 0, seconds: Math.round((Date.now() - started) / 100) / 10, ...(sandboxed ? { sandboxed: true } : {}) };
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
  const fenced = fencedBody(answer);
  if (fenced) return fenced;
  const open = /```[a-z]*\n([\s\S]*)$/.exec(answer)?.[1] ?? "";
  const end = open.lastIndexOf("\n});");
  return end >= 0 ? open.slice(0, end + 4) : "";
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

