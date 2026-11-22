import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import type { ModelClient, ModelEvent } from "apex-verify-engine";
import { verify } from "./verify.js";

/** A real Go module: the checks are a _test.go file run by `go test`. Skipped where go is not installed. */
const skip = spawnSync("go", ["version"]).status !== 0;
const TASK = "slugify should replace spaces with dashes and lower-case the text";
const git = (d: string, ...a: string[]) => execFileSync("git", ["-C", d, ...a], { stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const write = (d: string, f: string, c: string) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); };
const CHECKS = "```go\npackage slug\n\nimport \"testing\"\n\nfunc TestReplacesSpacesWithDashes(t *testing.T) {\n\tif got := Slugify(\"Hello Big World\"); got != \"hello-big-world\" {\n\t\tt.Errorf(\"got %q, want %q\", got, \"hello-big-world\")\n\t}\n}\n\nfunc TestLowerCases(t *testing.T) {\n\tif got := Slugify(\"ABC\"); got != \"abc\" {\n\t\tt.Errorf(\"got %q, want %q\", got, \"abc\")\n\t}\n}\n```";
const model: ModelClient = { async *stream(req: any): AsyncIterable<ModelEvent> {
  const system = String(req.messages?.[0]?.content ?? "");
  yield { type: "text-delta", text: system.startsWith("You settle") ? "CODE\nthe change is wrong" : CHECKS } as ModelEvent;
  yield { type: "done" } as ModelEvent;
} };
const lib = (body: string) => `package slug\n\nimport \"strings\"\n\nvar _ = strings.ToLower\n\nfunc Slugify(s string) string { ${body} }\n`;

test("go: a correct change is READY, a wrong one NOT READY with expected and actual", { skip, timeout: 600_000 }, async () => {
  process.env.APEX_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "apex-go-cache-"));
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "apex-gomod-"));
  write(d, "go.mod", "module example.com/slug\n\ngo 1.21\n");
  write(d, "slug.go", lib("return strings.ToLower(s)"));
  write(d, "slug_test.go", "package slug\n\nimport \"testing\"\n\nfunc TestLower(t *testing.T) { if Slugify(\"A\") != \"a\" { t.Fatal(\"no\") } }\n");
  git(d, "init", "-q"); git(d, "add", "-A"); git(d, "commit", "-q", "-m", "init");
  write(d, "slug.go", lib("return strings.Join(strings.Fields(strings.ToLower(s)), \"-\")"));
  const good = await verify({ dir: d, task: TASK, checker: { client: model, model: "m" }, cache: false, timeoutSec: 240 });
  assert.equal(good.verdict, "ready", JSON.stringify(good.reasons) + good.warnings.join("|"));
  assert.equal(good.checks.failedOnOldCode, true);
  write(d, "slug.go", lib("return strings.ReplaceAll(strings.ToLower(s), \" \", \"_\")"));
  const bad = await verify({ dir: d, task: TASK, checker: { client: model, model: "m" }, cache: false, timeoutSec: 240, secondLook: false });
  assert.equal(bad.verdict, "not_ready", JSON.stringify(bad.reasons));
  assert.ok(bad.checks.failedChecks.some((c) => /hello-big-world/.test(c.expected ?? "") || /hello_big_world/.test(c.actual ?? "")), JSON.stringify(bad.checks.failedChecks));
});
