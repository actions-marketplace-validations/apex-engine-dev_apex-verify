import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Finding the text an edit names, the way a person would: exactly first; then without the line numbers Apex
 * itself shows in front of file lines (models copy them); then ignoring indentation and trailing spaces. A
 * failed exact match otherwise costs a re-read and a second attempt, which on a weaker model is 10-30 seconds.
 */

/** "  12  const a = 1;" -> "const a = 1;" when every line carries the number prefix Apex prints. */
export function stripLineNumbers(text: string): string {
  const lines = text.split("\n");
  const body = lines.filter((l) => l.trim());
  if (!body.length || !body.every((l) => /^\s*\d+ {2}/.test(l) || /^\s*\d+$/.test(l))) return text;
  return lines.map((l) => l.replace(/^\s*\d+( {2}|$)/, "")).join("\n");
}

export type EditMatch =
  | { ok: true; after: string; how: "exact" | "numbers" | "indent" }
  | { ok: false; error: string };

export const MASKED_SECRET_EDIT = "This edit contains a masked secret placeholder; read the file and edit around the secret.";

/** Applies one edit. `all` replaces every exact occurrence; a loose match must be the only one. */
export function applyEdit(before: string, oldText: string, newText: string, all = false): EditMatch {
  // The model saw secrets as «secret:<kind>#<n>» placeholders; writing one back would destroy the real value.
  if (newText.includes("«secret:")) return { ok: false, error: MASKED_SECRET_EDIT };
  for (const [how, o, n] of [["exact", oldText, newText], ["numbers", stripLineNumbers(oldText), stripLineNumbers(newText)]] as const) {
    if (how === "numbers" && o === oldText) continue;
    const count = o ? before.split(o).length - 1 : 0;
    if (count === 1 || (count > 1 && all)) return { ok: true, how, after: all ? before.split(o).join(n) : before.replace(o, () => n) };
    if (count > 1) return { ok: false, error: `old_text appears ${count} times. Include more surrounding lines so it is unique, or set replace_all.` };
  }
  // Same lines apart from indentation and trailing spaces.
  const old = stripLineNumbers(oldText).split("\n");
  while (old.length && !old[old.length - 1].trim()) old.pop();
  while (old.length && !old[0].trim()) old.shift();
  const lines = before.split("\n");
  const want = old.map((l) => l.trim());
  const hits: number[] = [];
  if (want.length) for (let s = 0; s + want.length <= lines.length; s++) if (want.every((w, k) => lines[s + k].trim() === w)) hits.push(s);
  if (hits.length === 1) {
    const s = hits[0];
    // The file's indentation wins: shift the new text by the difference on the first line.
    const indent = (l: string) => /^[ \t]*/.exec(l)![0];
    const fileIndent = indent(lines[s]);
    const givenIndent = indent(old[0]);
    let fresh = stripLineNumbers(newText).split("\n");
    if (fileIndent !== givenIndent && fileIndent.startsWith(givenIndent)) {
      const extra = fileIndent.slice(givenIndent.length);
      fresh = fresh.map((l) => (l.trim() ? extra + l : l));
    }
    return { ok: true, how: "indent", after: [...lines.slice(0, s), ...fresh, ...lines.slice(s + want.length)].join("\n") };
  }
  if (hits.length > 1) return { ok: false, error: `old_text appears ${hits.length} times. Include more surrounding lines so it is unique.` };
  // Not found: show what is really there, so the next attempt needs no re-read.
  const first = want.find((w) => w.length > 3);
  const at = first ? lines.findIndex((l) => l.trim() === first) : -1;
  if (at >= 0) {
    const from = Math.max(0, at - 1);
    const shown = lines.slice(from, Math.min(lines.length, at + Math.max(want.length, 3) + 1)).join("\n");
    return { ok: false, error: `old_text was not found. Its first line is at line ${at + 1}, but the lines after it differ. The file has, exactly:\n${shown}\nCopy old_text from this.` };
  }
  return { ok: false, error: "old_text was not found in the file. Read the file again and copy the exact text." };
}

/** Why a file does not parse, or null. JavaScript (node --check) and JSON; other languages are not checked. */
export async function parseError(file: string, text: string): Promise<string | null> {
  if (/\.json$/i.test(file)) {
    try { JSON.parse(text); return null; } catch (err) { return err instanceof Error ? err.message : String(err); }
  }
  if (!/\.(m?js|cjs)$/i.test(file)) return null;
  const esm = /\.mjs$/i.test(file) || (!/\.cjs$/i.test(file) && /^\s*(import\s|export\s)/m.test(text));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "apex-parse-"));
  const tmp = path.join(dir, esm ? "check.mjs" : "check.cjs");
  try {
    await fs.writeFile(tmp, text);
    await run(process.execPath, ["--check", tmp], { timeout: 10_000 });
    return null;
  } catch (err) {
    const out = String((err as { stderr?: string }).stderr ?? err);
    const line = /check\.[mc]js:(\d+)/.exec(out)?.[1];
    const msg = out.split("\n").find((l) => /Error/.test(l))?.trim() ?? "does not parse";
    return line ? `line ${line}: ${msg}` : msg;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Added to an edit's result when the edit broke a file that parsed before it. Empty when all is well. */
export async function syntaxNote(file: string, before: string | null, after: string): Promise<string> {
  const now = await parseError(file, after);
  if (!now) return "";
  if (before !== null && (await parseError(file, before))) return ""; // it did not parse before either (JSX in .js)
  return `\nBut ${file} no longer parses: ${now}. Fix that now with edit_file before going on.`;
}
