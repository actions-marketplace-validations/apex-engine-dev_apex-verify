
const CODE = /\.(m?[jt]sx?|cjs|py|go|rs|java|kt|rb|php|cs|swift|scala|vue|svelte)$/i;

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

