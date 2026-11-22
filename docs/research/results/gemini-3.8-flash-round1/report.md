# apex-bench report

Task set `558b7080ffec`, 18 runs. Machine: darwin 27.2.0 arm64, Apple M4 Pro, 48 GB, node v22.22.1.

| Arm | Runs | Pass (95% CI) | Tokens median [95% CI] | Seconds median [95% CI] | False-ready |
|---|---|---|---|---|---|
| alone | 9 | 9/9 100% [70%, 100%] | 252,143 [152,634, 323,194] | 117.04 [80.73, 277.04] | 0/9 0% [0%, 30%] |
| engine | 9 | 8/9 89% [57%, 98%] | 14,871 [10,294, 62,099] | 38.96 [12.88, 81.70] | 0/8 0% [0%, 32%] |

## Paired comparison vs `alone`

| Arm | Tasks | Only arm passes | Only baseline passes | McNemar p | Sign p | Mean diff (pts) | Verdict |
|---|---|---|---|---|---|---|---|
| engine | 9 | 0 | 1 | 1.000 | 1.000 | -11 [-33, 0] | no significant difference (underpowered) |

## Warnings

- engine vs alone: only 1 discordant task(s); the exact test cannot reach p < 0.05. Add tasks, not just runs.

## How to read this

- Pass is hidden tests (and visible tests, if the task has them) exiting 0 after the agent stops. Pass-rate CI is a Wilson interval over runs.
- False-ready = the agent claimed it was done and the hidden tests still failed, among runs where the claim is known. `n/a` means the arm cannot tell, not zero.
- Tokens are whatever the agent CLI reports about itself (`n/a` if it reports nothing); cached tokens may or may not be included. Compare tokens only between arms that count the same way.
- Small task sets cannot separate close arms: see the underpowered warnings and the README limits.
