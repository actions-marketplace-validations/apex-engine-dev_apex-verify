# Status

What is tested and what is not, use case by use case: [USE-CASES.md](USE-CASES.md).

Honest state of the project. Updated with every release.

| Part | State |
|---|---|
| `apex verify` (the product) | Built and tested (unit tests with a fake model, real temporary git repositories). Measured on 308 AI-written changes (108 to 17 small projects, 200 to 23 real open-source libraries) with hidden-test labels; numbers and caveats in the README. Preliminary: Gemini models wrote every change. |
| Claude Code plugin | Stop hook, skill and MCP tool; the manifests pass `claude plugin validate`. The hook was run in a real Claude Code session and is tested with real hook input; not yet used by many people. |
| Gemini CLI | `AfterAgent` hook run in a real session (a wrong change was blocked, the agent fixed it). |
| Codex / Cursor | Hook configuration written to their documented formats and tested with synthetic input; not run inside the apps (docs/INTEGRATIONS.md). |
| GitHub Action | Tested on real pull requests and runs on this repository's own; fork pull requests run without a model by design. Needs trials on pull requests from other people. |
| Engine (`apex-verify-engine`) | The verification engine `apex verify` uses; it also contains code from the larger project it was extracted from, which `verify` does not use. Tests green on Node 20 and 22. |
| Languages | Checks are written for node:test, pytest, Jest, Vitest, `cargo test` and `go test`; your own `--test` command for anything else. |
| Sandbox | macOS Seatbelt, Linux bubblewrap and Windows AppContainer, all tested in CI on real runners (best effort, not a security boundary); a container recipe tested in CI. |
| Install | A about 60 KB file attached to every release (`npx --yes https://github.com/apex-engine-dev/apex-verify/releases/latest/download/apex-verify.tgz verify ...`), or clone and build. Not published to npm, and does not need to be. |
| Licence | Apache-2.0; trademark policy in TRADEMARKS.md. |
| Maintainers | One. A second is the most useful contribution of all. |
