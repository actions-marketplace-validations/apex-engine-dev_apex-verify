/**
 * Read code by symbol instead of by file: an outline of a file, or one function / class with its line numbers.
 * Heuristic and dependency-free (JS/TS by braces, Python by indentation), so it works in any project.
 */

export interface SymbolEntry {
  name: string;
  kind: "function" | "class" | "method" | "const" | "interface" | "type";
  start: number; // 1-based line
  end: number;
  signature: string;
}

const PY = /\.py$/i;

const JS_DECL: Array<[RegExp, SymbolEntry["kind"]]> = [
  [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/, "function"],
  [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, "class"],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/, "function"],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Z_][A-Z0-9_]*)\s*=/, "const"],
  [/^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, "interface"],
  [/^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=/, "type"],
];
const JS_METHOD = /^\s{2,8}(?:public\s+|private\s+|protected\s+|static\s+|async\s+|get\s+|set\s+|readonly\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/;
const NOT_METHOD = new Set(["if", "for", "while", "switch", "catch", "function", "return", "constructor", "else"]);

/** Last line of a block that opens with "{" on or after `from` (0-based). Strings and comments are skipped roughly. */
function braceEnd(lines: string[], from: number): number {
  let depth = 0;
  let opened = false;
  for (let i = from; i < lines.length; i++) {
    const line = lines[i].replace(/\/\/.*$/, "").replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "\"\"");
    for (const ch of line) {
      if (ch === "{") { depth++; opened = true; }
      else if (ch === "}") depth--;
    }
    if (opened && depth <= 0) return i;
    if (!opened && /;\s*$/.test(line)) return i; // a one-line arrow, const or type ends on its own line
    // The same without a semicolon: the line is complete (brackets balanced, no operator left hanging) and the next
    // line starts something else, so the declaration does not swallow the function below it.
    if (!opened && i === from && completeLine(line) && startsNewStatement(lines[i + 1], lines[from])) return i;
    if (!opened && i - from > 3 && /;\s*$/.test(lines[i])) return i;
  }
  return Math.min(lines.length - 1, from + 40);
}

function completeLine(line: string): boolean {
  let depth = 0;
  for (const ch of line) { if (ch === "(" || ch === "[") depth++; else if (ch === ")" || ch === "]") depth--; }
  return depth === 0 && !/(=>|[=([{,+\-*/|&?:.<])\s*$/.test(line);
}

function startsNewStatement(next: string | undefined, first: string): boolean {
  if (next === undefined || !next.trim()) return true;
  const indent = (l: string) => (l.match(/^\s*/) ?? [""])[0].length;
  return indent(next) <= indent(first) && !/^\s*[.|&?:+\-*/,)\]{]/.test(next);
}

function pyEnd(lines: string[], from: number): number {
  const indent = (lines[from].match(/^\s*/) ?? [""])[0].length;
  // A signature over several lines ("def f(\n    a,\n) -> int:") closes at the def's own indentation: the body
  // starts after the line where its brackets balance (measured: such a function ended at its signature).
  let sigEnd = from;
  for (let depth = 0, i = from; i < Math.min(lines.length, from + 60); i++) {
    for (const ch of lines[i].replace(/(["'])(?:\\.|(?!\1).)*\1/g, "").replace(/#.*$/, "")) { if ("([{".includes(ch)) depth++; else if (")]}".includes(ch)) depth--; }
    if (depth <= 0) { sigEnd = i; break; }
  }
  let last = sigEnd;
  for (let i = sigEnd + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const ind = (lines[i].match(/^\s*/) ?? [""])[0].length;
    if (ind <= indent) break;
    last = i;
  }
  return last;
}

export function outline(path: string, text: string): SymbolEntry[] {
  const lines = text.split("\n");
  const out: SymbolEntry[] = [];
  if (PY.test(path)) {
    lines.forEach((line, i) => {
      const m = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/.exec(line);
      if (!m) return;
      const kind = m[2] === "class" ? "class" : m[1].length ? "method" : "function";
      out.push({ name: m[3], kind, start: i + 1, end: pyEnd(lines, i) + 1, signature: line.trim().replace(/:\s*$/, "") });
    });
    return out;
  }
  let classEnd = -1;
  let fnEnd = -1;
  lines.forEach((line, i) => {
    for (const [re, kind] of JS_DECL) {
      const m = re.exec(line);
      // Helpers declared inside a function body are part of it, not entries of their own.
      if (m && i <= fnEnd && /^\s+/.test(line)) return;
      if (m) {
        const end = braceEnd(lines, i);
        out.push({ name: m[1], kind, start: i + 1, end: end + 1, signature: line.trim().replace(/\s*\{\s*$/, "").slice(0, 160) });
        if (kind === "class") classEnd = end;
        else if (kind === "function") fnEnd = Math.max(fnEnd, end);
        return;
      }
    }
    if (i <= classEnd) {
      const m = JS_METHOD.exec(line);
      if (m && !NOT_METHOD.has(m[1])) out.push({ name: m[1], kind: "method", start: i + 1, end: braceEnd(lines, i) + 1, signature: line.trim().replace(/\s*\{\s*$/, "").slice(0, 160) });
    }
  });
  return out;
}

/** The source of one symbol, numbered, or null when the file does not define it. */
export function readSymbol(path: string, text: string, name: string): { entry: SymbolEntry; source: string } | null {
  const lines = text.split("\n");
  const entry = findSymbol(outline(path, text), name);
  if (!entry) return null;
  // Include a doc comment right above the declaration.
  const start = docStart(lines, entry);
  const source = lines.slice(start, entry.end).map((l, i) => `${String(start + i + 1).padStart(4)}  ${l}`).join("\n");
  return { entry, source };
}

/** The entry a name refers to: "Class.method" picks the method inside that class; a bare name is the first with it. */
export function findSymbol(entries: SymbolEntry[], name: string): SymbolEntry | undefined {
  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    const owner = entries.find((e) => e.kind === "class" && e.name === name.slice(0, dot));
    const inside = owner && entries.find((e) => e !== owner && e.name === name.slice(dot + 1) && e.start > owner.start && e.end <= owner.end);
    if (inside) return inside;
  }
  return entries.find((e) => e.name === name);
}

/** 0-based line where the doc comment right above a declaration starts (the declaration's own line when there is none). */
function docStart(lines: string[], entry: SymbolEntry): number {
  let start = entry.start - 1;
  while (start > 0 && /^\s*(\*|\/\*\*|\/\/|#)/.test(lines[start - 1])) start--;
  return start;
}

/**
 * Replace a symbol body in file text; returns new file contents or an error message. read_symbol shows the doc
 * comment above a symbol: a new body that opens with a comment replaces that comment too, instead of doubling it.
 */
export function replaceSymbolBody(
  filePath: string,
  text: string,
  name: string,
  newBody: string,
): { ok: true; text: string } | { ok: false; error: string } {
  const entry = findSymbol(outline(filePath, text), name);
  if (!entry) return { ok: false, error: `No symbol ${name} in ${filePath}. Use outline first.` };
  const lines = text.split("\n");
  const opensWithComment = /^\s*(\/\*|\/\/|#(?!!))/.test(newBody.replace(/\r\n/g, "\n").split("\n").find((l) => l.trim()) ?? "");
  const before = lines.slice(0, opensWithComment ? docStart(lines, entry) : entry.start - 1);
  const after = lines.slice(entry.end);
  const bodyLines = newBody.replace(/\r\n/g, "\n").split("\n");
  const merged = [...before, ...bodyLines, ...after].join("\n");
  return { ok: true, text: merged };
}

/** "  12-40  function todayTasks(store, session, now)" lines for an outline. */
export function formatOutline(path: string, entries: SymbolEntry[], totalLines: number): string {
  if (!entries.length) return `${path} (${totalLines} lines): no functions or classes found. Read it with read_file and a line range.`;
  return `${path} (${totalLines} lines)\n` + entries.map((e) => `${String(e.start).padStart(5)}-${String(e.end).padEnd(5)} ${e.kind === "method" ? "  " : ""}${e.signature}`).join("\n");
}
