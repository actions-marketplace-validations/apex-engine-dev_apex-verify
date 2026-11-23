/**
 * A diff file comes from outside (an AI agent, a pull request author), and applying it writes files. Before anything is
 * applied, every path it names must stay inside the scratch copy: no `..` segment, no absolute or drive path, no NUL,
 * and no symlink created by the diff (a link could point out of the copy and a later hunk would write through it).
 */
export class UnsafeDiffError extends Error {}

const stripPrefix = (p: string) => p.replace(/^"|"$/g, "").replace(/\t.*$/, "");
export function diffPaths(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    let m: RegExpExecArray | null;
    if ((m = /^diff --git (.+)$/.exec(line))) { for (const part of m[1]!.split(/ (?=[ab]\/)/)) out.push(stripPrefix(part)); }
    else if ((m = /^(?:---|\+\+\+) (.+)$/.exec(line))) out.push(stripPrefix(m[1]!));
    else if ((m = /^(?:rename|copy) (?:from|to) (.+)$/.exec(line))) out.push(stripPrefix(m[1]!));
  }
  return out;
}

export function assertSafeDiff(text: string): void {
  if (text.includes("\0")) throw new UnsafeDiffError("the diff contains a NUL byte");
  for (const p of diffPaths(text)) {
    if (p === "/dev/null") continue;
    const q = p.replace(/\\/g, "/");
    if (q.startsWith("/") || /^[A-Za-z]:/.test(q) || q.startsWith("~")) throw new UnsafeDiffError(`the diff names an absolute path (${p}); refusing to apply it`);
    if (q.split("/").some((seg) => seg === "..")) throw new UnsafeDiffError(`the diff names a path outside the project (${p}); refusing to apply it`);
  }
  if (/^(?:new file mode|new mode|old mode|deleted file mode|index [0-9a-f.]+\.\.[0-9a-f.]+) 120000\b/m.test(text) || /^(?:new file mode|new mode) 120000/m.test(text) || /\b120000$/m.test(text.split("\n").filter((l) => /^(?:index |new file mode|new mode)/.test(l)).join("\n")))
    throw new UnsafeDiffError("the diff creates a symbolic link; refusing to apply it");
}
