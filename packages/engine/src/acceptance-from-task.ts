/** Turn user text into short acceptance lines for task-state: the request's own lines that state an endpoint or a rule. */
export function acceptanceFromTask(task: string): string[] {
  const out: string[] = [];
  const lines = task.replace(/\r/g, "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^(GET|POST|PUT|PATCH|DELETE)\s+\/\S+/i.test(line)) out.push(line.slice(0, 240));
    if (/\b(401|403|must|should|sort(?:ed)?|time\s*zone|overdue|priority|sign-?in|valid session)\b/i.test(line)) {
      out.push(line.replace(/\s+/g, " ").slice(0, 240));
    }
  }
  if (!out.length && task.trim()) out.push(task.replace(/\s+/g, " ").slice(0, 320));
  return [...new Set(out)].slice(0, 12);
}
