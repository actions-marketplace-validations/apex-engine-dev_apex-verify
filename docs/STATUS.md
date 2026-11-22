# Status

What is tested and what is not, use case by use case: [USE-CASES.md](USE-CASES.md).

Honest state of the project. Updated with every release.

| Part | State |
|---|---|
| `reallydone verify` (the product) | Built and tested (unit tests with a fake model, real temporary git repositories). Measured on 199 real AI-written changes with hidden-test labels; numbers and caveats in the README. Preliminary: tens of tasks, Gemini models only. |
| Claude Code plugin | Stop hook, skill and MCP tool; the manifests pass `claude plugin validate`. The hook is tested with real hook input; not yet tested by many people. |
| Codex / Cursor / Gemini | Documented hook and MCP configuration (docs/INTEGRATIONS.md); not tested end to end by the maintainer. |
| GitHub Action | Written (`action.yml`); fork pull requests run without a model by design. Needs real-world trials on pull requests from other people. |
| Engine (`reallydone-engine`) | Extracted from Apex Capsule IDE, a separate commercial product that depends on it. Tests green on Node 20 and 22. |
| Languages | node:test and pytest checks; your own `--test` command for anything else. |
| Sandbox | macOS Seatbelt and Linux bubblewrap, both tested in CI (best effort, not a security boundary); a container recipe tested in CI. Windows: not supported natively (WSL2 or the container). |
| Install | A 48 KB file attached to every release (`npx --yes https://github.com/apex-engine-dev/apex-done-checker/releases/latest/download/reallydone.tgz verify ...`), or clone and build. Not published to npm, and does not need to be. |
| Licence | Apache-2.0; trademark policy in TRADEMARKS.md. |
| Maintainers | One. A second is the most useful contribution of all. |
