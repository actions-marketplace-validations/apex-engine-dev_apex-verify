import { promises as fs } from "node:fs";
import path from "node:path";
import { fsWorkspace, type Workspace } from "./workspace.js";
import { TEST_PATH } from "./graph.js";

/**
 * Mechanical edits Apex does itself instead of asking a model: they are exact, instant and never miss a file
 * (measured: a weaker model renaming a helper across src and tests left one file behind or broke a test).
 * The model then does only the part that needs judgment, with the mechanical part already in the files.
 */
export interface Rename { from: string; to: string }

const IDENT = /^[A-Za-z_$][\w$]*$/;
/**
 * Words that are never the old name of a rename: the kind word of the request ("rename the function to x" names no
 * function), pronouns, and language keywords. Renaming one of these would rewrite every file of the project.
 */
const NOT_A_NAME = new Set(("function method class helper variable constant type symbol file folder module name field property parameter argument " +
  "this that these those them they all each every one some any everything it its self cls " +
  "const let var def return import export from default new if else for while do switch case break continue try catch finally throw async await yield " +
  "true false null none undefined void typeof instanceof delete in of is not and or with as pass lambda static public private protected interface enum extends implements super struct impl fn func package").split(" "));
const CODE = /\.(m?[jt]sx?|cjs|py|go|rs|java|kt|rb|php|cs|swift|scala|vue|svelte)$/i;

/** "rename isSameDay to isSameLocalDay", "rename `getUser` → `fetchUser`" (identifiers only, not file names). */
export function renamesIn(task: string, lists = false): Rename[] {
  const out: Rename[] = [];
  const add = (from: string, to: string) => { if (IDENT.test(from) && IDENT.test(to) && from !== to && from.length > 2 && !NOT_A_NAME.has(from.toLowerCase()) && !out.some((r) => r.from === from)) out.push({ from, to }); };
  for (const m of task.matchAll(/(?<!\b(?:a|an|the|this|that|its|their)\s)\brenam(?:e|ing)\s+(?:the\s+)?(?:function|method|class|helper|variable|constant|type|symbol)?\s*`?([A-Za-z_$][\w$]*)`?\s+(?:to|into|as|->|→)\s+`?([A-Za-z_$][\w$]*)`?/gi)) {
    add(m[1], m[2]);
    // `lists` (graph policy): the pairs that follow in the same sentence, "rename a to b and c to d" / ", c -> d".
    if (lists) {
      let rest = task.slice((m.index ?? 0) + m[0].length);
      for (;;) {
        const n = /^\s*(?:,\s*and|,|and)\s+`?([A-Za-z_$][\w$]*)`?\s+(?:to|into|as|->|→)\s+`?([A-Za-z_$][\w$]*)`?/i.exec(rest);
        if (!n) break;
        add(n[1], n[2]);
        rest = rest.slice(n[0].length);
      }
    }
  }
  return out;
}

/** Apply renames to every code file (whole identifiers only). Returns the new contents of the files that changed. */
export async function applyRenames(root: string, renames: Rename[], hidden: (rel: string) => boolean = () => false, includeDocs = false, workspace: Workspace = fsWorkspace(root)): Promise<Array<{ path: string; before: string; after: string; count: number }>> {
  if (!renames.length) return [];
  // Code and the docs that name it (README, CHANGES, docs/*.rst): "everywhere" includes them (QA: itsdangerous docs left out).
  const files = (await workspace.list().catch(() => [] as string[])).filter((f) => (CODE.test(f) || (includeDocs && /\.(md|rst|txt)$/i.test(f))) && !hidden(f));
  const out: Array<{ path: string; before: string; after: string; count: number }> = [];
  for (const f of files) {
    const before = (await workspace.read(f)) ?? "";
    if (!before) continue;
    let after = before;
    let count = 0;
    for (const r of renames) {
      const re = new RegExp(`(?<![\\w$])${r.from.replace(/\$/g, "\\$")}(?![\\w$])`, "g");
      after = after.replace(re, () => { count++; return r.to; });
    }
    if (count) out.push({ path: f, before, after, count });
  }
  return out;
}

/** The note for the model: what Apex already did, so it does not redo or undo it. */
export function mechanicalNote(renames: Rename[], changed: Array<{ path: string; count: number }>, renameOnly = false): string {
  if (!changed.length) return "";
  return `Apex already did the renames itself (${renames.map((r) => `${r.from} -> ${r.to}`).join(", ")}) in ${changed.map((c) => c.path).join(", ")}: the files below already have the new names. Do not rename anything back, and do not add an alias, wrapper or re-export under an old name: the old names must not appear anywhere. Do only the rest of the task.${renameOnly ? " The rename is the whole task and it is done: only run the tests, and fix a test only if it fails because of the rename. Change nothing else and add nothing (no docs entries, comments, docstrings or new tests)." : ""}`;
}

/** The request asks for nothing beyond its renames ("Rename a to b everywhere, including docs."). */
export function renameOnlyRequest(task: string): boolean {
  const rest = task.replace(/\brenam(?:e|ing)\s+(?:the\s+)?(?:function|method|class|helper|variable|constant|type|symbol)?\s*`?[A-Za-z_$][\w$]*`?\s+(?:to|into|as|->|→)\s+`?[A-Za-z_$][\w$]*`?/gi, "")
    .replace(/\b(everywhere|in (all|every) (files?|places?)|across the (project|codebase|repo)|including (the )?(docs|tests|readme|changelog)( and (the )?(docs|tests|readme|changelog))*|and update (the )?(docs|tests|references|imports))\b/gi, "")
    .replace(/[\s.,;:!-]+/g, " ").trim();
  return rest.split(" ").filter(Boolean).length <= 3;
}

/** Files that still mention an old name after the change (whole identifiers). */
export async function leftoverNames(root: string, renames: Rename[], files: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const f of files) {
    const body = await fs.readFile(path.join(root, f), "utf8").catch(() => "");
    for (const r of renames) if (new RegExp(`(?<![\\w$])${r.from.replace(/\$/g, "\\$")}(?![\\w$])`).test(body)) out.push(`${f} (${r.from})`);
  }
  return out;
}

/**
 * Interfaces a request names: "`todayTasks(store, session, now)` exported from `src/today.js`", "export parseDate from
 * src/dates.js", "a function slugify(text) in lib/slug.py". Checked on every version without a model (measured: a
 * weaker model named it createToday(store, session), so the hidden tests could not even find the function).
 */
export interface NamedExport { name: string; params: number; file: string }

export function namedExports(task: string): NamedExport[] {
  const out: NamedExport[] = [];
  const add = (name: string, params: string | undefined, file: string) => {
    const f = file.replace(/^\.?\//, "").replace(/[`'".,;:)]+$/, "");
    // Only a code file can export a function ("call validate(x) before writing to out/report.json" names none).
    if (!CODE.test(f) || out.some((x) => x.name === name && x.file === f)) return;
    out.push({ name, params: params === undefined ? -1 : params.split(",").map((p) => p.trim()).filter(Boolean).length, file: f });
  };
  // name(params) … exported from / in / into file   (within one sentence)
  // A call on a receiver (`store.add(item)`) names a method, not an export of the file: left out.
  for (const m of task.matchAll(/(?<![.\w$])`?(?<![.\w$])([A-Za-z_$][\w$]*)\(([^()]*)\)`?[^.\n]{0,60}?\b(?:exported from|export(?:ed)? (?:it )?(?:from|in)|in|into|to)\s+`?([\w./-]+\.\w{1,5})`?/g)) add(m[1], m[2], m[3]);
  // export name from file
  for (const m of task.matchAll(/\bexport\s+`?([A-Za-z_$][\w$]*)`?\s+from\s+`?([\w./-]+\.\w{1,5})`?/g)) add(m[1], undefined, m[2]);
  return out.filter((x) => !/^(GET|POST|PUT|DELETE|PATCH)$/.test(x.name));
}

/** What a version is missing: one line per named export it does not provide (name, file, parameter count). */
export async function missingExports(dir: string, wanted: NamedExport[]): Promise<string[]> {
  const out: string[] = [];
  for (const w of wanted) {
    const body = await fs.readFile(path.join(dir, w.file), "utf8").catch(() => null);
    if (body === null) { out.push(`${w.file} does not exist; the task asks for ${w.name} there`); continue; }
    const py = /\.py$/.test(w.file);
    const n = w.name.replace(/\$/g, "\\$");
    // Python: a top-level def (sync or async). JavaScript / TypeScript: a function or arrow, with or without type
    // parameters, exported the ES way (export function / const / { name }) or the CommonJS way (module.exports).
    const sig = py
      ? new RegExp(`^(?:async\\s+)?def\\s+${n}\\s*\\(([^)]*)\\)`, "m").exec(body)
      : new RegExp(`(?<![\\w$.])(?:async\\s+)?function\\*?\\s+${n}\\s*(?:<[^>(]*>)?\\s*\\(([^)]*)\\)`).exec(body)
        ?? new RegExp(`(?<![\\w$.])(?:const|let|var)\\s+${n}\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:<[^>(]*>\\s*)?(?:\\(([^)]*)\\)|([A-Za-z_$][\\w$]*))\\s*(?::[^=]+?)?=>`).exec(body);
    const exported = py ? Boolean(sig) || new RegExp(`^${n}\\s*=`, "m").test(body) || new RegExp(`^(?:from\\s+\\S+\\s+)?import\\b[^\\n]*\\b${n}\\b`, "m").test(body)
      : new RegExp(`\\bexport\\s+(?:default\\s+)?(?:async\\s+)?(?:function\\*?|const|let|var|class)\\s+${n}(?![\\w$])`).test(body)
        || new RegExp(`\\bexport\\s*\\{[^}]*(?<![\\w$])${n}(?![\\w$])[^}]*\\}`).test(body)
        || new RegExp(`\\bmodule\\.exports\\s*=\\s*\\{[^}]*(?<![\\w$])${n}(?![\\w$])[^}]*\\}`).test(body)
        || new RegExp(`\\b(?:module\\.)?exports\\.${n}\\s*=`).test(body)
        || new RegExp(`\\bmodule\\.exports\\s*=\\s*(?:async\\s+)?(?:function\\*?\\s+)?${n}(?![\\w$])`).test(body);
    if (!exported) { out.push(`${w.file} does not export ${w.name}${w.params >= 0 ? ` with ${w.params} parameter${w.params === 1 ? "" : "s"}` : ""}`); continue; }
    if (sig && w.params >= 0) {
      const params = (sig[1] ?? sig[2] ?? "").split(",").map((p) => p.trim()).filter((p) => p && p !== "self");
      if (params.length < w.params) out.push(`${w.name} in ${w.file} takes ${params.length} parameter${params.length === 1 ? "" : "s"}; the task names ${w.params}`);
    }
  }
  return out;
}

/** A test file (by name or folder), in any of the languages Apex runs checks for. */
export const TEST_FILE = TEST_PATH;

/**
 * The files a request needs: the ones it names (existing or new), the task pack's top targets, and test files.
 * A version that edits anything else made an unrequested change (measured on the sample: a fix for duplicate ids
 * in src/tasks/store.js also rewrote the 500 handler in src/main.js to return err.message, and it was committed).
 */
export function requestScope(opts: { named: string[]; newNamed?: string[]; targets?: string[]; extra?: string[] }): Set<string> {
  return new Set([...opts.named, ...(opts.newNamed ?? []), ...(opts.targets ?? []), ...(opts.extra ?? [])].map((f) => f.replace(/^\.\//, "")));
}

/** Changed files outside the scope (test files are always in scope). An empty scope knows nothing: nothing is outside. */
export function outOfScope(paths: string[], scope: Set<string>): string[] {
  if (!scope.size) return [];
  return [...new Set(paths)].filter((p) => !scope.has(p) && !TEST_FILE.test(p));
}

/** Lines added by a change (a multiset difference, so moved lines do not count). */
function addedLines(before: string, after: string): string[] {
  const left = new Map<string, number>();
  for (const l of before.split("\n")) left.set(l.trim(), (left.get(l.trim()) ?? 0) + 1);
  const out: string[] = [];
  for (const l of after.split("\n")) {
    const k = l.trim();
    const n = left.get(k) ?? 0;
    if (n > 0) left.set(k, n - 1); else if (k) out.push(k);
  }
  return out;
}
function removedLines(before: string, after: string): string[] { return addedLines(after, before); }

/**
 * Changes that weaken security, read from the diff without a model: internal error messages or stack traces sent
 * in a response, an auth or expiry check removed or loosened, secrets written to a log. Each as a short sentence
 * naming the file; empty when none.
 */
export function securityFlags(file: string, before: string, after: string): string[] {
  if (TEST_FILE.test(file)) return [];
  const added = addedLines(before, after);
  const removed = removedLines(before, after);
  const out: string[] = [];
  const respond = /\b(res|reply|response|ctx)\.|\b(send|json|end|write|body|return)\b|\b(error|message|detail)\s*:/;
  const leak = added.find((l) => !/\bthrow\b/.test(l) && /\b(err|error|e|ex|exception)\.(message|stack)\b|\bString\((err|error|e)\)|\$\{(err|error|e)\}/.test(l) && respond.test(l) && !/console\.|logger?\.|\blog\(/.test(l));
  if (leak) out.push(`${file}: an internal error message or stack trace is sent in a response (\`${leak.slice(0, 100)}\`)`);
  const authWord = /(expir|auth|session|token|verify|signed|signature|password|permission|isAdmin|\brole\b)/i;
  const isGuard = (l: string) => authWord.test(l) && /\b(if|return|throw|401|403)\b|[<>]/.test(l) && !/^\/\/|^#|^\*/.test(l);
  for (const gone of removed.filter(isGuard)) {
    const twin = added.find((a) => authWord.test(a) && similarWords(a, gone));
    if (!twin) { out.push(`${file}: an auth or expiry check was removed (\`${gone.slice(0, 100)}\`)`); break; }
    // The same check made to always pass: "|| true", commented out, "if (false && ...)", or a bare "return true".
    if (/\|\|\s*true\b|\btrue\s*\|\||\bfalse\s*&&|^\/\/|^#|^return\s+true\b/.test(twin)) { out.push(`${file}: an auth or expiry check was loosened (\`${twin.slice(0, 100)}\`)`); break; }
  }
  const secretLog = added.find((l) => /console\.\w+\(|logger?\.\w+\(|\blog\(|print\(/.test(l) && /\b(password|passwd|secret|token|api[_-]?key|authorization|cookie|session(Id)?|credential)s?\b/i.test(l));
  if (secretLog) out.push(`${file}: a secret or credential is written to a log (\`${secretLog.slice(0, 100)}\`)`);
  return out;
}

function similarWords(a: string, b: string): boolean {
  const w = (t: string) => new Set(t.match(/[A-Za-z_]{3,}/g) ?? []);
  const x = w(a), y = w(b);
  if (!x.size || !y.size) return false;
  return [...x].filter((t) => y.has(t)).length / Math.min(x.size, y.size) >= 0.6;
}

/** The implicit check every change gets, appended to the checks output as a node:test line check-results reads. */
export const IMPLICIT_SCOPE_CHECK = "No unrelated or security-weakening changes";
export function implicitCheckTap(problems: string[]): string {
  const ok = !problems.length;
  const body = ok ? "" : `\n  ---\n  error: |-\n${problems.map((p) => `    ${p}`).join("\n")}\n  ...`;
  return `${ok ? "ok" : "not ok"} 9001 - [implicit] ${IMPLICIT_SCOPE_CHECK}${body}`;
}

/**
 * Rules a request states, extracted without a model: each status code, the time zone, overdue, done, the order,
 * "only"/"without"/"must"/"should"/"returns" clauses, and each named export, route and file. A check list must
 * cover each one (measured: 8 approved checks for the Today request were all status-code variants; none covered
 * the time zone, overdue, done or sort rules, the 4 most-failed hidden tests).
 */
export interface RequestRule {
  key: string;
  /** The request's own words for it (a clause), used as the check line when no check covers it. */
  text: string;
  /** A check covers the rule when it mentions any of these (lowercase). */
  keywords: string[];
}

const CLAUSE_MARK = /\b(must|should|returns?|sorts?|sorted|order(?:ed)?|only|without|never|always|includes?|excludes?|rejects?|requires?)\b|\b[1-5]\d\d\b/i;

function clausesOf(task: string): string[] {
  return task.replace(/`/g, "").replace(/\b(e\.g|i\.e|etc|vs|cf)\./gi, (m) => m.replace(/\./g, "\u2024")).split(/(?<=[.!?])\s+|\n+|;\s+/).map((c) => c.trim().replace(/\u2024/g, ".")).filter((c) => c.length >= 6);
}

/**
 * The request's own words: without the whole-request reference of a part, and without the files that came along as
 * context (attached, or reused from another project). Rules and exports are read from these words only (measured:
 * planner-api code reused for a planner-web request became the "checks" \`const timeZone = body.timeZone || "UTC"\`
 * and \`"POST /api/sessions": signIn,\`; they failed on planner-web and held a correct change).
 */
export function requestOnly(task: string): string {
  return task
    .replace(/<the whole request, for reference only>[\s\S]*?<\/the whole request>/g, "")
    .replace(/<(attached-file|reused-file)\b[^>]*>[\s\S]*?<\/\1>/g, "")
    // The earlier turn of the conversation (a follow-up carries it for context): its files and rules are not this request's.
    .replace(/\n*<earlier-turn\b[^>]*>[\s\S]*?<\/earlier-turn>/g, "")
    .replace(/\n*<code-graph-callers>[\s\S]*?<\/code-graph-callers>/g, "")
    .replace(/\n*Context for this request \([^\n]*\):\s*$/, "")
    .trim();
}

export function requestRules(task: string): RequestRule[] {
  const own = requestOnly(task);
  const rules: RequestRule[] = [];
  const add = (r: RequestRule) => { if (!rules.some((x) => x.key === r.key)) rules.push(r); };
  const clauses = clausesOf(own);
  const clauseWith = (re: RegExp) => clauses.find((c) => re.test(c)) ?? "";
  const topical = new Set<string>();
  const topic = (key: string, re: RegExp, keywords: string[]) => {
    const c = clauseWith(re);
    if (!c) return;
    topical.add(c);
    add({ key, text: c, keywords });
  };
  for (const code of new Set(own.match(/\b[1-5]\d\d\b/g) ?? [])) {
    if (/^(1\d\d|200)$/.test(code) && !new RegExp(`\\b(status|code|returns?|gets?|responds?)\\b[^.]{0,20}\\b${code}\\b`, "i").test(own)) continue;
    topic(`status:${code}`, new RegExp(`\\b${code}\\b`), [code]);
  }
  topic("timezone", /\btime ?zones?\b|\btimezone\b|\butc\b|\blocal time\b/i, ["time zone", "timezone", "zone", "utc", "midnight", "local"]);
  topic("overdue", /\boverdue\b/i, ["overdue", "before today", "past due"]);
  topic("done", /\bnot done\b|\bdone\b|\bcompleted?\b/i, ["done", "complete", "finished"]);
  topic("order", /\bsort(?:s|ed)?\b|\border(?:ed)?\b|\bthen by\b/i, ["sort", "order", "before", "first", "then by", "priority", "earlier", "later", "ascending", "descending"]);
  topic("empty", /\bempty\b|\bno (?:tasks|items|input|results)\b/i, ["empty", "no tasks", "none", "[]"]);
  for (const m of own.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[\w/:.-]*)/g)) add({ key: `route:${m[1]} ${m[2]}`, text: clauses.find((c) => c.includes(m[2])) ?? `${m[1]} ${m[2]} works as the request says`, keywords: [m[2].toLowerCase()] });
  for (const e of namedExports(own)) add({ key: `export:${e.name}`, text: `${e.name} is exported from ${e.file}${e.params >= 0 ? ` and takes ${e.params} parameter${e.params === 1 ? "" : "s"}` : ""}`, keywords: [e.name.toLowerCase()] });
  // A file the request names that no route or export already ties to: something must change there.
  for (const f of new Set(own.match(/[\w-]+(?:\/[\w.-]+)+\.(?:m?[jt]sx?|cjs|py|html|css|go|rs)\b/g) ?? [])) {
    const c = clauses.find((x) => x.includes(f)) ?? "";
    if (/\b(GET|POST|PUT|PATCH|DELETE)\s+\/|\broute\b/i.test(c) || namedExports(own).some((e) => e.file === f)) continue;
    const base = path.basename(f).replace(/\.\w+$/, "").toLowerCase();
    add({ key: `file:${f}`, text: c || `${f} is changed as the request says`, keywords: [f.toLowerCase(), base] });
  }
  // Other rule clauses (must, should, returns, only, without...) not already covered by a topic above.
  for (const c of clauses) {
    if (topical.has(c) || !CLAUSE_MARK.test(c) || rules.some((r) => r.text === c)) continue;
    // The request itself ("Add a Today API", "Fix it") and where things go (a file, a route) are not rules to test.
    if (/^(add|create|build|implement|make|write|put|register|fix|refactor|update|change)\b/i.test(c) || /[\w-]+\/[\w./-]+\.\w{1,5}\b|\b(GET|POST|PUT|PATCH|DELETE)\s+\//.test(c)) continue;
    const kw = contentWords(c).slice(0, 6);
    if (kw.length < 2) continue;
    add({ key: `clause:${kw.slice(0, 3).join("-")}`, text: c, keywords: kw });
  }
  return rules;
}

const RULE_STOP = new Set("a an the and or of to in on for with without by is are be it its this that when then each per as at from into get set should must only returns return add adds also their they them who what which user users".split(" "));
function contentWords(t: string): string[] {
  return [...new Set((t.toLowerCase().match(/[a-z0-9_/.$-]+/g) ?? []).map((w) => w.replace(/^[./-]+|[./-]+$/g, "")).filter((w) => w.length > 3 && !RULE_STOP.has(w)))];
}

/** Whether a check line covers a rule. Generic clauses need half their words (stem match); topics one keyword. */
export function coversRule(check: string, rule: RequestRule): boolean {
  const c = check.toLowerCase();
  if (rule.key.startsWith("clause:")) {
    const w = contentWords(check);
    const hit = rule.keywords.filter((k) => w.some((x) => x.slice(0, 5) === k.slice(0, 5))).length;
    return hit >= Math.max(2, Math.ceil(rule.keywords.length / 2));
  }
  return rule.keywords.some((k) => (/^[a-z]+$/.test(k) ? new RegExp(`\\b${k}`).test(c) : c.includes(k)));
}

export function uncoveredRules(rules: RequestRule[], checks: string[]): RequestRule[] {
  return rules.filter((r) => !checks.some((c) => coversRule(c, r)));
}

/**
 * Status-code variants collapsed: lines whose only rule is the same status code ("401 without a token", "401 with an
 * expired token", "401 with a malformed header") are one check. Lines that also cover another rule stay.
 */
export function collapseStatusVariants(checks: string[], rules: RequestRule[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of checks) {
    const mine = rules.filter((r) => coversRule(line, r) && !r.key.startsWith("route:") && !r.key.startsWith("export:"));
    const codes = [...new Set(line.match(/\b[1-5]\d\d\b/g) ?? [])];
    const onlyStatus = codes.length === 1 && mine.every((r) => r.key === `status:${codes[0]}`);
    if (onlyStatus) {
      if (seen.has(codes[0])) continue;
      seen.add(codes[0]);
    }
    out.push(line);
  }
  return out;
}

/**
 * The coverage gate: near-duplicate status variants collapsed, then one line added (the request's own words) for
 * each rule no check covers. Exact values the request states are kept as written. At most `max` lines.
 */
export function coverageGate(task: string, checks: string[], max = 10): { checks: string[]; added: string[]; rules: RequestRule[] } {
  const rules = requestRules(task);
  const kept = collapseStatusVariants(checks, rules);
  const added: string[] = [];
  for (const r of uncoveredRules(rules, kept)) {
    if (kept.length + added.length >= max) break;
    const line = r.text.replace(/\s+/g, " ").replace(/[.;]\s*$/, "").trim();
    if (line.length >= 8 && !kept.includes(line) && !added.includes(line)) added.push(line);
  }
  return { checks: [...kept, ...added], added, rules };
}

/**
 * Edge-case checks for a bug fix, from the bug text (and the function's parameters when known): many repeated
 * operations after a gap or seed, empty input, and the result's type/format (measured: a fix-ids version was "Ready"
 * while the hidden "many adds never collide" failed; the edge cases were never checked).
 */
export function bugEdgeChecks(bug: string, params: string[] = []): string[] {
  const t = bug.toLowerCase();
  const out: string[] = [];
  const op = /\badd(?:ing|s|ed)?\b/.test(t) ? "adds" : /\bcreat(?:e|es|ing|ed)\b/.test(t) ? "creates" : /\binsert/.test(t) ? "inserts" : /\bsav(?:e|es|ing)\b/.test(t) ? "saves" : /\bupdat/.test(t) ? "updates" : "calls";
  const ids = /\bids?\b|\bidentifier|\bunique|\bduplicate|\bcollid|\bsame id|\bshare an id/.test(t);
  const seeded = /\bseed|\balready (?:have|has)|\bexisting|\bcreated with|\bgap|\bpreloaded|\bloaded with/.test(t);
  if (ids) out.push(`Many ${op} in a row (for example 50)${seeded ? " after seeding with existing ids that leave a gap (for example 1, 2 and 7)" : ""} never produce a duplicate id: every id is distinct from every other`);
  else out.push(`Repeating the operation many times (for example 50 ${op})${seeded ? " after seeding with existing data" : ""} keeps working the same way each time`);
  out.push(`Works on empty input${params.length ? ` (${params[0]} empty)` : ""}${ids ? ": an empty store numbers its first item the way it did before" : ": no throw, and the same result shape"}`);
  out.push(ids ? "New ids keep the same type and format as existing ones (for example a string id stays a string)" : "The result keeps its type and format (same shape and value types as before the fix)");
  return out;
}

/**
 * Relative imports of a file, resolved to project paths (".js" and "/index.js" tried): the helpers a repair needs to
 * see (measured: the overdue and sort bugs in Today were one-line fixes once the source of zone.js and priority.js
 * was in front of the model).
 */
export async function resolveImports(root: string, file: string, workspace: Workspace = fsWorkspace(root)): Promise<string[]> {
  const body = (await workspace.read(file)) ?? "";
  const out: string[] = [];
  for (const m of body.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']/gm)) {
    const rel = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1]));
    for (const cand of [rel, `${rel}.js`, `${rel}.mjs`, `${rel}.ts`, `${rel}/index.js`]) {
      if (await workspace.exists(cand)) { if (!out.includes(cand)) out.push(cand); break; }
    }
  }
  for (const m of body.matchAll(/^\s*from\s+\.([\w.]*)\s+import|^\s*from\s+([\w.]+)\s+import/gm)) {
    const mod = (m[1] ?? m[2] ?? "").replace(/^\./, "");
    if (!mod) continue;
    const cand = path.posix.join(m[1] !== undefined ? path.posix.dirname(file) : "", mod.replace(/\./g, "/") + ".py");
    if ((await workspace.exists(cand)) && !out.includes(cand)) out.push(cand);
  }
  return out;
}

/** Parameter names of an exported function in a file (empty when not found). */
export async function exportParams(root: string, file: string, name: string, workspace: Workspace = fsWorkspace(root)): Promise<string[]> {
  const body = (await workspace.read(file)) ?? "";
  const e = name.replace(/\$/g, "\\$");
  const m = new RegExp(`(?:function\\*?\\s+${e}|${e}\\s*=\\s*(?:async\\s*)?)\\s*\\(([^)]*)\\)`).exec(body) ?? new RegExp(`^def\\s+${e}\\s*\\(([^)]*)\\)`, "m").exec(body);
  return m ? m[1].split(",").map((p) => p.trim().replace(/[=:].*$/, "").trim()).filter((p) => p && p !== "self") : [];
}


/**
 * Code that behaves differently under the tests than for real callers: it reads the call stack, the test runner's
 * state or the test file names (QA: Flash made lowercase the default for everyone except test/slugify.js, found
 * through new Error().stack, and the tests passed). Returns the offending added lines of non-test files.
 */
export function testGaming(changes: Array<{ path: string; before: string | null; after: string }>): string[] {
  const BAD = /new Error\(\)\.stack|Error\.captureStackTrace|\.stack\b.*\btest|NODE_TEST_CONTEXT|PYTEST_CURRENT_TEST|JEST_WORKER_ID|process\.env\.VITEST|\bVITEST_|process\.env\.MOCHA|process\.argv.*(test|spec|mocha|jest|pytest)|traceback\.(extract_stack|format_stack)|inspect\.stack\(|sys\._getframe|["'`]pytest["'`]\s+in\s+sys\.modules|sys\.modules\.get\(["']pytest|\btypeof (describe|it|jest)\s*[!=]==|["'`/\\]test[s]?[\\/\]]/;
  const out: string[] = [];
  for (const c of changes) {
    if (TEST_FILE.test(c.path) || /(^|\/)(conftest\.py|jest\.config|vitest\.config|\.mocharc)/.test(c.path)) continue;
    if (!CODE.test(c.path)) continue;
    const old = new Set((c.before ?? "").split("\n").map((l) => l.trim()));
    for (const l of c.after.split("\n")) if (!old.has(l.trim()) && BAD.test(l) && !/^\s*(\/\/|#|\*)/.test(l)) out.push(`${c.path}: ${l.trim().slice(0, 160)}`);
  }
  return out;
}
