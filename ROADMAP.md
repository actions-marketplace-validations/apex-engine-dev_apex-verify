# Roadmap

No dates and no promises. Open an issue before starting. Everything here serves one claim: **ReallyDone tells you, with proof, whether an AI's change is really done**, and we publish how often it is right.

## Now
- **Measure the gate** on far more tasks: how many wrong changes it catches, how many correct ones it wrongly blocks, per language, with significance. (Today's number is in the README and is preliminary: tens of tasks, one model family.)
- **Make check-writing reliable**: it must produce usable checks for nearly every task, and say `unknown` honestly when it cannot.
- **More languages and test runners**: Jest/Vitest, Go, Rust, Java, C#, Ruby (today: node:test and pytest, plus whatever your own `--test` command runs).
- **The default gate measured with a different-vendor checker** (done once for single check sets; the default pipeline with the second look still uses Gemini).

## Next
- **Two independent checkers that must both object** (measured: 60% of wrong changes blocked, 2% false alarms; `benchmark/results/second-vendor`): make it an option, then the default when two keys are present.
- **A patch judge** as a second signal next to the checks (a model reads the change against the task).
- **Mutation-checked checks**: a check that survives deliberately broken versions of the code is a check worth trusting.
- **Linux sandbox** for generated checks (bubblewrap or a container recipe), and **Windows** support.
- **GitHub App** (so fork pull requests can get model checks without exposing secrets).
- A public **"break the verifier" challenge** and scoreboard.

## Not planned
Local-model support in this repository (cloud models only), a hosted service run by the maintainers inside this repository, replacing your coding agent, the agent runner and per-model calibration that existed in earlier versions (removed; see `docs/research/WEAK-MODELS.md`).
