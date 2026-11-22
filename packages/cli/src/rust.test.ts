import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import type { ModelClient, ModelEvent } from "apex-verify-engine";
import { verify } from "./verify.js";

/** A real Rust crate: the checks are an integration test run by `cargo test`. Skipped where cargo is not installed. */
const skip = spawnSync("cargo", ["--version"]).status !== 0;
const TASK = "slugify should replace spaces with dashes and lower-case the text";
const git = (d: string, ...a: string[]) => execFileSync("git", ["-C", d, ...a], { stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const write = (d: string, f: string, c: string) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); };
const CHECKS = "```rust\nuse slug_demo::slugify;\n#[test]\nfn replaces_spaces_with_dashes() { assert_eq!(slugify(\"Hello Big World\"), \"hello-big-world\"); }\n#[test]\nfn lower_cases() { assert_eq!(slugify(\"ABC\"), \"abc\"); }\n```";
const model: ModelClient = { async *stream(req: any): AsyncIterable<ModelEvent> {
  const system = String(req.messages?.[0]?.content ?? "");
  yield { type: "text-delta", text: system.startsWith("You settle") ? "CODE\nthe change is wrong" : CHECKS } as ModelEvent;
  yield { type: "done" } as ModelEvent;
} };
const lib = (body: string) => `pub fn slugify(s: &str) -> String { ${body} }\n#[cfg(test)]\nmod tests { use super::*; #[test] fn lower() { assert_eq!(slugify("A"), "a"); } }\n`;

test("rust: a correct change is READY, a wrong one NOT READY with expected and actual", { skip, timeout: 600_000 }, async () => {
  process.env.APEX_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "apex-rs-cache-"));
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "apex-rust-"));
  write(d, "Cargo.toml", "[package]\nname = \"slug-demo\"\nversion = \"0.1.0\"\nedition = \"2021\"\n");
  write(d, "src/lib.rs", lib("s.to_lowercase()"));
  write(d, ".gitignore", "target\n");
  git(d, "init", "-q"); git(d, "add", "-A"); git(d, "commit", "-q", "-m", "init");
  write(d, "src/lib.rs", lib("s.to_lowercase().split_whitespace().collect::<Vec<_>>().join(\"-\")"));
  const good = await verify({ dir: d, task: TASK, checker: { client: model, model: "m" }, cache: false, timeoutSec: 240 });
  assert.equal(good.verdict, "ready", JSON.stringify(good.reasons) + good.warnings.join("|"));
  assert.equal(good.checks.failedOnOldCode, true);
  write(d, "src/lib.rs", lib("s.to_lowercase().replace(' ', \"_\")"));
  const bad = await verify({ dir: d, task: TASK, checker: { client: model, model: "m" }, cache: false, timeoutSec: 240, secondLook: false });
  assert.equal(bad.verdict, "not_ready", JSON.stringify(bad.reasons));
  assert.ok(bad.checks.failedChecks.some((c) => /hello-big-world/.test(c.expected ?? "") || /hello_big_world/.test(c.actual ?? "")), JSON.stringify(bad.checks.failedChecks));
});
