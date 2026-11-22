# apex-bench report

Task set `8cd4fc4536c4`, 51 runs. Machine: darwin 27.2.0 arm64, Apple M4 Pro, 48 GB, node v22.22.1.

| Arm | Runs | Pass (95% CI) | Tokens median [95% CI] | Seconds median [95% CI] | False-ready |
|---|---|---|---|---|---|
| alone-weak | 17 | 6/17 35% [17%, 59%] | 159,438 [70,225, 506,975] | 42.34 [26.96, 149.11] | 6/11 55% [28%, 79%] |
| engine-weak | 17 | 1/17 6% [1%, 27%] | 58,557 [45,024, 96,745] | 6.53 [4.34, 11.89] | 3/4 75% [30%, 95%] |
| alone-frontier | 17 | 16/17 94% [73%, 99%] | 89,120 [71,487, 136,214] | 51.45 [42.52, 88.30] | 1/16 6% [1%, 28%] |

## Paired comparison vs `alone-weak`

| Arm | Tasks | Only arm passes | Only baseline passes | McNemar p | Sign p | Mean diff (pts) | Verdict |
|---|---|---|---|---|---|---|---|
| engine-weak | 17 | 1 | 6 | 0.125 | 0.125 | -29 [-53, 0] | no significant difference |
| alone-frontier | 17 | 10 | 0 | 0.002 | 0.002 | 59 [35, 82] | alone-frontier better |

## Warnings

- alone-frontier: tokens known for 16 of 17 runs only.

## How to read this

- Pass is hidden tests (and visible tests, if the task has them) exiting 0 after the agent stops. Pass-rate CI is a Wilson interval over runs.
- False-ready = the agent claimed it was done and the hidden tests still failed, among runs where the claim is known. `n/a` means the arm cannot tell, not zero.
- Tokens are whatever the agent CLI reports about itself (`n/a` if it reports nothing); cached tokens may or may not be included. Compare tokens only between arms that count the same way.
- Small task sets cannot separate close arms: see the underpowered warnings and the README limits.
