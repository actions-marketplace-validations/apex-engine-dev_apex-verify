# Related work

Apex verify is not the only project that distrusts "the agent says it's done". This is what we found when we read their code and READMEs (November 2026; star counts and details change, check the repositories). Where another project does something better, we say so.

| Project | What it does | Needs a human-written test suite? | A model in the verdict? | Where it is ahead of Apex verify |
|---|---|---|---|---|
| [OpenHarnX](https://github.com/rupeshpoojary9/OpenHarnX) (Apache-2.0, Python) | Locks the tests first, runs the locked copies in a sandbox, compares per-test results to a baseline, mutates the changed lines, signs the report | Yes (acceptance tests) | No | Tamper-proof execution, signed evidence, mutation |
| [N0 Verify](https://github.com/HmZ9874/n0-verify-ai-code-verification) (Apache-2.0, TypeScript) | Base vs head, a four-way old/new code by old/new tests matrix, mutation of changed lines, hash-verifiable proof packs, SARIF | Yes (evidence) | No | The matrix, proof packs |
| [proofcheck](https://github.com/bhaskargurram-ai/proofcheck) (MIT, Python) | Classifies the PR's own tests as fail-to-pass / pass-to-pass, matches PR claims ("fixes #12", "3x faster") to measured evidence, replays issue reproducers, posts a verdict card; an optional LLM agent writing reproduction tests is off by default | Uses the PR's tests | Optional, off | Claim-versus-evidence matching, a polished PR card |
| [AI Fix Verifier](https://github.com/simplynadaf/ai-fix-verifier) (MIT, Python) | Five deterministic checks on an agent's fix PR: tamper scan, public API intact, no regressions, new test fails on old code, claims vs proven fixes; a hidden suite the agent never sees confirms the fix. Built around one rule: *no model grades the model*. Honest numbers on 8 planted bugs | Yes (hidden suite, per bug) | No | A hard "no model in the verdict" rule, a hidden suite the agent never sees, "public function deleted" detection |
| [Revertgate](https://github.com/Revertgate/revertgate) (proprietary binary) | Reverts the PR's source and reruns tests; blocks when they still pass | Uses the PR's tests | No | The simplest five-minute setup |
| [Qodo Cover](https://github.com/qodo-ai/qodo-cover) (AGPL-3.0, no longer maintained) and [PR-Agent](https://github.com/The-PR-Agent/pr-agent) (MIT) | Test generation for coverage; an LLM review bot that comments | No | Yes (review) | Established, widely used |

## What Apex verify does differently

- **It writes the missing checks.** Every project above either needs a person to write the acceptance or hidden tests, or only reuses the tests that are already in the change. Apex verify has an independent model write checks from the task text and proves they can fail on the old code. That removes the human bottleneck, and it is also the risk: a model-written check can be wrong, so we measure how often (65% of wrong changes blocked, 3% of right ones, in [our first measurement](../benchmark/results/verify-gate-round1/README.md)).
- **It is built for any agent, in the place you already work**: a Claude Code stop hook that blocks "done", an MCP tool, a GitHub Action, a plain command.
- **It publishes how often it is wrong**, in both directions.

## What we take from them, and what we have not done

- *"No model grades the model."* A fair rule. Apex verify's checks are written by a model, but the verdict is computed from running them; the only model call that touches a verdict is the second look, which can turn a block into `unknown` and never turns a failure into a pass. Whether a hard "no model anywhere" mode is worth offering is an open question.
- *A hidden suite the agent never sees* is the strongest guard against an agent special-casing the examples in a bug report. Apex verify's checks are written fresh per task and cached outside the project, but we do not yet instruct the checker to avoid the task's own example values, and we have not measured that. A cheap deterministic warning for a task's example value appearing in an added condition is built.
- Locked tests in a sandbox, signed evidence and mutation of the changed lines (OpenHarnX, N0 Verify) are on our [roadmap](../ROADMAP.md).

If we got something wrong about your project, please open an issue and we will fix it.
