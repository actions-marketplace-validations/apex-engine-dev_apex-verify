# What works, and how we know

Every use case the README claims, how it is tested, and its honest status. If a row says "not tested", we have not proven it and the README does not promise it.

| Use case | Status | How it is tested |
|---|---|---|
| Verify an AI's uncommitted change in a git repository (`reallydone verify "<task>"`) | **Tested in CI** | `packages/cli/src/e2e.test.ts`: ready, not ready, unknown, through the real command line against a fake model server |
| Verify a diff file, with no git repository | **Tested in CI** | `e2e.test.ts` (diff mode, project untouched) |
| Output as text, JSON, Markdown (PR comment), SARIF, files in one run | **Tested in CI** | `e2e.test.ts`, `verify.test.ts` |
| Deterministic mode without a key (`--no-model`): your tests, type check, cheating scan | **Tested in CI** | `e2e.test.ts`, `cheats.test.ts`, the `benchmark-smoke` job |
| Cheating scan: deleted, skipped, focused tests, a test script that cannot fail | **Tested in CI** and measured | `cheats.test.ts`; blocks 8% of wrong changes on its own (`benchmark/results/verify-gate-round1`) |
| Type-check regressions (a dangling import with green tests) | **Tested in CI** | `verify.test.ts` |
| Independent model writes the checks, proven to fail on the old code | **Tested in CI** (with a fake model) and **measured** (real models) | `e2e.test.ts`, `verify.test.ts`; numbers in `benchmark/results/` |
| Reuse of checks while an agent retries | **Tested in CI** | `e2e.test.ts` (second run makes no model call) |
| Claude Code stop hook (blocks "done", at most 3 times, silent when nothing changed, warn mode) | Hook protocol **tested in CI**; plugin manifests validated with `claude plugin validate`; **not yet run inside a live Claude Code session** | `e2e.test.ts` (real hook input on stdin, block JSON out) |
| MCP server (`verify_change`) | Protocol **tested in CI**; **not tested with a real MCP client** | `e2e.test.ts` (initialize, tools/list, tools/call over stdio) |
| GitHub Action: comment updated in place, job summary, fail-on policy, fork PRs without a model | **Tested on real pull requests** (and runs on every PR to this repository) | the `ReallyDone verify` workflow; two throwaway PRs found and fixed one bug |
| Codex CLI, Gemini CLI, Cursor hooks and MCP | **Documented, not tested** | `docs/INTEGRATIONS.md` has the configuration; please try one and tell us |
| Install with `npx --yes https://github.com/apex-engine-dev/apex-done-checker/releases/latest/download/reallydone.tgz` | **Tested by hand** from a clean folder; the bundled file is used by CI | run the commands in the README |
| Languages: your tests run for what is detected (npm/node, pytest, go, cargo, make) or `--test "<cmd>"` | Node and Python **tested**; Go, Rust, others **detected but not tested by us** | `engine/src/runner-detect.test.ts`, `test-runner.test.ts` |
| Checks *written* by the model | **node:test and pytest only**; other stacks give `unknown`, never a wrong `ready` | `proof-gate.ts`; Jest/Vitest, Go, Rust are open issues |
| Sandbox: macOS Seatbelt | **Tested in CI** (macOS job) | `engine` tests |
| Sandbox: Linux bubblewrap | **Tested in CI** (the `linux-sandbox` job must pass, it is not skipped) | `sandbox-linux.test.ts`: write outside the copy denied, external network denied, localhost allowed |
| Sandbox: container recipe | **Tested in CI** | the `container` job |
| Sandbox: Windows | **Not supported.** Use WSL2 (Linux sandbox) or the container | Windows is an open issue |
| How often the gate is right | **Measured**, preliminary | `benchmark/` (rerun with `node benchmark/run-gate.mjs`) |
