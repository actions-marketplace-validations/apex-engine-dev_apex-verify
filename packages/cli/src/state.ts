import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Where Apex verify keeps its own files (cached checks, the stop hook's state): a per-user folder (mode 700) that is NOT
 * one of the folders the test sandbox lets tests write to, so code under test cannot plant a cached check or forge a
 * hook verdict. Files are written atomically with mode 600 and never through a symlink.
 */
export const stateDir = (): string => process.env.APEX_STATE_DIR || path.join(os.homedir(), ".apex-verify");

export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { if (!fs.lstatSync(dir).isSymbolicLink()) fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
}

export function writePrivateFile(file: string, content: string): void {
  ensurePrivateDir(path.dirname(file));
  try { if (fs.lstatSync(file).isSymbolicLink()) fs.unlinkSync(file); } catch { /* does not exist */ }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, { flag: "wx", mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Reads a file only if it is a regular file (not a symlink to somewhere else). */
export function readRegularFile(file: string): string | null {
  try { const st = fs.lstatSync(file); return st.isFile() ? fs.readFileSync(file, "utf8") : null; } catch { return null; }
}
