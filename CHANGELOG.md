# Changelog

## 0.2.2 (2026-11-23)
- The Action's Marketplace name is now "Apex verify: AI change checker" (the plain name is taken) and its description is shorter, so it can be listed on the GitHub Marketplace. No code changes.

## 0.2.1 (2026-11-23)
Security and robustness fixes from a full code review (four independent reviewers; every finding reproduced before it was fixed, each fix has a test).
- **A malicious `--diff` could write outside the scratch copy** (for example into `~/.zshrc`) before any sandbox ran. Diff paths are now checked (no `..`, absolute paths, drive letters or symlink creation) and `--unsafe-paths` is gone.
- **Planted or forged cached checks**: the cache and the hook's state moved to `~/.apex-verify/` (mode 700, not writable by the test sandbox), cached drafts are shape-checked and the command to run is never taken from the cache.
- **Secrets**: git-ignored files are no longer part of the change, secret-looking files are never offered to the checker, and key- and token-shaped strings are redacted from everything sent to a model. The type check now runs in the sandbox with the scrubbed environment (it used to see every key).
- **Signed reports**: the signature covers the whole report, and `--check-report` now requires the public key you trust (a forged report signed with someone else's key used to pass).
- **Stop hook**: file names with spaces or accents no longer hide changes from the fingerprint; the 3-block limit now really holds per session; the state file is private and never written through a symlink.
- **GitHub Action**: a crash or setup error now fails the job by default (it used to pass), a task starting with `--` is passed safely, a shallow checkout deepens to find the base, and only the bot's own comment is updated.
- **Engine**: a quadratic regex that could stall on blank-line output; a repository's `.gitattributes export-ignore` can no longer hide tests from the comparison; source folders named `build`, `target` or `coverage` below the root are handled; symlinks that lead out of the project are not copied; TAP `# SKIP`/`# TODO`, pytest ids with spaces, `=== CONT` and UTF-8 chunk boundaries are parsed correctly; the cheat scan no longer flags `RegExp.test(` or `cursor.skip(`, and recognises more test files; the sandbox hides more credential folders (`.claude`, `.codex`, `.gemini`, cargo credentials, shell history).
- **CLI**: `--flag=value` keeps everything after the first `=`, unknown options are rejected, a bare `--` starts the task text, model calls time out (`APEX_MODEL_TIMEOUT_SEC`, default 300 s), Ctrl-C cleans up, the MCP server answers malformed input with JSON-RPC errors, a READY no longer says "the tests pass" when some already failed, markdown reports escape untrusted text, and the Claude Code plugin is pinned to a release.

## 0.2.0 (2026-11-23)
- `--badge-out badge.svg` writes a static SVG badge (idea from the first outside pull request, #17 by DeviousCardi). A hand audit of the real-library false alarms: 6 of the 10 are changes that really miss something the task says, so the checker's mistake rate there is about 4%, not 11% (`benchmark/results/real-projects`).
- **Windows sandbox** (AppContainer; no network, writes only in the scratch copy), tested in CI. **Fixes found by running Apex verify on a real large project:** the original copy now links `node_modules` like the working copy (the baseline test run could not start), and a baseline whose tests could not run is no longer used to call failures new. **Benchmark:** 18 more real-library tasks (200 real-project changes in all): the gate blocks 80% of wrong changes there but also wrongly blocks 11% of right ones.
- **`--lock-tests`** (an agent cannot edit or delete its way to green), **signed reports** (`--sign-key`, `--gen-key`, `--check-report`), Go checks (tested on a real Go module and with a real model), and the full-pipeline cross-company measurement, which withdraws the earlier "two checkers that both object: 60%" claim (`benchmark/results/cross-vendor-full-set`).
- **Checks for Jest, Vitest (TypeScript too) and Rust** (`cargo test`), run by the project's own framework. Windows added to CI. Gemini CLI `AfterAgent` hook tested in a real session.
- **`--second-model`** (two checkers must both object), **`--fresh-inputs`**, and a **badge** (`--badge-out`, Action input `badge`). Measured: same-company second checker and fresh inputs did not improve results, so neither is default (`docs/EXPERIMENTS.md`).
- **Name: Apex verify** (`apex verify`). It was briefly called ReallyDone while we looked for a name; the repository is `apex-verify`.
- **Focus.** The repository is now `apex verify` and what measures it. Removed: the agent runner (`apex-agent`), model calibration and shared profiles, the uplift leaderboard scripts and the benchmark harness (`apex-bench`). The research results are kept in `docs/research/`.
- **Linux sandbox**: bubblewrap, tested in CI (write outside the copy denied, external network denied, localhost allowed). The verdict says which sandbox ran.
- **End-to-end tests** for every claimed use case through the real command line (`e2e.test.ts`), `docs/USE-CASES.md`, and a reproducible benchmark (`benchmark/run-gate.mjs`, 154 labelled changes).
- Second-vendor measurement (Claude as the checker) and the two-checkers-must-agree finding (`benchmark/results/second-vendor`).
- **New: `apex verify`.** Any agent's change in, `ready` / `not ready` / `unknown` out, with proof. An independent model writes checks from your task, shown to fail on the old code and run on the new, next to your tests and a cheating scan (deleted, skipped, focused tests; a test script that cannot fail). Output: text, JSON, Markdown (PR comment), SARIF. Exit codes 0 / 1 / 3.
- Linux: container recipe for running generated checks isolated (`docker/Dockerfile`, docs/SANDBOX.md), tested in CI. Demo GIF, social card, `docs/RELATED-WORK.md`.
- Type check: when the project has a `typecheck` script (or `tsc` and a tsconfig), errors the change introduced make it `not ready`.
- Cheating scan: warns when a task's own example value is special-cased in added code. (A "public function removed" warning was built and dropped: it fired on 10% of correct changes and on none of the wrong ones.)
- **New: Claude Code plugin** (Stop hook that blocks "done" until the change is ready, skill, MCP tool), **MCP server** (`verify --mcp`), **GitHub Action** (`action.yml`).
- **Licence: Apache-2.0** (briefly FSL-1.1 on 2026-11-22, before that PolyForm with a CLA; earlier commits were Apache-2.0 too). DCO sign-off, trademark policy (TRADEMARKS.md). A permissive licence for the code developers install, a hosted paid tier kept separate.
- Checks-writing no longer truncates for reasoning models (the output limit was cut off at about 400 characters).
- The repository is cloud-models-only; local-model paths were removed from the public build.
- Uplift study results added to the README (cheap model with and without Apex verify; not significant yet).

## 0.1.0
Earlier prototype: the engine, an agent runner and a benchmark harness (since removed).
