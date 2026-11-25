import fs from "node:fs/promises";
import path from "node:path";
import type { ModelClient } from "apex-verify-engine";

/**
 * A second look at a test that passed before and fails now. Sometimes the test asserts exactly the old behaviour the task
 * asks to change ("'.example.com' must throw" when the task says leading-dot domains must be accepted): then the change is
 * doing what was asked and the test is out of date. The checker sees the task, the failure output and the test source,
 * never the change, and must quote the sentence of the task that contradicts each failing test. Anything less stays a
 * regression.
 */
export interface OutdatedInput { client: ModelClient; model: string; task: string; origDir: string; failingNames: string[]; failureOutput: string; signal?: AbortSignal }

const msg = (role: "system" | "user", content: string) => ({ id: role, role, content, createdAt: new Date(0).toISOString() });

/** Test files of the original project that mention a failing test's name (at most 3 files, 6 KB each). */
async function testSources(dir: string, names: string[]): Promise<string> {
  const found: string[] = [];
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > 4 || found.length >= 3) return;
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (/\.(m|c)?[jt]sx?$|\.py$|\.go$|\.rs$/.test(e.name) && /test|spec/i.test(p.slice(dir.length))) {
        const t = await fs.readFile(p, "utf8").catch(() => "");
        if (names.some((n) => n.length > 3 && t.includes(n.replace(/^.*?\s>\s/, "")))) found.push(`--- ${path.relative(dir, p).split(path.sep).join("/")}\n${t.slice(0, 6000)}`);
      }
      if (found.length >= 3) return;
    }
  };
  await walk(dir, 0);
  return found.join("\n\n");
}

export async function outdatedTests(o: OutdatedInput): Promise<{ outdated: boolean; why: string; quote: string } | null> {
  const src = await testSources(o.origDir, o.failingNames);
  let text = "";
  for await (const ev of o.client.stream({ messages: [
    msg("system", "You decide whether failing tests are out of date. You are strict: when in doubt, they are not. Answer in JSON only."),
    msg("user", `<task>\n${o.task.slice(0, 3000)}\n</task>\n\nA change was made for the task above. These tests of the project passed before the change and fail after it:\n${o.failingNames.slice(0, 8).map((n) => `- ${n}`).join("\n")}\n\nFailure output:\n${o.failureOutput.slice(0, 2500)}\n\n${src ? `Test source (before the change):\n${src}` : "(test source not found)"}\n\nIs EVERY failing test asserting the old behaviour that the task explicitly asks to change, so that any correct solution of the task must make it fail? Only if the task text itself states the new behaviour that contradicts the assertion. A test of something the task does not mention, or a test the task leaves open, is not out of date.\nAnswer {"outdated": true|false, "quote": "the exact sentence of the task that contradicts the failing assertions, or empty", "why": "one sentence"}.`),
  ], tools: [], model: o.model, temperature: 0, maxTokens: 1500, signal: o.signal, purpose: "outdated-tests" })) {
    if (ev.type === "text-delta") text += ev.text;
    if (ev.type === "error") return null;
  }
  try {
    const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    const quote = String(j.quote ?? "").trim();
    // The quote must really be in the task: the judge cannot invent the sentence that excuses the failure.
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[‘’“”]/g, "'").trim();
    const real = quote.length >= 12 && norm(o.task).includes(norm(quote).replace(/^["']|["']$/g, ""));
    return { outdated: j.outdated === true && real, why: String(j.why ?? "").slice(0, 300), quote };
  } catch { return null; }
}
