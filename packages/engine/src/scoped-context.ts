/**
 * Scoped context (context-policy flag `graph`): instead of whole files up to a budget, the model gets the functions
 * the request is about, exactly as they are in the files, and signatures for the rest.
 *
 *  - what the request names (definitions), who uses it (callers) and what it calls (callees);
 *  - callers are the code graph's dependents UNION a whole-word text search. Never the graph alone: it misses calls
 *    on receivers whose type it cannot resolve (measured on marshmallow: 2 of 3 caller functions found);
 *  - line ranges come from symbols.ts (indentation / braces); the graph's start lines pick between same-named
 *    symbols and supply a range for a symbol the outline heuristics did not see;
 *  - every file shown in part gets an outline (line ranges + signatures) of what is not shown.
 *
 * The ideas (a bounded, ranked, seeds-first answer cut at line boundaries) follow Graphify's query design; no code
 * was taken from it.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { isTestPath, type CodeGraph } from "./graph.js";
import { outline, type SymbolEntry } from "./symbols.js";

const CODE = /\.(m?[jt]sx?|cjs|py|go|rs|java|kt|rb)$/;
export { isTestPath };

/** Characters per named part of a prompt (file listing, outlines, ranges, …), written to the eval trace. */
export type Segments = Record<string, number>;

export interface ScopedRange {
  file: string;
  /** 0-based, inclusive. */
  a: number; b: number;
  why: "definition" | "caller" | "use" | "related" | "callee" | "test";
  /** Lower goes in first. */
  prio: number;
  name: string;
  /** Within one priority: the rank of the name (most specific first). */
  order: number;
  /** The line (0-based) of the use this range was added for, when it was. */
  hit?: number;
}

export interface ScopedBlock { path: string; text: string; whole: boolean; lines: number; chars: number }
export interface Scoped {
  blocks: ScopedBlock[];
  /** The same as line ranges (0-based, inclusive) per file shown in part, and the files shown whole. */
  ranges: Map<string, Array<{ a: number; b: number }>>;
  wholeFiles: string[];
  /** Outline text for the files shown in part (and ranked files not shown at all). */
  outlines: string;
  /** "path:line  text" for every use of the names (graph ∪ text search), so none is missed. */
  callSites: string[];
  /** The names the scope was built around. */
  names: string[];
  segments: Segments;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const wordRe = (name: string) => new RegExp(`(^|[^\\w$])${esc(name)}($|[^\\w$])`);

/** The innermost outline entry that holds a 1-based line. */
export function enclosingSymbol(entries: SymbolEntry[], line: number): SymbolEntry | null {
  let best: SymbolEntry | null = null;
  for (const e of entries) if (e.start <= line && line <= e.end && (!best || e.end - e.start < best.end - best.start)) best = e;
  return best;
}

/** A symbol's first line moved up over the decorators and comment lines right above it (0-based in, 0-based out). */
export function withLead(lines: string[], start: number): number {
  let s = start;
  while (s > 0 && /^\s*(@|#|\/\/|\*|\/\*)/.test(lines[s - 1])) s--;
  return s;
}

/**
 * Where a named symbol is in a file, 0-based inclusive. symbols.ts gives start and end; the graph's start line picks
 * the right one when several share the name, and gives a range (up to the next graph node) when the outline has none.
 */
export function symbolRanges(file: string, lines: string[], entries: SymbolEntry[], name: string, graph?: CodeGraph | null): Array<{ a: number; b: number }> {
  const out: Array<{ a: number; b: number }> = [];
  const own = entries.filter((e) => e.name === name);
  for (const e of own) out.push({ a: withLead(lines, e.start - 1), b: Math.min(lines.length - 1, e.end - 1) });
  if (graph) {
    for (const r of graph.ranges(file, lines.length)) {
      if (r.node.name !== name) continue;
      // Already covered by an outline entry: keep the wider start (the graph can point at a decorator line).
      const hit = out.find((x) => r.start - 1 >= x.a - 3 && r.start - 1 <= x.b);
      if (hit) { hit.a = Math.min(hit.a, Math.max(0, r.start - 1)); continue; }
      out.push({ a: withLead(lines, Math.max(0, r.start - 1)), b: Math.min(lines.length - 1, Math.min(r.end - 1, r.start - 1 + 120)) });
    }
  }
  return out;
}

/** Lines of a file for a set of ranges, exactly as they are, with "(lines a-b not shown)" markers in the gaps. */
export function renderRanges(lines: string[], ranges: Array<{ a: number; b: number }>, numbered = false): string {
  const merged: Array<{ a: number; b: number }> = [];
  for (const r of [...ranges].sort((x, y) => x.a - y.a)) {
    const a = Math.max(0, r.a), b = Math.min(lines.length - 1, r.b);
    if (b < a) continue;
    const last = merged[merged.length - 1];
    if (last && a <= last.b + 3) last.b = Math.max(last.b, b); else merged.push({ a, b });
  }
  const out: string[] = [];
  let prev = -1;
  for (const { a, b } of merged) {
    if (a > prev + 1) out.push(`… (lines ${prev + 2}-${a} not shown)`);
    for (let i = a; i <= b; i++) out.push(numbered ? `${i + 1}| ${lines[i]}` : lines[i]);
    prev = b;
  }
  if (prev < lines.length - 1) out.push(`… (lines ${prev + 2}-${lines.length} not shown)`);
  return out.join("\n");
}

const rangeChars = (lines: string[], a: number, b: number, numbered: boolean) => { let n = 0; for (let i = a; i <= b; i++) n += lines[i].length + (numbered ? 6 : 1); return n; };

/**
 * A compact outline: line ranges and signatures within `maxChars`. When it cannot hold every entry, the ones around
 * the `focus` ranges (0-based) and the top-level ones are kept first; the rest are counted.
 */
export function shortOutline(file: string, entries: SymbolEntry[], totalLines: number, maxChars: number, focus: Array<{ a: number; b: number }> = []): string {
  const head = `${file} (${totalLines} lines)`;
  const row = (e: SymbolEntry) => `${String(e.start).padStart(5)}-${String(e.end).padEnd(5)} ${e.kind === "method" ? "  " : ""}${e.signature.slice(0, 100)}`;
  const near = (e: SymbolEntry) => focus.some((f) => e.start - 1 <= f.b && e.end - 1 >= f.a);
  const rankOf = (e: SymbolEntry) => (near(e) ? 0 : e.kind !== "method" ? 1 : entries.some((c) => c.kind === "class" && c.start <= e.start && c.end >= e.end && near(c)) ? 2 : 3);
  const byRank = entries.map((e, i) => ({ e, i, r: rankOf(e) })).sort((x, y) => x.r - y.r || x.i - y.i);
  const keep = new Set<number>();
  let used = head.length;
  for (const x of byRank) { const n = row(x.e).length + 1; if (used + n > maxChars) break; keep.add(x.i); used += n; }
  const out = [head, ...entries.filter((_, i) => keep.has(i)).map(row)];
  if (keep.size < entries.length) out.push(`      … ${entries.length - keep.size} more not listed`);
  return out.join("\n");
}

const PRIOR_WEIGHT = Number(process.env.APEX_SCOPE_PRIOR ?? 0.2);
const STOP_WORDS = new Set("that this with from into when then than they them their there these those have has had does done make makes made should would could must will shall being been were what which while where also only every each some such still just like same other another after before again above below between both more most very much many well even not and the for are but can its use used using uses want wants need needs keep keeps work works working exactly today instead without within about because currently however change changes changed update updates updated behave behaves behaviour behavior return returns returned value values true false null none undefined first last next new old code file files function functions method methods class classes test tests name names call calls called caller callers pass passes passing passed fix fixes fixed error errors given".split(" "));

/** Words of a request worth matching against code: its identifiers, their snake_case / camelCase parts, and longer plain words. */
export function scopeWords(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const w = m[0];
    const parts = [w, ...w.split(/_+|(?<=[a-z0-9])(?=[A-Z])/)];
    for (const part of parts) {
      const l = part.toLowerCase().replace(/^_+|_+$/g, "");
      if (l.length < 4 || STOP_WORDS.has(l)) continue;
      out.add(l);
      // The stem too ("dumping" finds dump(), "validators" finds validator): code names are rarely inflected.
      const stem = l.replace(/(ing|ed|es|s)$/, "");
      if (stem.length >= 4 && stem !== l && !STOP_WORDS.has(stem)) out.add(stem);
    }
  }
  return [...out].slice(0, 48);
}

/**
 * Inside a long function (lines a..b, lower-cased): the windows where most of the request's words meet, best first,
 * at most `maxLines` lines in all. Empty when no word is used there.
 */
export function denseWindows(low: string[], a: number, b: number, words: string[], maxLines: number, around = 5): Array<{ a: number; b: number }> {
  if (!words.length || b < a) return [];
  const scored: Array<{ i: number; score: number }> = [];
  for (let i = a; i <= b; i++) {
    const here = words.filter((w) => low[i].includes(w)).length;
    if (!here) continue;
    const near = low.slice(Math.max(a, i - around), Math.min(b, i + around) + 1).join("\n");
    scored.push({ i, score: words.filter((w) => near.includes(w)).length * 10 + here });
  }
  scored.sort((x, y) => y.score - x.score || x.i - y.i);
  const keep = new Set<number>();
  for (const { i } of scored) {
    const span: number[] = [];
    for (let k = Math.max(a, i - around); k <= Math.min(b, i + around); k++) if (!keep.has(k)) span.push(k);
    if (keep.size + span.length > maxLines) { if (keep.size) break; span.length = maxLines; }
    span.forEach((k) => keep.add(k));
  }
  const out: Array<{ a: number; b: number }> = [];
  for (const i of [...keep].sort((x, y) => x - y)) { const last = out[out.length - 1]; if (last && i <= last.b + 1) last.b = i; else out.push({ a: i, b: i }); }
  return out;
}

interface Loaded { lines: string[]; low: string[] | null; chars: number; entries: SymbolEntry[] | null }

/**
 * The scope for a request, within `budgetChars`:
 *  1. what it names as code: the definitions, then every user (whole-word text search ∪ the graph's dependents),
 *     most specific name first; a name used all over the project counts only where it is defined;
 *  2. the functions that best match the request's words (each function scored by the words it holds, rare words
 *     counting more, a word in the function's own name most), so a request that names nothing still gets the code
 *     it is about;
 *  3. what the named functions call (graph), then tests.
 * Null when nothing matches (the caller falls back to whole files).
 *
 * `mode` "edit": definitions, callers, related functions, callees, tests (a changed signature needs every caller).
 * `mode` "question": definitions, callees and related functions, callers (tracing a flow follows the calls).
 */
export async function scopedContext(o: {
  root: string; files: string[]; names: string[]; graph?: CodeGraph | null; budgetChars: number; mode?: "edit" | "fix" | "question";
  /** The request's words (scopeWords) for ranking functions; default none. */ words?: string[];
  /** Files the request names: whole when small, otherwise outlined. */ named?: string[];
  /** Files ranked for the request (graph, task pack): outlined even when no range falls in them. */ ranked?: string[];
  numbered?: boolean; hidden?: (rel: string) => boolean;
  /** False: `words` only pick the lines shown of a long function; no function is added for its words alone. */ related?: boolean;
}): Promise<Scoped | null> {
  const mode = o.mode ?? "edit";
  const numbered = o.numbered === true;
  const hidden = o.hidden ?? (() => false);
  const graph = o.graph ?? null;
  // Files the request names are read whatever their type (a page, a stylesheet, a config file): a version must
  // change them, so it must see them.
  const namedSet = new Set(o.named ?? []);
  const code = [...o.files.filter((f) => namedSet.has(f) && !hidden(f)), ...o.files.filter((f) => CODE.test(f) && !namedSet.has(f) && !hidden(f)).slice(0, 800)];
  const loaded = new Map<string, Loaded>();
  await Promise.all(code.map(async (f) => {
    const body = await fs.readFile(path.join(o.root, f), "utf8").catch(() => "");
    if (body && body.length <= 400_000) loaded.set(f, { lines: body.split("\n"), low: null, chars: body.length, entries: null });
  }));
  // Outline entries, cross-checked with the graph: the outline is a line heuristic and reads "class …" inside a
  // docstring as a class; where the graph knows the file, an entry must be a graph node (same line or same name).
  const entriesOf = (f: string): SymbolEntry[] => {
    const l = loaded.get(f);
    if (!l) return [];
    if (l.entries) return l.entries;
    let es = outline(f, l.lines.join("\n"));
    const nodes = graph?.ranges(f, l.lines.length) ?? [];
    if (nodes.length >= 2) {
      const at = new Set(nodes.map((n) => n.start)), called = new Set(nodes.map((n) => n.node.name));
      const checked = es.filter((e) => called.has(e.name) || at.has(e.start));
      if (checked.length >= es.length / 2) es = checked;
    }
    return (l.entries = es);
  };
  const names = [...new Set(o.names)].filter((n) => n.length >= 3).slice(0, 12);
  const words = [...new Set(o.words ?? [])];
  const wordList = [...new Set([...words, ...names.map((x) => x.toLowerCase())])];
  if (!names.length && !words.length) return null;

  // A change to a name or signature needs every caller; a bug sits in or below the function described, so there
  // (and for a question, which traces a flow) what it calls and the functions the words point at come first.
  const P = mode === "edit"
    ? { definition: 0, caller: 1, use: 2, related: 3, callee: 4, test: 4 }
    : { definition: 0, callee: 1, related: 1, caller: 2, use: 3, test: 4 };
  const mustCallers = mode === "edit";
  const ranges: ScopedRange[] = [];
  const sites: string[] = [];
  const BIG = 150;
  const lowOf = (l: Loaded) => (l.low ??= l.lines.map((x) => x.toLowerCase()));
  const add = (file: string, a: number, b: number, why: ScopedRange["why"], name: string, order: number, hitLine?: number) => {
    const l = loaded.get(file);
    if (!l) return;
    a = Math.max(0, a); b = Math.min(l.lines.length - 1, b);
    const test = isTestPath(file);
    const push = (x: number, y: number) => ranges.push({ file, a: x, b: y, why: test ? "test" : why, prio: test ? Math.max(P.test, P[why]) : P[why], name, order, ...(hitLine !== undefined ? { hit: hitLine } : {}) });
    // A long function is not shown whole. The function to edit (a definition, in an edit) is, up to BIG lines;
    // of any other, and of a class, the head and the lines where the request's words meet (or around the use).
    const long = b - a + 1 > (why === "definition" && mode !== "question" ? BIG : 70);
    if (!long) { push(a, b); return; }
    if (hitLine !== undefined && why !== "definition") { push(Math.max(a, hitLine - 10), Math.min(b, hitLine + 10)); return; }
    push(a, Math.min(b, a + 7));
    for (const w of denseWindows(lowOf(l), a + 8, b, wordList, mode === "question" ? 60 : 44)) push(w.a, w.b);
  };

  // 1. Names written as code. Hits first, so the names can be ordered: defined symbols with few uses lead.
  const info = names.map((name) => {
    const re = wordRe(name);
    const hits: Array<{ file: string; i: number }> = [];
    for (const [file, l] of loaded) { if (!l.lines.some((x) => x.includes(name))) continue; l.lines.forEach((x, i) => { if (re.test(x)) hits.push({ file, i }); }); }
    const defFiles = new Set<string>([...hits.map((h) => h.file), ...(graph?.find(name).filter((n) => !n.isFile && !n.note).map((n) => n.file) ?? [])]);
    const defs: Array<{ file: string; a: number; b: number }> = [];
    for (const file of defFiles) { const l = loaded.get(file); if (!l) continue; for (const r of symbolRanges(file, l.lines, entriesOf(file), name, graph)) defs.push({ file, ...r }); }
    return { name, hits, defs };
  }).filter((x) => x.hits.length || x.defs.length)
    // A plain word that is no symbol and is all over the code (a parameter name, "many") says nothing about where.
    .filter((x) => x.defs.length || x.hits.length <= 30)
    .sort((x, y) => Number(!x.defs.length) - Number(!y.defs.length) || x.hits.length - y.hits.length);
  info.forEach(({ name, hits, defs }, order) => {
    for (const d of defs) add(d.file, d.a, d.b, "definition", name, order);
    const srcDef = defs.some((d) => !isTestPath(d.file));
    // A class the request names: its methods that hold most of the request's words (a class is shown by its head,
    // and the answer is usually in one or two of its methods).
    if (!mustCallers && wordList.length) for (const d of defs) {
      const l = loaded.get(d.file)!;
      if (isTestPath(d.file) || d.b - d.a < 70) continue;
      const low = lowOf(l);
      const inside = entriesOf(d.file).filter((e) => e.kind !== "class" && e.start - 1 > d.a && e.end - 1 <= d.b)
        .map((e) => { const text = low.slice(e.start - 1, e.end).join("\n"); const nm = e.name.toLowerCase(); return { e, score: wordList.filter((w) => text.includes(w)).length + 2 * wordList.filter((w) => nm.includes(w)).length }; })
        .filter((x) => x.score > 0).sort((x, y) => y.score - x.score).slice(0, 4);
      for (const x of inside) add(d.file, withLead(l.lines, x.e.start - 1), x.e.end - 1, "related", x.e.name, -1);
    }
    const inDef = (file: string, i: number) => defs.some((d) => d.file === file && i >= d.a && i <= d.b);
    // A defined name used all over the project: its definition and the graph's callers only.
    if (hits.length <= 80) {
      for (const h of hits) {
        if (inDef(h.file, h.i)) continue;
        const l = loaded.get(h.file)!;
        if (srcDef && sites.length < 120) sites.push(`${h.file}:${h.i + 1}  ${l.lines[h.i].trim().slice(0, 110)}`);
        const s = enclosingSymbol(entriesOf(h.file), h.i + 1);
        if (s && s.kind !== "class") add(h.file, withLead(l.lines, s.start - 1), s.end - 1, defs.length ? "caller" : "use", name, order, h.i);
        else add(h.file, h.i - 3, h.i + 3, "use", name, order, h.i);
      }
    }
    if (graph && srcDef) {
      // Callers the text search cannot see (an alias, a dynamic use): functions only, after the ones found by text.
      for (const d of graph.dependentIds(name, 1)) {
        if (d.isFile || d.note) continue;
        const l = loaded.get(d.file);
        const s = l ? enclosingSymbol(entriesOf(d.file), d.line) : null;
        if (l && s && s.kind !== "class") add(d.file, withLead(l.lines, s.start - 1), s.end - 1, "caller", name, order + 0.5, d.line - 1);
      }
      // What it calls, and (not for a signature change) what those call: two hops below the named function,
      // walked by node (a method name shared by many classes must not pull in all of them).
      const prior = [...(o.named ?? []), ...(o.ranked ?? [])];
      const at = (f: string) => { const i = prior.indexOf(f); return i < 0 ? 99 : i; };
      const starts = graph.find(name).filter((n) => !n.isFile && !n.note && !isTestPath(n.file)).sort((x, y) => at(x.file) - at(y.file)).slice(0, 3);
      const seen = new Set<string>(starts.map((n) => n.id));
      let frontier = starts.map((n) => n.id);
      for (let hop = 0; hop < (mustCallers ? 1 : 2) && frontier.length; hop++) {
        const next: string[] = [];
        for (const from of frontier) for (const c of graph.calleesOf(from).slice(0, 10)) {
          const l = loaded.get(c.file);
          if (!l || isTestPath(c.file) || seen.has(c.id)) continue;
          seen.add(c.id); next.push(c.id);
          const es = entriesOf(c.file);
          const e = es.find((x) => x.name === c.name && Math.abs(x.start - c.line) <= 3) ?? enclosingSymbol(es.filter((x) => x.name === c.name), c.line);
          const r = e ? { a: withLead(l.lines, e.start - 1), b: e.end - 1 } : symbolRanges(c.file, l.lines, es, c.name, graph).sort((x, y) => Math.abs(x.a - c.line) - Math.abs(y.a - c.line))[0];
          if (r) add(c.file, r.a, r.b, "callee", c.name, order + hop * 0.3);
        }
        frontier = next.slice(0, 12);
      }
    }
  });

  // 2. Functions ranked by the request's words: rare words count more, a word in the function's name counts triple.
  if (words.length && o.related !== false) {
    const syms: Array<{ file: string; e: SymbolEntry; has: Set<string>; inName: Set<string> }> = [];
    for (const [file, l] of loaded) {
      if (!words.some((w) => (l.low ??= l.lines.map((x) => x.toLowerCase())).some((x) => x.includes(w)))) continue;
      for (const e of entriesOf(file)) {
        if (e.kind === "class" || e.kind === "interface" || e.kind === "type") continue;
        const text = l.low!.slice(e.start - 1, e.end).join("\n");
        const has = new Set(words.filter((w) => text.includes(w)));
        if (!has.size) continue;
        const nm = e.name.toLowerCase();
        syms.push({ file, e, has, inName: new Set(words.filter((w) => nm.includes(w))) });
      }
    }
    const prior = [...new Set([...(o.named ?? []), ...(o.ranked ?? [])])];
    const df = new Map<string, number>();
    for (const s of syms) for (const w of s.has) df.set(w, (df.get(w) ?? 0) + 1);
    const total = [...loaded.keys()].reduce((n, f) => n + entriesOf(f).length, 0) || 1;
    const idf = (w: string) => { const d = df.get(w) ?? 0; return d > total * 0.25 ? 0 : Math.log(1 + total / (d + 1)); };
    const scored = syms.map((s) => {
      let score = 0;
      for (const w of s.has) score += idf(w) * (s.inName.has(w) ? 3 : 1);
      const len = s.e.end - s.e.start + 1;
      // The file-level ranking (graph neighbours of what the request names, the task pack) is a mild prior only:
      // measured, a strong one (x2.5) pushed out the one function whose name held the request's words, in a file
      // no ranking pointed at.
      const at = prior.indexOf(s.file);
      const boost = at < 0 ? 1 : 1 + PRIOR_WEIGHT * (1 - at / Math.max(1, prior.length));
      return { ...s, score: score / Math.sqrt(Math.max(1, len / 60)) * (isTestPath(s.file) ? 0.5 : 1) * boost };
    }).filter((s) => s.score > 0).sort((x, y) => y.score - x.score);
    const top = scored[0]?.score ?? 0;
    // Down to a fraction of the best score: the budget shares below decide how many are shown.
    scored.filter((s) => s.score >= top * 0.15).slice(0, 40).forEach((s, k) => {
      const l = loaded.get(s.file)!;
      add(s.file, withLead(l.lines, s.e.start - 1), s.e.end - 1, "related", s.e.name, 100 + k);
      // What a match calls (graph, one hop) comes right after it, before the next match: the cause of a bug is
      // often one call below the function the request describes.
      if (graph && k < 12 && !isTestPath(s.file)) for (const c of graph.calleeIds(s.e.name).filter((x) => !x.note && !isTestPath(x.file) && loaded.has(x.file)).slice(0, 4)) {
        const cl = loaded.get(c.file)!;
        for (const r of symbolRanges(c.file, cl.lines, entriesOf(c.file), c.name, graph).slice(0, 1)) if (r.b - r.a < 80) add(c.file, r.a, r.b, "related", c.name, 100 + k + 0.5);
      }
    });
  }
  if (!ranges.length) return null;
  // A fix too: when what the request names has only a few users, they are always shown (measured: a signature
  // change routed as a fix lost a caller and its edit did not apply). A widely used function's callers get a share.
  const fewUsers = new Set<string>();
  if (mode === "fix") {
    const perName = new Map<string, number>();
    for (const r of ranges) if (r.why === "caller") perName.set(r.name, (perName.get(r.name) ?? 0) + 1);
    for (const [n, k] of perName) if (k <= 8) fewUsers.add(n);
    for (const r of ranges) if (r.why === "caller" && fewUsers.has(r.name)) r.prio = 0.5;
  }

  // Fill by priority (then the more specific name, then the smaller range); tests, callees and word matches are
  // each held to a share of the budget.
  const named = (o.named ?? []).filter((f) => loaded.has(f));
  const size = (r: ScopedRange) => rangeChars(loaded.get(r.file)!.lines, r.a, r.b, numbered);
  ranges.sort((x, y) => x.prio - y.prio || x.order - y.order || size(x) - size(y));
  const overhead = 2400; // the file listing, the call-site list and the markers
  const outlineBudget = Math.min(2000, Math.round(o.budgetChars * 0.17));
  const rangeBudget = Math.max(2000, o.budgetChars - outlineBudget - overhead);
  // Definitions and callers may run a third over: a refactor that misses a caller is wrong.
  const hardBudget = Math.round(rangeBudget * 1.25);
  const strong = ranges.some((r) => r.why === "definition" || r.why === "caller");
  const share: Record<string, number> = { test: Math.round(rangeBudget * 0.3), callee: Math.round(rangeBudget * (mustCallers ? 0.3 : 0.45)), related: Math.round(rangeBudget * (strong ? (mustCallers ? 0.4 : 0.5) : 1)), use: Math.round(rangeBudget * 0.3), caller: Math.round(rangeBudget * 0.3) };
  const spent: Record<string, number> = { test: 0, callee: 0, related: 0, use: 0, caller: 0 };
  const kept = new Map<string, Array<{ a: number; b: number }>>();
  const keptWhy = new Map<string, number>();
  const covered = (f: string, a: number, b: number) => (kept.get(f) ?? []).some((k) => k.a <= a && k.b >= b);
  let used = 0;
  let skipped = 0;
  for (const r of ranges) {
    if (covered(r.file, r.a, r.b)) continue;
    const cost = size(r);
    const must = r.why === "definition" || (r.why === "caller" && (mustCallers || fewUsers.has(r.name)));
    if (used + cost > (must ? hardBudget : rangeBudget)) {
      // A caller is never dropped for room: past the budget it is cut to the lines around the call (measured: two
      // of three call sites in one long function were left out, and the edit for them did not apply).
      if (must && r.hit !== undefined) {
        const a = Math.max(r.a, r.hit - 4), b = Math.min(r.b, r.hit + 5);
        const tight = rangeChars(loaded.get(r.file)!.lines, a, b, numbered);
        if (!covered(r.file, a, b) && used + tight <= rangeBudget * 2.5) { kept.set(r.file, [...(kept.get(r.file) ?? []), { a, b }]); keptWhy.set(r.file, Math.min(keptWhy.get(r.file) ?? 9, r.prio)); used += tight; continue; }
      }
      skipped++; continue;
    }
    if (!must && spent[r.why] + cost > share[r.why]) { skipped++; continue; }
    if (!must) spent[r.why] += cost;
    kept.set(r.file, [...(kept.get(r.file) ?? []), { a: r.a, b: r.b }]);
    keptWhy.set(r.file, Math.min(keptWhy.get(r.file) ?? 9, r.prio));
    used += cost;
  }
  // A file the request names that is not code (no symbols to scope by) and too large to show whole: its head and the
  // lines where the request's words meet.
  for (const f of named) {
    const l = loaded.get(f)!;
    if (CODE.test(f) || kept.has(f) || l.chars <= 5000) continue;
    const last = l.lines.length - 1;
    const parts = [{ a: 0, b: Math.min(last, 19) }, ...denseWindows(lowOf(l), Math.min(last, 20), last, wordList, 60)];
    const cost = parts.reduce((n, r) => n + rangeChars(l.lines, r.a, r.b, numbered), 0);
    if (used + cost > hardBudget) continue;
    kept.set(f, parts); keptWhy.set(f, 0); used += cost;
  }
  if (!kept.size && !named.length) return null;
  // Whole instead of in part: a short file that holds a definition or a caller, and a small file the request names.
  const wholeFiles = new Set<string>();
  for (const f of [...new Set([...named, ...kept.keys()])]) {
    const l = loaded.get(f);
    if (!l) continue;
    const isNamed = named.includes(f);
    const shownChars = (kept.get(f) ?? []).reduce((n, k) => n + rangeChars(l.lines, k.a, k.b, numbered), 0);
    const extra = l.chars - shownChars;
    const core = !isTestPath(f) && (keptWhy.get(f) ?? 9) <= 1;
    if ((isNamed && l.chars <= 5000 && used + extra <= hardBudget) || (core && l.lines.length <= 80 && used + extra <= hardBudget) || shownChars >= l.chars * 0.7) { wholeFiles.add(f); used += Math.max(0, extra); }
  }
  const seg: Segments = { ranges: 0, whole: 0, outlines: 0, callSites: 0 };
  const rank = (f: string) => Math.min(keptWhy.get(f) ?? 9, named.includes(f) ? 0 : 9);
  // Least important first: what is edited sits last, right before the task.
  const shown = [...new Set([...wholeFiles, ...kept.keys()])].sort((x, y) => rank(y) - rank(x) || x.localeCompare(y));
  const blocks: ScopedBlock[] = [];
  for (const f of shown) {
    const l = loaded.get(f)!;
    if (wholeFiles.has(f)) {
      const text = numbered ? l.lines.map((x, i) => `${i + 1}| ${x}`).join("\n") : l.lines.join("\n");
      blocks.push({ path: f, text, whole: true, lines: l.lines.length, chars: text.length }); seg.whole += text.length;
    } else {
      const text = renderRanges(l.lines, kept.get(f)!, numbered);
      blocks.push({ path: f, text, whole: false, lines: l.lines.length, chars: text.length }); seg.ranges += text.length;
    }
  }
  // Outlines: the files shown in part (most important first), then named and ranked files with nothing shown.
  const toOutline = [...shown.filter((f) => !wholeFiles.has(f)).reverse(), ...named.filter((f) => !shown.includes(f)), ...(o.ranked ?? []).filter((f) => loaded.has(f) && !shown.includes(f) && !isTestPath(f)).slice(0, 3)];
  const outs: string[] = [];
  let outUsed = 0;
  for (const f of [...new Set(toOutline)]) {
    const l = loaded.get(f)!;
    const es = entriesOf(f);
    if (!es.length) continue;
    const left = outlineBudget - outUsed;
    if (left < 250) break;
    const text = shortOutline(f, es, l.lines.length, Math.min(left, isTestPath(f) ? 300 : 1000), kept.get(f) ?? []);
    outs.push(text); outUsed += text.length + 2;
  }
  const outlines = outs.join("\n\n");
  seg.outlines = outlines.length;
  // Call sites: every use of the defined names, one line each, when the list is short enough to be read.
  let callSites = sites.length <= 60 ? sites : [];
  if (callSites.join("\n").length > 1300) { const all = callSites.length; callSites = []; let n = 0; for (const x of sites) { if (n + x.length > 1200) break; callSites.push(x); n += x.length + 1; } callSites.push(`… ${all - callSites.length} more uses (search for the name to see them)`); }
  seg.callSites = callSites.join("\n").length;
  if (skipped) seg.rangesSkipped = skipped;
  return { blocks, ranges: new Map([...kept].filter(([f]) => !wholeFiles.has(f))), wholeFiles: [...wholeFiles], outlines, callSites, names: info.filter((x) => x.defs.length).map((x) => x.name), segments: seg };
}

/**
 * Every line that uses one of `names` (whole word), as "path:line  text", for names used in 1 to `perName` places:
 * a short list a model can act on without searching (a name used everywhere is left out).
 */
export async function usesOf(root: string, files: string[], names: string[], o: { perName?: number; maxChars?: number; hidden?: (rel: string) => boolean } = {}): Promise<string[]> {
  const perName = o.perName ?? 30, maxChars = o.maxChars ?? 1500;
  const bodies = new Map<string, string[]>();
  await Promise.all(files.filter((f) => CODE.test(f) && !(o.hidden?.(f) ?? false)).slice(0, 800).map(async (f) => {
    const body = await fs.readFile(path.join(root, f), "utf8").catch(() => "");
    if (body && body.length <= 400_000) bodies.set(f, body.split("\n"));
  }));
  const out: string[] = [];
  let used = 0;
  for (const name of [...new Set(names)].slice(0, 8)) {
    const re = wordRe(name);
    const hits: string[] = [];
    for (const [f, lines] of [...bodies].sort((x, y) => Number(isTestPath(x[0])) - Number(isTestPath(y[0])) || x[0].localeCompare(y[0]))) lines.forEach((l, i) => { if (re.test(l)) hits.push(`${f}:${i + 1}  ${l.trim().slice(0, 100)}`); });
    if (!hits.length || hits.length > perName) continue;
    for (const h of hits) { if (used + h.length > maxChars) return [...out, "… more uses not listed"]; out.push(h); used += h.length + 1; }
  }
  return out;
}
