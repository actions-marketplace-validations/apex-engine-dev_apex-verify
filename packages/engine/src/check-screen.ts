/**
 * A rule that keeps Apex's own checks from holding back a correct change, with no model call: a check that scans the
 * project must not find Apex's own generated check file (selfExcludingChecks).
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
    if (fut && /^\s*(?:#[^\n]*\n|"""[\s\S]*?"""\s*|'''[\s\S]*?'''\s*|"[^"\n]*"\s*|'[^'\n]*'\s*)*$/.test(code.slice(0, fut.index))) return code.slice(0, fut.index + fut[0].length) + prelude + code.slice(fut.index + fut[0].length);
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

