/**
 * Rules that keep Apex's own checks from holding back a correct change (graded on 15 runs: 4 held changes
 * were correct). No model call: each rule is mechanical.
 *  1. A check that scans the project must not find Apex's own generated check file (selfExcludingChecks).
 *  2. A checks file that never loads cannot hold a change (surgicalDecision).
 *  3. A drafted check must quote the request phrase it tests, must not contradict the request, and must state a
 *     concrete expectation; a crash report gets only "the crash is gone" and "behaviour unchanged" (screenChecks).
 */

/** Apex's own generated check files (tests/apex-task-check.test.js, tests/test_apex_task_check.py). */
export const APEX_CHECK_FILE = /apex-task-check|test_apex_task_check/;

/**
 * The checks file with a prelude that hides Apex's own check files from every directory listing the file (or the
 * code it calls) makes: measured on the rename task, "isSameDay is not used anywhere" scanned the tree, found the
 * old name inside the check file itself, and held a correct rename. The listing functions are patched, so any way
 * the model writes the scan (readdirSync, fs.promises.readdir, globSync; os.walk, os.listdir, glob) skips them.
 */
export function selfExcludingChecks(code: string, py = false): string {
  if (!code.trim() || code.includes("__apexOwnCheck")) return code;
  if (py) {
    const prelude = [
      "import os as __apex_os, glob as __apex_glob, re as __apex_re",
      `__apexOwnCheck = __apex_re.compile(r"${APEX_CHECK_FILE.source}")`,
      "def __apex_keep(xs): return [x for x in xs if not __apexOwnCheck.search(str(x))]",
      "__apex_listdir = __apex_os.listdir",
      "__apex_os.listdir = lambda *a, **k: __apex_keep(__apex_listdir(*a, **k))",
      "__apex_walk = __apex_os.walk",
      "def __apex_walk_own(*a, **k):",
      "    for d, ds, fs in __apex_walk(*a, **k):",
      "        fs[:] = __apex_keep(fs)",
      "        yield d, ds, fs",
      "__apex_os.walk = __apex_walk_own",
      "__apex_glob_glob = __apex_glob.glob",
      "__apex_glob.glob = lambda *a, **k: __apex_keep(__apex_glob_glob(*a, **k))",
      "",
    ].join("\n");
    // `from __future__` imports must stay first.
    const fut = /^(?:from __future__ import [^\n]*\n)+/m.exec(code);
    if (fut && code.slice(0, fut.index).trim() === "" ) return code.slice(0, fut.index + fut[0].length) + prelude + code.slice(fut.index + fut[0].length);
    return prelude + code;
  }
  const esm = /^\s*import\s/m.test(code) || /^\s*export\s/m.test(code);
  const head = esm
    ? `import __apexFs from "node:fs";\nimport { syncBuiltinESMExports as __apexSyncFs } from "node:module";\n`
    : `const __apexFs = require("node:fs");\nconst { syncBuiltinESMExports: __apexSyncFs } = require("node:module");\n`;
  const body = `const __apexOwnCheck = (e) => ${APEX_CHECK_FILE}.test(String(e && typeof e === "object" && "name" in e ? e.name : e));
{
  const keep = (list) => (Array.isArray(list) ? list.filter((e) => !__apexOwnCheck(e)) : list);
  const rd = __apexFs.readdirSync; __apexFs.readdirSync = function (...a) { return keep(rd.apply(this, a)); };
  const prd = __apexFs.promises.readdir; __apexFs.promises.readdir = async function (...a) { return keep(await prd.apply(this, a)); };
  const cbr = __apexFs.readdir; __apexFs.readdir = function (...a) { const cb = a.pop(); return cbr.apply(this, [...a, (err, list) => cb(err, keep(list))]); };
  if (typeof __apexFs.globSync === "function") { const g = __apexFs.globSync; __apexFs.globSync = function (...a) { return keep(g.apply(this, a)); }; }
  __apexSyncFs();
}
`;
  return head + body + code;
}

/** Guidance for the checks writer (the prelude is the guarantee; this keeps the model from shelling out to grep). */
export const SELF_EXCLUSION_HINT = `\n\nWhen a test searches or reads the project's files (for example "the old name is not used anywhere"), walk the folders with fs (or os.walk), skip node_modules, .git and dist, and skip this test file itself (any file whose name contains apex-task-check); never shell out to grep for it.`;

/** One drafted check: its text, and the request phrase it quotes (null when it quotes none). */
export function splitQuote(line: string): { text: string; quote: string | null } {
  const m = /\s*(?:[—–]|--?|\(?\s*quote:?|\bquotes?:)\s*["“”']([^"“”]{2,200})["“”']\s*\)?\s*(\(assumed\))?\s*$/i.exec(line);
  if (!m) return { text: line.trim(), quote: null };
  return { text: `${line.slice(0, m.index).trim()}${m[2] ? " (assumed)" : ""}`, quote: m[1].trim() };
}

const norm = (s: string) => s.toLowerCase().replace(/[`'’"“”]/g, "").replace(/[^a-z0-9/_$]+/g, " ").replace(/\s+/g, " ").trim();
const stem = (w: string) => w.slice(0, 5);

/** The quote appears in the request: same words ignoring case and punctuation, or nearly all its words in order. */
export function quoteInRequest(quote: string, request: string): boolean {
  const q = norm(quote), r = norm(request);
  if (!q) return false;
  if (r.includes(q)) return true;
  const qw = q.split(" "), rw = r.split(" ");
  if (qw.length < 2) return false;
  // Fuzzy: at least 80% of the quote's words found in order (stem match), within a window not much longer than it.
  let best = 0;
  for (let start = 0; start < rw.length; start++) {
    let i = start, hit = 0;
    for (const w of qw) {
      const j = rw.slice(i, Math.min(rw.length, start + qw.length * 2)).findIndex((x) => x === w || (w.length > 3 && x.length > 3 && stem(x) === stem(w)));
      if (j >= 0) { hit++; i += j + 1; }
    }
    best = Math.max(best, hit);
  }
  return best / qw.length >= 0.8;
}

const EXCLUDE = /\b(left out|leaves? out|leave out|excluded?|excludes|excluding|omit(?:s|ted)?|skip(?:s|ped)?|hidden|hides?|filtered out|filters? out|drop(?:s|ped)?|not (?:included|shown|returned|listed))\b/i;
const NEGATED = /\b(not|no|never|without|none|neither|nor)\b|n't\b/i;
const INCLUDE = /\b(includes?|including|contains?|shows?|lists?|keeps?|returns? (?:also|both|all))\b/i;
const FILLER = new Set("the a an and or of to in on for with is are be it its this that those these from by as at only all any each every which who when then also there their them they get gets returned".split(" "));
const words = (s: string) => norm(s).split(" ").filter((w) => w.length > 2 && !FILLER.has(w));

/** Terms the request leaves out: "done tasks are left out" -> [done, tasks]; "tasks that are not done" -> [done]. */
function excludedTerms(request: string): string[][] {
  const out: string[][] = [];
  for (const clause of request.split(/[.;\n]|,\s*(?:and|but)\s|\bbut\b/i)) {
    const ex = EXCLUDE.exec(clause);
    if (ex) {
      const ws = words(clause.replace(EXCLUDE, " ")).filter((w) => !/^(are|was|were|been|being|should|must|will|always|tasks?|items?)$/.test(w) || clause.split(/\s+/).length <= 4);
      if (ws.length && ws.length <= 3) out.push(ws);
      else if (ws.length) out.push(ws.slice(0, 2));
    }
    for (const m of clause.matchAll(/\bnot\s+(?:yet\s+)?([a-z]{3,})\b/gi)) {
      if (/^(included|shown|returned|listed|the|a|an|be|been|only|change|changed|throw|crash|fail)$/i.test(m[1])) continue;
      out.push([m[1].toLowerCase()]);
    }
  }
  return out;
}

/** The check asserts the opposite of the request: the request leaves something out, the check says it is included. */
export function negatesRequest(check: string, request: string): string | null {
  if (!INCLUDE.test(check) || NEGATED.test(check) || EXCLUDE.test(check)) return null;
  const cw = words(check);
  const has = (w: string) => cw.some((x) => x === w || (w.length > 3 && x.length > 3 && x.slice(0, 4) === w.slice(0, 4)));
  for (const terms of excludedTerms(request)) {
    if (terms.every(has)) return terms.join(" ");
  }
  return null;
}

const VAGUE = [
  /\b(the )?(expected|correct|right|proper|appropriate|valid|intended|desired) (value|values|result|results|output|response|behaviou?r|data|answer)\b/i,
  /\bworks? (correctly|properly|as expected|as intended|fine|well)\b/i,
  /\bas (expected|intended)\b/i,
  /\bhandles? [^.]{0,40}\b(correctly|properly|gracefully|appropriately)\b/i,
  /\bbehaves? (correctly|properly|as expected)\b/i,
];

/** A check with no concrete expectation ("todayTasks returns the expected value"): nothing a test can pin. */
export function vagueCheck(check: string): boolean {
  return VAGUE.some((re) => re.test(check));
}

/** A crash report allows two checks: the reported crash no longer happens, and existing behaviour is unchanged. */
export function traceCheckLines(request: string): string[] {
  const err = /(\w*(?:Error|Exception)\b:?[^\n]{0,120})/.exec(request)?.[1]?.trim();
  return [
    `The reported crash no longer happens: the input from the report runs without throwing${err ? ` "${err.replace(/"/g, "'")}"` : ""}`,
    "Existing behaviour is unchanged: inputs that worked before the fix give the same results as before",
  ];
}

const CRASH_GONE = /\b(no longer|does not|doesn't|do not|never|without|not)\b[^.]{0,60}\b(throws?|throwing|crash(?:es|ing)?|errors?|exceptions?|TypeError|fails?)\b/i;
const UNCHANGED = /\b(unchanged|still (?:works?|returns?|passes?|gives?)|as before|same (?:as|results?) before|existing behaviou?r)\b/i;
const SPECIFIC = /\b(returns?|responds?|status|equals?|is set to|defaults? to|should be|becomes?|\d{3})\b/i;

export interface DroppedCheck { text: string; reason: string }

/**
 * Drafted checks screened against the request before any can block a change. Dropped (and listed, never silently):
 * a quote not found in the request (or no quote, when one is required), a check that contradicts the request, a
 * vague check, and for a crash report anything beyond "the crash is gone" and "behaviour unchanged".
 * Kept lines keep their quote, so it survives the person's approval and the screen can run again.
 */
export function screenChecks(request: string, lines: string[], opts: { requireQuote?: boolean; trace?: boolean } = {}): { kept: string[]; dropped: DroppedCheck[] } {
  const kept: string[] = [];
  const dropped: DroppedCheck[] = [];
  for (const line of lines) {
    const { text, quote } = splitQuote(line);
    const plain = text.replace(/\s*\(assumed\)\s*$/i, "");
    if (opts.trace) {
      if (!(CRASH_GONE.test(plain) && !SPECIFIC.test(plain.replace(CRASH_GONE, ""))) && !UNCHANGED.test(plain)) { dropped.push({ text: line, reason: "the request reports a crash; it asks only that the crash stop and nothing else change" }); continue; }
      kept.push(line);
      continue;
    }
    if (quote !== null && !quoteInRequest(quote, request)) { dropped.push({ text: line, reason: `its quote "${quote}" is not in the request` }); continue; }
    if (quote === null && opts.requireQuote) { dropped.push({ text: line, reason: "it quotes no phrase of the request" }); continue; }
    const neg = negatesRequest(plain, request);
    if (neg) { dropped.push({ text: line, reason: `it contradicts the request, which leaves out ${neg}` }); continue; }
    if (vagueCheck(plain)) { dropped.push({ text: line, reason: "it names no concrete expected value or behaviour" }); continue; }
    kept.push(line);
  }
  return { kept, dropped };
}

/**
 * What to do with the chosen version once the project's tests pass on it. A proven failing check holds it
 * (not_ready). A checks file that never loaded cannot hold it: written, marked unverified (the project's tests are
 * the evidence; undo exists). Checks that ran but could not be judged hold it as unverified. Otherwise it is written.
 */
export function surgicalDecision(e: { testsOk: boolean; checksFailing: boolean; checksNotLoaded: boolean; pending: boolean; warnOnly?: boolean }): "write" | "write_unverified" | "hold_not_ready" | null {
  if (!e.testsOk) return null;
  // Weaker models: Apex's drafted checks were wrong more often than the change (bench 389daec+checkfix: 16 of 20 held
  // changes passed every hidden test), so with the project's own tests passing they warn instead of blocking.
  if (e.warnOnly && (e.checksFailing || e.pending || e.checksNotLoaded)) return "write_unverified";
  if (e.checksFailing) return "hold_not_ready";
  if (e.checksNotLoaded) return "write_unverified";
  // Checks that could not run judge nothing: the project's tests passed, so the change is written, marked unverified
  // (the model alone would have written it too).
  if (e.pending) return "write_unverified";
  return "write";
}
