# Roadmap

No dates and no promises. Open an issue before starting. Everything here serves one claim: **Apex verify tells you, with proof, whether an AI's change is really done**, and we publish how often it is right.

## Now
- **Cut the remaining checker false alarms on real libraries** (issue #20): about 4 in 100 good changes are wrongly stopped after a hand audit; find out why the generated checks sometimes contradict the task or break, and fix it without losing the catch rate.
- **Measure the gate on more tasks and harder bugs**, per language, with significance. Today: 200 changes on 23 real libraries plus 108 on 17 small projects, one model family wrote the changes.
- **More languages and test runners**: Java, C#, Ruby, Swift (today: node:test, pytest, Jest, Vitest, `cargo test`, `go test`, plus whatever your own `--test` command runs).
- **Run the Codex and Cursor hooks inside the real apps** (written to their documented formats, not yet run there).

## Next
- **A patch judge** as a second signal next to the checks (a model reads the change against the task).
- **Mutation-checked checks**: a check that survives deliberately broken versions of the code is a check worth trusting.
- **Keyless signing in CI** for reports, and stronger isolation (today the sandboxes are best effort).
- **GitHub App** (so fork pull requests can get model checks without exposing secrets).
- A public **"break the verifier" challenge** and scoreboard.

## Not planned
Local-model support in this repository (cloud models only), a hosted service run by the maintainers inside this repository, replacing your coding agent, the agent runner and per-model calibration that existed in earlier versions (removed; see `docs/research/WEAK-MODELS.md`).
