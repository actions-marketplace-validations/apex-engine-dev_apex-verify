<h1 align="center">Apex verify</h1>
<p align="center"><b>Your AI said it's done. Is it really done?</b></p>
<p align="center">Catch the AI code changes that pass your tests and are still wrong.</p>
<p align="center">
  <a href="https://github.com/apex-engine-dev/apex-verify/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/apex-engine-dev/apex-verify/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg">
  <a href="https://github.com/apex-engine-dev/apex-verify/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/apex-engine-dev/apex-verify?style=social"></a>
</p>

AI coding agents say "done" when the tests pass. But the tests only check what somebody wrote down. **Apex verify** takes the change an AI made and the task you gave it, has a *different* AI write the missing checks, and tells you `ready`, `not ready` or `unknown`, **with proof**, on a copy of your code, before you merge. Free, Apache-2.0, works with Claude Code, Codex, Cursor, Aider, Copilot or a person.

<p align="center"><img src="docs/assets/demo.gif" alt="Terminal: the project's own test passes, then apex verify says NOT READY and names the failing checks with expected and actual values" width="760"></p>

<p align="center"><b>The tests were green. Apex verify found what they missed.</b></p>

## Try it in 30 seconds

**No key, no project, nothing to install first.** See it catch a wrong change in 5 seconds:

```sh
npx --yes https://github.com/apex-engine-dev/apex-verify/releases/latest/download/apex-verify.tgz verify --demo
```

Then try it on your own project:

You need Node 20+, git, and an API key for the model that writes the checks (use a different, ideally stronger model than your agent).

```sh
export GEMINI_API_KEY=...        # or OPENAI_API_KEY with --provider openai --model <id>
cd your-project                  # a git repo where an AI just made a change
npx --yes https://github.com/apex-engine-dev/apex-verify/releases/latest/download/apex-verify.tgz verify "what you asked the AI to do"
```

It downloads a 48 KB file (about 2 seconds), changes nothing in your project, and prints a verdict. No key? Add `--no-model` to run only your tests and the cheating scan (the verdict is then at most `unknown`).

**More to play with:** the example in this repo, where an AI "fixed" a function and its own test passes:

```sh
git clone https://github.com/apex-engine-dev/apex-verify && cd apex-verify/examples/said-done
npx --yes https://github.com/apex-engine-dev/apex-verify/releases/latest/download/apex-verify.tgz verify "$(cat task.txt)" --dir project --diff agent-change.diff
```

## Why you might want it

- **"The tests passed" is not "it works".** Agents skip, delete or never write the test that mattered. Apex verify writes the missing checks from your task and shows each one can fail on the old code, so a check that proves nothing is thrown away.
- **It stops the agent, not just you.** A Claude Code plugin blocks the agent from saying "done" until the change is ready, and a GitHub Action gives every pull request a verdict (handy against AI-generated pull requests).
- **It says "I don't know" instead of guessing.** `unknown` is a real answer. You never get a silent pass.

## Does it actually work? (in plain words)

We collected AI-written changes to small projects and knew for sure which ones were wrong, because we wrote secret tests that Apex verify never saw. A "wrong" change is one that looks fine and may pass the visible tests but does not do what the task asked.

<p align="center"><img src="docs/assets/results.svg" alt="Out of 100 wrong AI changes, tests plus a cheating scan stop 8, Apex verify stops 52 on the public projects and 65 across all 17 projects" width="720"></p>

- **Your own tests (plus a scan for deleted or skipped tests) stop about 8 of every 100 wrong changes.**
- **Apex verify stops about 65** across all 17 projects (28 of 43 wrong changes), and **52** on the 12 public projects that you can rerun yourself (16 of 31).
- **It wrongly stops about 3 of every 100 good changes** (2 of 65; 1 of 48 on the public projects).
- **On real libraries it is rougher.** On 200 AI-written changes to 23 real open-source libraries (each task a real historical bug fix) it stopped 80 of every 100 wrong changes (tests plus the scan: none) but also wrongly stopped 11 of every 100 good ones, with the false alarms concentrated in a few tasks ([details and limits](benchmark/results/real-projects/README.md)). Fixing that is the next job.
- **It still misses about a third** of the wrong changes on the small projects. It is not a proof of correctness.
- **A checker from another company works about as well**: Claude as the checker stopped 55 of every 100 wrong changes (Gemini 63 on the same changes) with 2 or fewer in 100 false alarms ([details](benchmark/results/cross-vendor-full-set)).
- **Two checkers that must both object did not help** (43%), and neither did two checkers from the same company or telling the checker to avoid the task's own examples ([docs/EXPERIMENTS.md](docs/EXPERIMENTS.md)). An earlier 60% figure for two checkers came from a smaller test and was wrong for the full pipeline. Blocking when *either* objects caught 75% at the same false-alarm rate in one test; that is not a mode yet.

Honest limits: these are small projects, the changes were written by Gemini models, the numbers come from one run each, and the exact percentages could move a lot with more data. Rerun it yourself with `node benchmark/run-gate.mjs`; the data, the method and the caveats are in [benchmark/](benchmark). **Please try to break it**: a `ready` that is wrong, or a `not ready` that is right, is the most useful bug report we can get.

## Use it where you work

| You use | Add Apex verify as | It stops "done"? | Status |
|---|---|---|---|
| **A terminal** | `apex verify "<task>"` | You read the verdict | **Tested in CI** |
| **Pull requests (any agent, or people)** | the GitHub Action: `uses: apex-engine-dev/apex-verify@v1` | **Yes**, as a required check | **Tested on real PRs**; runs on this repo's own PRs |
| **Claude Code** | `/plugin marketplace add apex-engine-dev/apex-verify` then `/plugin install apex-verify@apex` | **Yes**: the Stop hook hands the failing check back and Claude keeps working | **Run in a real Claude Code session** (v2.1): Claude said done on a wrong change, the hook blocked it with the failing checks, and Claude kept being stopped; plugin validated |
| **Any MCP client** | the `verify_change` tool | The agent asks | Protocol tested in CI; not with a real client |
| **Gemini CLI** | an `AfterAgent` hook | **Yes**: it blocked a wrong change, the agent fixed it | **Run in a real Gemini CLI session** (v0.32) |
| **Codex CLI, Cursor** | a Stop hook and/or the MCP tool | Yes / partly | **Written to their documented hook formats; tested with their input shapes, not run inside the apps** ([#8](https://github.com/apex-engine-dev/apex-verify/issues/8)) |

Copy-paste configs: [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md). Exactly what is and is not tested: [docs/USE-CASES.md](docs/USE-CASES.md).

## How it decides

1. **Builds the change on a copy** (your git working copy, a branch, or a diff file). Your project is never touched.
2. **Scans for cheating**: tests deleted, skipped, focused with `.only`, a test script that cannot fail, edits to the agent's own configuration.
3. **Runs your tests** before and after: a test that passed before and fails now is a regression. A type check counts too if you have one.
4. **A different model writes checks from your task**, never from the agent's own tests.
5. **Proves each check can fail**: it runs on the old code first. A check that passes on the old code too proves nothing.
6. **Runs the checks on the new code** and answers `ready`, `not ready` (the failing check, expected vs actual, and a fix hint an agent can read) or `unknown` (not enough to say). **Never a silent pass.**

## What Apex verify will not do

- **It is not a proof of correctness.** It raises the bar. A check can be wrong in both directions; the numbers above are the honest rates.
- **It does not replace review or CI.** It runs next to them and gives a short, evidence-backed verdict.
- **It sends your task and the relevant source files** (about 24 KB at most) to the checker model you configure, and nothing else. No telemetry.
- **It runs checks and tests on your machine**, sandboxed where we can: macOS Seatbelt (best effort) and Linux bubblewrap, both tested in CI, with no network except localhost. **Windows runs (tested in CI) but has no sandbox yet**: use WSL2 or the [container recipe](docs/SANDBOX.md) for code you do not trust.
- **It writes checks for node:test, pytest, Jest, Vitest and Rust (`cargo test`), and Go (`go test`).** For other stacks it still runs your tests and the cheating scan and says `unknown` rather than guessing ([#2](https://github.com/apex-engine-dev/apex-verify/issues/2)).

## What's left

Honest list of what is not done yet, each with an issue you can pick up:

| Not done yet | Issue |
|---|---|
| **File and network isolation on Windows** (it runs there; keys are scrubbed from the environment, files and network are not isolated) | [#9](https://github.com/apex-engine-dev/apex-verify/issues/9) |
| Run the **Codex and Cursor** hooks inside the real apps (Gemini CLI and Claude Code are done) | [#8](https://github.com/apex-engine-dev/apex-verify/issues/8) (good first issue) |
| Measure on **even more real projects**, and cut the false alarms seen there | [#13](https://github.com/apex-engine-dev/apex-verify/issues/13) |
| Locked tests and **signed evidence** (so an agent cannot tamper with its own verdict) | [#7](https://github.com/apex-engine-dev/apex-verify/issues/7) |

## Questions you will have

**Isn't this just CI?** CI runs the tests that exist. The pain is the change nobody wrote a test for, or the test the agent deleted or never ran. Apex verify writes the missing checks, proves they can fail, and flags tampering. Run it *in* CI with the Action.

**What does it cost?** One model call per task to write the checks (reused while an agent retries the same task), plus a short second look when a check fails. Seconds and cents. Your tests run locally.

**What if the checker is wrong?** Then you get `not ready` on a good change or `ready` on a wrong one. We measure both and show them above. The second look turns a suspect check into `unknown`, the agent hook never blocks more than 3 times, and `APEX_MODE=warn` never blocks.

**Why a different model?** A model grading its own work shares its blind spots: in our runs a weak model writing checks for its own change blocked over half of the good changes.

## Help it spread

If Apex verify catches something for you, a ⭐ helps other developers find it, and telling one teammate who uses Claude Code, Codex or Cursor does more than any ad. If it gets something wrong, [tell us](https://github.com/apex-engine-dev/apex-verify/issues/new/choose): we will add your case to the benchmark and credit you.

| You can | Where |
|---|---|
| **Break it**: find a wrong change it calls `ready`, or a good one it blocks | [new issue](https://github.com/apex-engine-dev/apex-verify/issues/new/choose) |
| **Try it on your real project** and tell us if it worked in five minutes | [issue #3](https://github.com/apex-engine-dev/apex-verify/issues/3) |
| **Add a language or test runner** | issues labelled `good first issue` |
| **Be a second maintainer** | [GOVERNANCE.md](GOVERNANCE.md) |

There is currently **one maintainer**; expect replies in days, not hours.

<details>
<summary><b>What is in this repository</b></summary>

- **[`packages/cli`](packages/cli)**: `apex verify`, the stop hook, the MCP server, the output formats.
- **[`packages/engine`](packages/engine)**: the verification engine it uses (writes and runs the checks, runs your tests, the sandbox). It is shared with a separate commercial product, so it contains more than `verify` uses; see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- **[`benchmark/`](benchmark)**: labelled AI-written changes, the 12 public projects, results, and the script that re-measures the gate.
- **`action.yml`, [`integrations/`](integrations), [`.claude-plugin/`](.claude-plugin), [`docker/`](docker)**: the GitHub Action, the Claude Code plugin, the container recipe.
- **[`docs/`](docs)**: [integrations](docs/INTEGRATIONS.md), [what works and how we know](docs/USE-CASES.md), [sandbox](docs/SANDBOX.md), [related work](docs/RELATED-WORK.md), [experiments including failures](docs/EXPERIMENTS.md), and an earlier [research track on weaker models](docs/research/WEAK-MODELS.md).

[Contributing](CONTRIBUTING.md) · [Roadmap](ROADMAP.md) · [Security](SECURITY.md) · [Status](docs/STATUS.md) · [Changelog](CHANGELOG.md)

</details>

## Licence

**Apache-2.0**: use it, modify it, ship it, at work or in your own products. The Apex verify name and logo are trademarks, not part of that grant ([TRADEMARKS.md](TRADEMARKS.md)): you can fork the code, but not present your fork as Apex verify. Contributions use a DCO sign-off (`git commit -s`) and you keep your copyright. We plan a paid hosted tier later; this repository (the CLI, the gate, the hooks, the Action) stays open.
