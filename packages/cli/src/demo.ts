import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelClient, ModelEvent } from "apex-verify-engine";
import { renderText } from "./report.js";
import { verify } from "./verify.js";

/**
 * `apex verify --demo`: a 30-second look at what it does, with no API key and no project of yours. It builds a tiny
 * project, lets a pretend agent "fix" it in a way the project's own test cannot see, and runs the real gate with a
 * built-in checker (the check file below stands in for what a model would write, so nothing is sent anywhere).
 */
const TASK = "slugify() should return a clean URL slug: lowercase letters and digits separated by single dashes. slugify(\"Hello, World!\") should give \"hello-world\".";
const CHECKS = "```js\nconst t = require(\"node:test\"), a = require(\"node:assert\"), { slugify } = require(\"../src/slug.js\");\n" +
  "t(\"drops punctuation, not just commas\", () => a.equal(slugify(\"Hello, World!\"), \"hello-world\"));\n" +
  "t(\"separates words with single dashes\", () => a.equal(slugify(\"a   b\"), \"a-b\"));\n" +
  "t(\"lower-cases\", () => a.equal(slugify(\"ABC\"), \"abc\"));\n```";
const checker: ModelClient = { async *stream(req: any): AsyncIterable<ModelEvent> {
  const system = String(req.messages?.[0]?.content ?? "");
  yield { type: "text-delta", text: system.startsWith("You settle") ? "CODE\nthe change is wrong" : CHECKS } as ModelEvent;
  yield { type: "done" } as ModelEvent;
} };

export async function runDemo(out: (s: string) => void = console.log): Promise<number> {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "apex-demo-"));
  const put = (f: string, c: string) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); };
  const git = (...a: string[]) => execFileSync("git", ["-C", d, ...a], { stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "demo", GIT_AUTHOR_EMAIL: "demo@example.com", GIT_COMMITTER_NAME: "demo", GIT_COMMITTER_EMAIL: "demo@example.com" } });
  try {
    put("package.json", JSON.stringify({ name: "demo", scripts: { test: "node --test" } }));
    put("src/slug.js", "exports.slugify = (s) => String(s).toLowerCase().trim().replace(/\\s+/g, \"-\");\n");
    put("test/slug.test.js", "const t = require(\"node:test\"), a = require(\"node:assert\"), { slugify } = require(\"../src/slug.js\");\nt(\"lower-cases\", () => a.equal(slugify(\"ABC\"), \"abc\"));\nt(\"joins words\", () => a.equal(slugify(\"a b\"), \"a-b\"));\n");
    git("init", "-q"); git("add", "-A"); git("commit", "-q", "-m", "base");
    // The pretend agent's change: it strips the comma from the example in the task and says "done". The "!" is still there.
    put("src/slug.js", "exports.slugify = (s) => String(s).toLowerCase().trim().replace(/,/g, \"\").replace(/\\s+/g, \"-\");\n");
    out("Apex verify demo (no API key, nothing leaves your machine)\n");
    out("A pretend AI agent was asked:\n  " + TASK + "\nIt fixed the comma, said \"done\", and the project's own tests pass. Is it really done?\n");
    const tests = execFileSync("node", ["--test", "--test-reporter=tap"], { cwd: d, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: (({ NODE_TEST_CONTEXT: _c, ...rest }) => rest)(process.env) }).match(/# pass (\d+)/)?.[1];
    out(`Project tests: ${tests} passed. Now Apex verify:\n`);
    const report = await verify({ dir: d, task: TASK, checker: { client: checker, model: "built-in demo checker" }, cache: false, secondLook: false, timeoutSec: 60 });
    out(renderText(report));
    out("\nThat is the point: green tests, wrong change, caught with the expected and actual value.\nOn a real change, a model writes the checks from your task. Try it on your own project:\n  apex verify \"what you asked the AI to do\"    (needs GEMINI_API_KEY, or --no-model for tests and cheating scan only)\nThen tell us how it went: https://github.com/apex-engine-dev/apex-verify/issues/new/choose");
    return report.verdict === "not_ready" ? 0 : 1;
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}
