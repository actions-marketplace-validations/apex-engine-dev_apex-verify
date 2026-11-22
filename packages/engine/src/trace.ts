/**
 * Stack traces pasted into a request: Node/JS, Python, Java/Kotlin and Go frames, mapped to the capsule's own files.
 * Library and runtime frames (node_modules, node:internal, site-packages, the JDK) are left out: the bug is almost
 * always in the first frame that is the user's code.
 */
export interface TraceFrame { file: string; line: number; fn?: string }
export interface ParsedTrace { error: string; frames: TraceFrame[] }

const NOT_OURS = /(^|\/)(node_modules|site-packages|dist-packages|\.venv|venv|vendor)\/|^node:|^internal\/|<anonymous>|^(java|javax|jdk|sun|kotlin)\./;

/** A pasted trace in the text, or null. */
export function parseTrace(text: string, projectFiles: string[]): ParsedTrace | null {
  const raw: TraceFrame[] = [];
  // Node:   at fn (/abs/path/src/a.js:12:5)   |   at /abs/path/src/a.js:12:5   |   at async fn (file:///…/a.mjs:3:1)
  // (the function part may hold spaces: "at GET /api/tasks (file.js:11:23)")
  for (const m of text.matchAll(/^\s*at\s+(?:(?:async\s+)?([^()\n]+?)\s+\()?(?:file:\/\/)?([^\s()]+?):(\d+)(?::\d+)?\)?\s*$/gm)) raw.push({ ...(m[1] ? { fn: m[1].trim() } : {}), file: m[2], line: Number(m[3]) });
  // Python:   File "/abs/app/models.py", line 42, in save
  for (const m of text.matchAll(/^\s*File "([^"]+)", line (\d+)(?:, in (\S+))?/gm)) raw.push({ file: m[1], line: Number(m[2]), fn: m[3] });
  // Java/Kotlin:   at com.acme.Foo.bar(Foo.java:42)
  for (const m of text.matchAll(/^\s*at\s+([\w.$<>]+)\(([\w$-]+\.(?:java|kt|scala)):(\d+)\)/gm)) raw.push({ fn: m[1], file: m[2], line: Number(m[3]) });
  // Go:   /abs/path/pkg/handler.go:42 +0x1d
  for (const m of text.matchAll(/^\s*(\S+\.go):(\d+)(?:\s+\+0x[0-9a-f]+)?\s*$/gm)) raw.push({ file: m[1], line: Number(m[2]) });
  if (!raw.length) return null;
  const frames: TraceFrame[] = [];
  for (const f of raw) {
    if (NOT_OURS.test(f.file)) continue;
    const norm = f.file.replace(/\\/g, "/");
    // Absolute paths from another machine: the longest project path the frame ends with.
    let match: string | undefined = projectFiles.filter((p) => norm === p || norm.endsWith("/" + p)).sort((a, b) => b.length - a.length)[0];
    // Java/Kotlin give a bare file name: find it by its package path (com.acme.Foo.bar -> com/acme/Foo.java).
    if (!match && !norm.includes("/")) {
      const pkg = (f.fn ?? "").split(".").slice(0, -2).join("/");
      const named = projectFiles.filter((p) => p.endsWith("/" + norm) || p === norm);
      match = named.find((p) => pkg && p.includes(pkg + "/")) ?? (named.length === 1 ? named[0] : undefined);
    }
    if (match && !frames.some((x) => x.file === match && x.line === f.line)) frames.push({ file: match, line: f.line, ...(f.fn ? { fn: f.fn } : {}) });
  }
  const error = /^\s*((?:[\w.]+(?:Error|Exception|Panic)|panic|Traceback)[^\n]*)/m.exec(text)?.[1]?.trim()
    ?? /^\s*(\w*Error: [^\n]+)/m.exec(text)?.[1]?.trim() ?? "";
  return { error, frames };
}

/** True when the request carries a stack trace (two frame lines, or an error line and one frame). */
export function hasTrace(text: string): boolean {
  const frames = (text.match(/^\s*at\s+\S.*:\d+(:\d+)?\)?\s*$|^\s*File "[^"]+", line \d+|^\s*\S+\.go:\d+/gm) ?? []).length;
  const errorLine = /(^|\n)\s*(\w+(Error|Exception)\b|Traceback \(most recent call last\)|panic:)/.test(text);
  return frames >= 2 || (frames >= 1 && errorLine);
}

/** The trace as a note for the model: the error and the project's frames, innermost first. */
export function traceNote(t: ParsedTrace): string {
  if (!t.frames.length) return "";
  return `The stack trace points into this project at (innermost first):\n${t.frames.slice(0, 8).map((f) => `- ${f.file}:${f.line}${f.fn ? ` in ${f.fn}` : ""}`).join("\n")}${t.error ? `\nThe error: ${t.error}` : ""}\nFind the cause there (the first frame is where it surfaced, not always where it started).`;
}
