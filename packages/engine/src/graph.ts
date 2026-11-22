/**
 * Code graph (context-policy flag `graph`). Built by Graphify (https://github.com/Graphify-Labs/graphify, Apache-2.0,
 * pinned graphifyy 0.9.109) in code-only mode: local tree-sitter AST, no LLM pass, no API keys passed to it, nothing
 * leaves the machine. Stored at <workspace>/.apex/graph/ (graphify-out/graph.json plus hashes.json), rebuilt only
 * when a code file's hash changed.
 *
 * Where Graphify comes from: a host that packages the engine can ship its own copy (a relocatable Python with the
 * pinned packages at <host>/server/graphify-runtime); otherwise a graphify on the PATH is used (`pip install
 * graphifyy`, 0.9.109 is the version this engine was measured with). Without any, the engine works from plain files.
 *
 * Queries run in-process on graph.json (nodes: id, label, source_file, source_location; links: source, target,
 * relation, confidence EXTRACTED | INFERRED). When no Graphify is found or the build fails, every caller gets null
 * and keeps the behaviour without the graph; `graphifyStatus()` says which in one line.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fs, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CODE_EXT = /\.(m?[jt]sx?|cjs|py)$/;
const SKIP_DIRS = new Set([".git", ".apex", "node_modules", ".venv", "venv", "dist", "build", "out", ".next", "coverage", "__pycache__", "graphify-out", ".cache"]);
/** Edges that make the source depend on the target. */
const DEP_RELATIONS = new Set(["calls", "indirect_call", "references", "imports", "imports_from", "dynamic_import", "re_exports", "inherits", "extends", "implements", "uses", "mixes_in", "requires"]);

export interface GraphNode { id: string; label: string; name: string; file: string; line: number; isFile: boolean; /** A docstring / comment node (file_type "rationale" or "concept"), not code. */ note?: boolean }
export interface GraphEdge { source: string; target: string; relation: string; extracted: boolean }

// ---- policy switch -------------------------------------------------------------------------------------------
const enabled = new Map<string, boolean>();
/** Turns graph use on or off for one workspace (set by the agent loop from the `graph` flag). APEX_GRAPH=1|0 overrides. */
export function setGraphPolicy(root: string, on: boolean): void { if (root) enabled.set(path.resolve(root), on); }
export function graphEnabled(root: string): boolean {
  if (process.env.APEX_GRAPH === "0") return false;
  if (process.env.APEX_GRAPH === "1") return true;
  return enabled.get(path.resolve(root)) === true;
}

/**
 * How far the graph narrows what is sent (only when the policy is on): "scoped" (default) sends symbol ranges and
 * outlines; "files" sends whole files but only the ones the request and the graph point at; "off" keeps the old
 * fill-the-budget context. APEX_GRAPH_SCOPE=off|files|scoped is a switch for measuring each step and for backing out.
 */
export function graphScope(): "off" | "files" | "scoped" {
  const v = (process.env.APEX_GRAPH_SCOPE ?? "").toLowerCase();
  return v === "0" || v === "off" ? "off" : v === "files" ? "files" : "scoped";
}

// ---- the graph -----------------------------------------------------------------------------------------------
const bare = (label: string) => label.replace(/\(\)$/, "").replace(/^\./, "").split(".").pop() ?? label;
/** A test file, by folder or by name, in the languages Apex reads (the one definition: scoped-context.ts and mechanical.ts use it). */
export const TEST_PATH = /(^|\/)(tests?|__tests__)\/|[._](test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/;
export const isTestPath = (f: string): boolean => TEST_PATH.test(f);

/** A text cut to a budget at a line boundary, with a count of the lines left out (the first line always stays). */
export function cutAtLine(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lines = text.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const l of lines) { if (kept.length && used + l.length + 1 > maxChars) break; kept.push(l); used += l.length + 1; }
  return `${kept.join("\n")}\n… ${lines.length - kept.length} more line${lines.length - kept.length === 1 ? "" : "s"} not shown`;
}

export class CodeGraph {
  readonly nodes = new Map<string, GraphNode>();
  readonly out = new Map<string, GraphEdge[]>();
  readonly in = new Map<string, GraphEdge[]>();
  readonly byName = new Map<string, string[]>();
  readonly byFile = new Map<string, string[]>();

  constructor(json: { nodes?: unknown[]; links?: unknown[]; edges?: unknown[] }) {
    for (const raw of json.nodes ?? []) {
      const n = raw as { id?: string; label?: string; source_file?: string; source_location?: string; file_type?: string };
      if (!n.id || !n.source_file) continue;
      const label = String(n.label ?? n.id);
      const file = String(n.source_file).replace(/^\.\//, "");
      const isFile = path.posix.basename(file) === label;
      const node: GraphNode = { id: n.id, label, name: isFile ? label : bare(label), file, line: Number(/\d+/.exec(n.source_location ?? "")?.[0] ?? 1), isFile, ...(n.file_type === "rationale" || n.file_type === "concept" ? { note: true } : {}) };
      this.nodes.set(node.id, node);
      const key = node.name.toLowerCase();
      this.byName.set(key, [...(this.byName.get(key) ?? []), node.id]);
      this.byFile.set(file, [...(this.byFile.get(file) ?? []), node.id]);
    }
    for (const raw of json.links ?? json.edges ?? []) {
      const e = raw as { source?: string; target?: string; relation?: string; confidence?: string };
      if (!e.source || !e.target || !this.nodes.has(e.source) || !this.nodes.has(e.target) || e.source === e.target) continue;
      const edge: GraphEdge = { source: e.source, target: e.target, relation: String(e.relation ?? "related"), extracted: e.confidence !== "INFERRED" && e.confidence !== "AMBIGUOUS" };
      this.out.set(edge.source, [...(this.out.get(edge.source) ?? []), edge]);
      this.in.set(edge.target, [...(this.in.get(edge.target) ?? []), edge]);
    }
  }

  get size(): number { return this.nodes.size; }

  /** Nodes a name refers to: a symbol name (`foo`, `foo()`, `Cls.foo`) or a file path. */
  find(term: string): GraphNode[] {
    const t = term.trim().replace(/^\.\//, "");
    if (!t) return [];
    const inFile = this.byFile.get(t);
    if (inFile) { const ns = inFile.map((id) => this.nodes.get(id)!); return [ns.find((n) => n.isFile) ?? ns[0]]; }
    const ids = this.byName.get(bare(t.replace(/\(.*$/, "")).toLowerCase()) ?? [];
    return ids.map((id) => this.nodes.get(id)!).filter((n) => !n.isFile);
  }

  /** Graph nodes the request names: identifiers in it that are symbols here, and file paths. */
  seeds(task: string): GraphNode[] {
    const words = new Set<string>();
    // Words the request writes inside backticks are code whatever their shape.
    const ticked = new Set<string>();
    for (const m of task.matchAll(/`([^`\n]+)`/g)) for (const w of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) ticked.add(w[0]);
    for (const m of task.matchAll(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g)) {
      const w = m[0];
      if (w.length < 3) continue;
      // Plain lower-case English words count only when they are also a symbol with a code-like shape elsewhere.
      words.add(w.split(".").pop()!);
    }
    const found: GraphNode[] = [];
    for (const f of task.match(/[\w./-]+\.(?:m?[jt]sx?|cjs|py)\b/g) ?? []) found.push(...this.find(f));
    for (const w of words) {
      const ids = this.byName.get(w.toLowerCase()) ?? [];
      const code = /[A-Z_]/.test(w.slice(1)) || /[_$]/.test(w) || w.length >= 6 || ticked.has(w);
      if (!code && ids.length > 3) continue;
      for (const id of ids) { const n = this.nodes.get(id)!; if (!n.isFile) found.push(n); }
    }
    return [...new Map(found.map((n) => [n.id, n])).values()].slice(0, 24);
  }

  /** Files ranked for a request: seeds, then 1–2 hop neighbours over dependency edges, EXTRACTED weighted above INFERRED. */
  rankFiles(task: string, k = 8): string[] {
    const score = new Map<string, number>();
    const add = (file: string, s: number) => score.set(file, (score.get(file) ?? 0) + s);
    let frontier = new Map(this.seeds(task).map((n) => [n.id, 1]));
    const seen = new Set(frontier.keys());
    for (const [id, s] of frontier) add(this.nodes.get(id)!.file, s * 2);
    for (let hop = 1; hop <= 2 && frontier.size; hop++) {
      const next = new Map<string, number>();
      for (const [id, s] of frontier) {
        for (const e of [...(this.out.get(id) ?? []), ...(this.in.get(id) ?? [])]) {
          if (!DEP_RELATIONS.has(e.relation)) continue;
          const other = e.source === id ? e.target : e.source;
          const w = s * (e.extracted ? 0.6 : 0.25);
          const n = this.nodes.get(other)!;
          add(n.file, w);
          if (!seen.has(other)) { seen.add(other); next.set(other, Math.max(next.get(other) ?? 0, w)); }
        }
      }
      frontier = next;
    }
    // Tests rank below the code they exercise unless the request is about tests.
    if (!/\btests?\b|\bspec\b/i.test(task)) for (const [f, sc] of score) if (isTestPath(f)) score.set(f, sc * 0.5);
    return [...score].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([f]) => f).slice(0, k);
  }

  /** Shortest path between two names, either direction of edges. */
  path(a: string, b: string, maxHops = 6): string {
    const from = this.find(a), to = new Set(this.find(b).map((n) => n.id));
    if (!from.length) return `No node named ${a}.`;
    if (!to.size) return `No node named ${b}.`;
    const prev = new Map<string, { id: string; edge: GraphEdge } | null>(from.map((n) => [n.id, null]));
    let frontier = from.map((n) => n.id), hit = "";
    for (let d = 0; d < maxHops && frontier.length && !hit; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const e of [...(this.out.get(id) ?? []), ...(this.in.get(id) ?? [])]) {
          const other = e.source === id ? e.target : e.source;
          if (prev.has(other)) continue;
          prev.set(other, { id, edge: e });
          if (to.has(other)) { hit = other; break; }
          next.push(other);
        }
        if (hit) break;
      }
      frontier = next;
    }
    if (!hit) return `No path from ${a} to ${b} within ${maxHops} hops.`;
    const steps: string[] = [];
    for (let cur = hit, p = prev.get(cur); p; cur = p.id, p = prev.get(cur)) {
      const e = p.edge, fwd = e.source === p.id;
      steps.unshift(`${fwd ? "--" : "<--"}${e.relation}${e.extracted ? "" : "?"}${fwd ? "-->" : "--"} ${this.show(cur)}`);
    }
    return [this.show(this.root(hit, prev)), ...steps].join("\n");
  }

  private root(id: string, prev: Map<string, { id: string } | null>): string {
    let cur = id;
    for (let p = prev.get(cur); p; p = prev.get(cur)) cur = p.id;
    return cur;
  }

  show(id: string): string { const n = this.nodes.get(id)!; return `${n.label} (${n.file}:${n.line})`; }

  /** A node and its direct connections, most certain first. */
  explain(name: string, limit = 12): string {
    const hits = this.find(name);
    if (!hits.length) return `No node named ${name}.`;
    return hits.slice(0, 3).map((n) => {
      const edges = [...(this.out.get(n.id) ?? []).map((e) => ({ e, dir: "-->", other: e.target })), ...(this.in.get(n.id) ?? []).map((e) => ({ e, dir: "<--", other: e.source }))]
        .filter((x) => x.e.relation !== "contains" || n.isFile)
        .sort((x, y) => Number(y.e.extracted) - Number(x.e.extracted));
      const lines = edges.slice(0, limit).map((x) => `  ${x.dir} ${x.e.relation}${x.e.extracted ? "" : " (inferred)"} ${this.show(x.other)}`);
      return `${this.show(n.id)}: ${edges.length} connections\n${lines.join("\n")}${edges.length > limit ? `\n  …${edges.length - limit} more` : ""}`;
    }).join("\n\n");
  }

  /** What depends on a symbol or a file (reverse dependency edges, up to `depth` hops), as node ids. */
  dependentIds(name: string, depth = 2): GraphNode[] {
    const starts = this.find(name);
    const startIds = new Set<string>();
    for (const n of starts) {
      startIds.add(n.id);
      if (n.isFile) for (const id of this.byFile.get(n.file) ?? []) startIds.add(id);
    }
    const seen = new Set(startIds);
    const result: GraphNode[] = [];
    let frontier = [...startIds];
    for (let d = 0; d < depth && frontier.length; d++) {
      const next: string[] = [];
      for (const id of frontier) for (const e of this.in.get(id) ?? []) {
        if (!DEP_RELATIONS.has(e.relation) || seen.has(e.source)) continue;
        seen.add(e.source);
        const n = this.nodes.get(e.source)!;
        if (starts.some((s) => s.file === n.file && s.isFile)) continue;
        result.push(n);
        next.push(e.source);
      }
      frontier = next;
    }
    return result;
  }

  /**
   * Line ranges (1-based) of a file's symbols. Graphify records start lines only, so a symbol ends where the next
   * one starts; symbols.ts gives the real end when it knows the symbol (scoped-context.ts prefers it).
   */
  ranges(file: string, totalLines = Number.MAX_SAFE_INTEGER): Array<{ node: GraphNode; start: number; end: number }> {
    const ns = (this.byFile.get(file.replace(/^\.\//, "")) ?? []).map((id) => this.nodes.get(id)!).filter((n) => !n.isFile && !n.note).sort((a, b) => a.line - b.line);
    return ns.map((node, i) => ({ node, start: node.line, end: Math.max(node.line, (ns.slice(i + 1).find((x) => x.line > node.line)?.line ?? totalLines + 1) - 1) }));
  }

  /** What one node calls or uses directly (out edges by node id, so a method name shared by many classes stays exact). */
  calleesOf(id: string): GraphNode[] {
    const out = new Map<string, GraphNode>();
    for (const e of this.out.get(id) ?? []) {
      if (!DEP_RELATIONS.has(e.relation) || /^imports|^re_exports|^requires/.test(e.relation)) continue;
      const t = this.nodes.get(e.target)!;
      if (!t.isFile && !t.note && t.id !== id) out.set(t.id, t);
    }
    return [...out.values()];
  }

  /** What a symbol calls or uses directly (out edges), symbols only. */
  calleeIds(name: string): GraphNode[] {
    const out = new Map<string, GraphNode>();
    for (const n of this.find(name)) for (const t of this.calleesOf(n.id)) out.set(t.id, t);
    return [...out.values()];
  }

  dependents(name: string, limit = 15): string {
    if (!this.find(name).length) return `No node named ${name}.`;
    const deps = this.dependentIds(name);
    if (!deps.length) return `Nothing in the project depends on ${name}.`;
    const byFile = new Map<string, string[]>();
    for (const n of deps) byFile.set(n.file, [...(byFile.get(n.file) ?? []), n.isFile ? `(imports it) L${n.line}` : `${n.name} L${n.line}`]);
    const lines = [...byFile].slice(0, limit).map(([f, ls]) => `- ${f}: ${[...new Set(ls)].slice(0, 5).join(", ")}${isTestPath(f) ? " [test]" : ""}`);
    return `${name}: ${byFile.size} dependent file${byFile.size === 1 ? "" : "s"}\n${lines.join("\n")}${byFile.size > limit ? `\n…${byFile.size - limit} more files` : ""}`;
  }

  /**
   * Before an edit: the symbols the request names (defined outside tests) and who uses them, with locations, so the
   * model sees the callers before it changes a signature or behaviour. Empty when nothing named has dependents.
   */
  callersBrief(task: string, maxChars = 1500): string {
    // Only names written as code: inside backticks, or with a code shape (snake_case, camelCase, a call).
    const strong = new Set<string>();
    for (const m of task.matchAll(/`([^`]+)`/g)) for (const w of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) strong.add(w[0].toLowerCase());
    for (const m of task.matchAll(/[A-Za-z_$][\w$]*/g)) if (/[_$]/.test(m[0]) || /[a-z][A-Z]/.test(m[0])) strong.add(m[0].toLowerCase());
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const n of this.seeds(task)) {
      const key = n.name.toLowerCase();
      if (n.isFile || isTestPath(n.file) || seen.has(key) || !strong.has(key)) continue;
      seen.add(key);
      const users = this.dependentIds(n.name, 1).filter((d) => !d.isFile || d.file !== n.file)
        .sort((x, y) => Number(isTestPath(x.file)) - Number(isTestPath(y.file)));
      if (!users.length) continue;
      const locs = [...new Set(users.map((d) => `${d.file}:${d.line}${d.isFile ? " (imports it)" : ` ${d.name}`}${isTestPath(d.file) ? " [test]" : ""}`))];
      lines.push(`- ${n.label} (${n.file}:${n.line}) is used by ${locs.slice(0, 6).join(", ")}${locs.length > 6 ? ` and ${locs.length - 6} more` : ""}`);
      if (lines.length >= 6) break;
    }
    if (!lines.length) return "";
    const out = `Callers of what this request names (code graph; check them before changing a signature or behaviour, and update them with it):\n${lines.join("\n")}`;
    return cutAtLine(out, maxChars);
  }

  /**
   * For a question: a compact subgraph around what it names (each named thing's direct connections, EXTRACTED first,
   * and the paths between them), plus the files to read, ranked by the graph. Empty text when nothing is named.
   */
  questionBrief(question: string, maxChars = 4000): { text: string; files: string[] } {
    const seeds = this.seeds(question).filter((n) => !isTestPath(n.file));
    const names = [...new Set(seeds.map((n) => (n.isFile ? n.file : n.name)))].slice(0, 4);
    if (!names.length) return { text: "", files: [] };
    const parts = names.map((nm) => this.explain(nm, 8));
    const paths: string[] = [];
    for (let i = 0; i < names.length && paths.length < 3; i++) for (let j = i + 1; j < names.length && paths.length < 3; j++) {
      const p = this.path(names[i], names[j], 5);
      if (!/^No /.test(p) && p.split("\n").length > 2) paths.push(`${names[i]} → ${names[j]}:\n${p}`);
    }
    const text = `Code graph around the question (calls, imports, inheritance; "(inferred)" edges are less certain):\n${parts.join("\n\n")}${paths.length ? `\n\nHow they connect:\n${paths.join("\n\n")}` : ""}`;
    return { text: cutAtLine(text, maxChars), files: this.rankFiles(question, 6) };
  }

  /** Test files that exercise the given source files: tests among their dependents, then by name (a.js → a.test.js, test_a.py). */
  testsCovering(files: string[]): string[] {
    const tests = new Set<string>();
    const allFiles = [...this.byFile.keys()];
    for (const f of files) {
      if (isTestPath(f)) continue;
      for (const n of this.dependentIds(f, 2)) if (isTestPath(n.file)) tests.add(n.file);
      const stem = path.posix.basename(f).replace(/\.[^.]+$/, "");
      for (const t of allFiles) {
        if (!isTestPath(t)) continue;
        const b = path.posix.basename(t);
        if (b.startsWith(stem + ".") || b === `test_${stem}.py` || b === `${stem}_test.py`) tests.add(t);
      }
    }
    return [...tests].sort();
  }
}

// ---- building ------------------------------------------------------------------------------------------------
/** Where the graph cache lives: <project>/.apex/graph, or under APEX_CACHE_DIR (one folder per project) so a host can keep the project untouched. */
export function graphDir(root: string): string {
  const base = process.env.APEX_CACHE_DIR;
  if (base) return path.join(base, "graphs", createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 16));
  return path.join(root, ".apex", "graph");
}
const graphJson = (root: string) => path.join(graphDir(root), "graphify-out", "graph.json");

/** The Graphify version Apex is built and measured with; a bundled copy of any other version is not used. */
export const GRAPHIFY_VERSION = "0.9.109";

export interface GraphifyLocation {
  bin: string;
  /** "env": APEX_GRAPHIFY. "bundled": shipped inside the app. "installed": one the user installed (uv tool bin, Homebrew, PATH). */
  source: "env" | "bundled" | "installed";
  /** Known for the bundled copy only (from its manifest). */
  version?: string;
}

/** Folders that may hold the bundled runtime: APEX_GRAPHIFY_RUNTIME, then <app>/server/graphify-runtime (four levels above this file in the packaged app). */
function runtimeDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.APEX_GRAPHIFY_RUNTIME) dirs.push(process.env.APEX_GRAPHIFY_RUNTIME);
  try { dirs.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "graphify-runtime")); } catch { /* not a file URL */ }
  return dirs;
}

/**
 * The bundled runtime in a folder, when it is complete and made for this machine. `why` says what is wrong
 * otherwise (empty when the folder simply is not there, as in a run from the repo).
 */
export function bundledGraphify(dir: string): { bin: string | null; why: string } {
  const manifestFile = path.join(dir, "manifest.json");
  if (!existsSync(manifestFile)) return { bin: null, why: "" };
  let m: { name?: string; graphifyy?: string; platform?: string; arch?: string; bin?: string };
  try { m = JSON.parse(readFileSync(manifestFile, "utf8")) as typeof m; } catch { return { bin: null, why: "the bundled copy's manifest cannot be read" }; }
  if (m.name !== "apex-graphify-runtime" || typeof m.graphifyy !== "string") return { bin: null, why: "the bundled copy's manifest is not valid" };
  if (m.graphifyy !== GRAPHIFY_VERSION) return { bin: null, why: `the bundled copy is graphify ${m.graphifyy}, not the pinned ${GRAPHIFY_VERSION}` };
  if (m.platform !== process.platform || m.arch !== process.arch) return { bin: null, why: `the bundled copy is for ${m.platform}-${m.arch}, this machine is ${process.platform}-${process.arch}` };
  const bin = path.resolve(dir, typeof m.bin === "string" ? m.bin : "bin/graphify");
  // The launcher must stay inside the runtime folder whatever the manifest says.
  if (path.relative(dir, bin).startsWith("..") || !existsSync(bin)) return { bin: null, why: "the bundled copy is incomplete" };
  return { bin, why: "" };
}

/** Why the bundled copy was passed over, for the status line ("" when there is none or it is in use). */
let bundledProblem = "";

/**
 * Every Graphify on this machine, best first: APEX_GRAPHIFY (an explicit override), the copy bundled in the app,
 * then one the user installed (uv's tool bin, Homebrew, PATH). Only looks at the disk: nothing is downloaded.
 */
export function graphifyCandidates(): GraphifyLocation[] {
  const found: GraphifyLocation[] = [];
  const add = (loc: GraphifyLocation) => { if (!found.some((f) => f.bin === loc.bin)) found.push(loc); };
  if (process.env.APEX_GRAPHIFY && existsSync(process.env.APEX_GRAPHIFY)) add({ bin: process.env.APEX_GRAPHIFY, source: "env" });
  bundledProblem = "";
  for (const dir of runtimeDirs()) {
    const b = bundledGraphify(dir);
    if (b.bin) { add({ bin: b.bin, source: "bundled", version: GRAPHIFY_VERSION }); bundledProblem = ""; break; }
    if (b.why) bundledProblem = b.why;
  }
  const installed = [path.join(os.homedir(), ".local", "bin", "graphify"), "/opt/homebrew/bin/graphify", "/usr/local/bin/graphify",
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, "graphify"))];
  for (const bin of installed) if (existsSync(bin)) add({ bin, source: "installed" });
  return found;
}

/** The Graphify Apex will run, or null when there is none. */
export function locateGraphify(): GraphifyLocation | null { return graphifyCandidates()[0] ?? null; }

/** The graphify executable (see graphifyCandidates). Null when there is none. */
export function graphifyBin(): string | null { return locateGraphify()?.bin ?? null; }

/** One line on where the code graph stands on this machine (and, with a workspace, whether it is switched on there). */
export function graphifyStatus(root?: string): string {
  if (process.env.APEX_GRAPH === "0" || (root && !graphEnabled(root))) return "Code graph: off (switched off).";
  const loc = locateGraphify();
  const problem = bundledProblem ? `; ${bundledProblem}` : "";
  if (!loc) return `Code graph: off, no graphify found${problem || " (no copy bundled in this build and none installed)"}. Apex works as without the graph and downloads nothing.`;
  const what = loc.source === "bundled" ? `the bundled graphify ${loc.version}` : loc.source === "env" ? `graphify from APEX_GRAPHIFY (${loc.bin})` : `the graphify installed at ${loc.bin} (version not checked; ${GRAPHIFY_VERSION} is the pinned one)`;
  return `Code graph: on, using ${what}${problem}.`;
}

let statusLogged = "";
/** Writes the status to the server log, once per distinct status. */
function logStatus(extra = ""): void {
  const line = graphifyStatus() + extra;
  if (line === statusLogged || process.env.APEX_GRAPH_QUIET === "1") return;
  statusLogged = line;
  console.error(`[apex] ${line}`);
}

async function codeFiles(root: string, rel = "", out: string[] = []): Promise<string[]> {
  if (out.length > 5000) return out;
  let entries;
  try { entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) await codeFiles(root, r, out); }
    else if (e.isFile() && CODE_EXT.test(e.name)) out.push(r);
  }
  return out;
}

type HashState = Record<string, { size: number; mtime: number; hash: string }>;

/** Hashes of the project's code files; unchanged size+mtime reuse the stored hash, so a check is cheap. */
export async function codeHashes(root: string, prior: HashState = {}): Promise<HashState> {
  const state: HashState = {};
  for (const rel of (await codeFiles(root)).sort()) {
    let st;
    try { st = statSync(path.join(root, rel)); } catch { continue; }
    const p = prior[rel];
    if (p && p.size === st.size && p.mtime === st.mtimeMs) { state[rel] = p; continue; }
    const hash = createHash("sha1").update(await fs.readFile(path.join(root, rel))).digest("hex");
    state[rel] = { size: st.size, mtime: st.mtimeMs, hash };
  }
  return state;
}
const sameHashes = (a: HashState, b: HashState) => {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => b[k]?.hash === a[k].hash);
};

/** Environment for graphify: no API keys or tokens, so no semantic (LLM) pass can run even by accident. */
function offlineEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k)) env[k] = v;
  // Python writes no bytecode (the bundled copy is inside the signed app) and reads no user site-packages.
  return { ...env, GRAPHIFY_NO_LLM: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" };
}

/** "ok", or why not: "timeout" (the project is too big for the time given: another copy would not do better) or "failed". */
function runGraphify(bin: string, root: string, timeoutMs: number): Promise<"ok" | "timeout" | "failed"> {
  return new Promise((resolve) => {
    execFile(bin, ["extract", root, "--code-only", "--no-cluster", "--out", graphDir(root)], { cwd: root, timeout: timeoutMs, env: offlineEnv(), maxBuffer: 4 << 20 },
      (err) => resolve(!err && existsSync(graphJson(root)) ? "ok" : err && (err as { killed?: boolean }).killed ? "timeout" : "failed"));
  });
}

/** Builds with the first Graphify that works: when the preferred copy cannot run (damaged, wrong machine), the next one is tried. */
async function runAnyGraphify(candidates: GraphifyLocation[], root: string, timeoutMs: number): Promise<boolean> {
  for (const c of candidates) {
    const r = await runGraphify(c.bin, root, timeoutMs);
    if (r === "ok") return true;
    logStatus(` Build ${r === "timeout" ? "timed out" : "failed"} with ${c.source === "bundled" ? "the bundled copy" : c.bin}; this turn runs without the graph unless another copy works.`);
    if (r === "timeout") return false;
  }
  return false;
}

const loaded = new Map<string, { key: string; graph: CodeGraph }>();
const building = new Map<string, Promise<CodeGraph | null>>();

async function build(root: string, timeoutMs: number): Promise<CodeGraph | null> {
  const candidates = graphifyCandidates();
  logStatus();
  if (!candidates.length) return null;
  const hashFile = path.join(graphDir(root), "hashes.json");
  let prior: HashState = {};
  try { prior = JSON.parse(await fs.readFile(hashFile, "utf8")) as HashState; } catch { /* first build */ }
  const now = await codeHashes(root, prior);
  if (!Object.keys(now).length) return null;
  const key = createHash("sha1").update(JSON.stringify(Object.entries(now).map(([f, h]) => [f, h.hash]))).digest("hex");
  const cached = loaded.get(root);
  if (cached?.key === key) return cached.graph;
  const fresh = existsSync(graphJson(root)) && sameHashes(prior, now);
  if (!fresh) {
    await fs.mkdir(graphDir(root), { recursive: true });
    await fs.writeFile(path.join(graphDir(root), ".gitignore"), "*\n").catch(() => undefined);
    if (!(await runAnyGraphify(candidates, root, timeoutMs))) return null;
  }
  await fs.writeFile(hashFile, JSON.stringify(now));
  try {
    const graph = new CodeGraph(JSON.parse(await fs.readFile(graphJson(root), "utf8")));
    if (!graph.size) return null;
    loaded.set(root, { key, graph });
    return graph;
  } catch { return null; }
}

/**
 * The graph for a workspace, built or refreshed when code changed. Concurrent callers share one build. Resolves to
 * null when graphify is missing, the build fails, or it takes longer than `waitMs` (the build keeps going in the
 * background and the next call gets it).
 */
export function ensureGraph(root: string, waitMs = 10_000, buildTimeoutMs = 120_000): Promise<CodeGraph | null> {
  if (!root) return Promise.resolve(null);
  const key = path.resolve(root);
  let p = building.get(key);
  if (!p) {
    p = build(key, buildTimeoutMs).catch(() => null).finally(() => building.delete(key));
    building.set(key, p);
  }
  if (waitMs <= 0) return p;
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), waitMs).unref())]);
}

/** Starts a build without waiting (project opened). */
export function warmGraph(root: string): void { if (root && graphEnabled(root)) void ensureGraph(root, 0); }

/** The graph when the policy is on for this workspace, else null. */
export async function graphFor(root: string, waitMs = 10_000): Promise<CodeGraph | null> {
  if (!root || !graphEnabled(root)) return null;
  return ensureGraph(root, waitMs);
}

/** The last graph loaded for a workspace (possibly from before the latest edit), without waiting; null when off. */
export function cachedGraph(root: string): CodeGraph | null {
  if (!root || !graphEnabled(root)) return null;
  return loaded.get(path.resolve(root))?.graph ?? null;
}

/** Short note listing what depends on the symbols a change touched (for the model, after an edit). */
export function dependentsNote(graph: CodeGraph, file: string, symbols: string[]): string {
  const names = [...new Set(symbols)].filter((s) => graph.find(s).some((n) => n.file === file)).slice(0, 3);
  const lines: string[] = [];
  for (const s of names) {
    const deps = graph.dependentIds(s, 1).filter((n) => n.file !== file);
    if (!deps.length) continue;
    const files = [...new Set(deps.map((n) => n.file))];
    lines.push(`${s} is used by ${files.slice(0, 6).join(", ")}${files.length > 6 ? ` and ${files.length - 6} more` : ""}`);
  }
  return lines.length ? `\nDependents (code graph): ${lines.join("; ")}. Keep them working.` : "";
}
