import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * The project the engine reads and the place a chosen change is written. Paths are relative to the project root with
 * forward slashes. The default is the node file system under a root folder, which behaves as the engine always did.
 *
 * A host passes its own to add protections (the Apex app passes a scoped workspace that refuses writes into shared
 * vendor code and `.apex`). Scope: this covers the engine's own reads of the project (file list, file bodies,
 * the `before` text of a change) and the final write. The code graph, the scoped-context reader, the scratch copies
 * the tests run in, and the test runner itself still need a real folder at `root`; they read it directly.
 */
export interface Workspace {
  /** The file's text, or null when it does not exist or cannot be read. */
  read(rel: string): Promise<string | null>;
  /** Write a file (creating folders). */
  write(rel: string, content: string): Promise<void>;
  /** Every file under `rel` (default: the root), as relative paths, skipping node_modules, .git, .apex, dist and dot-folders. */
  list(rel?: string): Promise<string[]>;
  /** True when `rel` is an existing file (not a folder). */
  exists(rel: string): Promise<boolean>;
  /** Size in bytes, when known (used only to decide whether a project fits a prompt whole). */
  size?(rel: string): Promise<number>;
}

const SKIP = new Set(["node_modules", ".git", ".apex", "dist"]);

/** The node file system under `root`: the default workspace. */
export function fsWorkspace(root: string): Workspace {
  const list = async (rel = ""): Promise<string[]> => {
    const out: string[] = [];
    for (const d of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
      if (SKIP.has(d.name) || d.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) out.push(...(await list(r)));
      else out.push(r);
    }
    return out;
  };
  return {
    read: (rel) => fs.readFile(path.join(root, rel), "utf8").then((t) => t, () => null),
    write: async (rel, content) => { const abs = path.join(root, rel); await fs.mkdir(path.dirname(abs), { recursive: true }); await fs.writeFile(abs, content); },
    list,
    exists: (rel) => fs.stat(path.join(root, rel)).then((s) => s.isFile(), () => false),
    size: (rel) => fs.stat(path.join(root, rel)).then((s) => s.size, () => 0),
  };
}

/** Every file of the project (what `listFiles` has always returned). */
export async function listFiles(root: string, rel = ""): Promise<string[]> {
  return fsWorkspace(root).list(rel);
}

/** TaskPackProvider: an optional source of a "task pack" (project files and a text block the request points at). */
export interface TaskPack { text: string; packFiles: string[] }
export type TaskPackProvider = (root: string, task: string, hidden: (rel: string) => boolean, budgetChars: number) => Promise<TaskPack>;

let defaultTaskPack: TaskPackProvider | undefined;
/** The provider used when a call passes none. A host registers its own once; by default there is none (an empty pack). */
export function registerTaskPack(p: TaskPackProvider | undefined): void { defaultTaskPack = p; }
export function taskPackProvider(explicit?: TaskPackProvider): TaskPackProvider {
  const p = explicit ?? defaultTaskPack;
  return p ?? (async () => ({ text: "", packFiles: [] }));
}
