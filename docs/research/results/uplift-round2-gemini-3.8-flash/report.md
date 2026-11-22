# apex-bench report

Task set `8cd4fc4536c4`, 102 runs. Machine: darwin 27.2.0 arm64, Apple M4 Pro, 48 GB, node v22.22.1.

| Arm | Runs | Pass (95% CI) | Tokens median [95% CI] | Seconds median [95% CI] | False-ready |
|---|---|---|---|---|---|
| alone-weak | 34 | 17/34 50% [34%, 66%] | 194,958 [136,825, 257,135] | 828.90 [611.50, 1004.48] | 1/6 17% [3%, 56%] |
| engine-weak-checked-n6 | 34 | 20/34 59% [42%, 74%] | 42,520 [26,233, 82,266] | 553.83 [364.86, 716.83] | 1/10 10% [2%, 40%] |
| alone-frontier | 34 | 29/34 85% [70%, 94%] | 62,112 [58,594, 70,155] | 554.22 [380.87, 985.32] | 1/12 8% [1%, 35%] |

## Paired comparison vs `alone-weak`

| Arm | Tasks | Only arm passes | Only baseline passes | McNemar p | Sign p | Mean diff (pts) | Verdict |
|---|---|---|---|---|---|---|---|
| engine-weak-checked-n6 | 17 | 4 | 2 | 0.688 | 0.754 | 9 [-12, 29] | no significant difference |
| alone-frontier | 17 | 9 | 1 | 0.021 | 0.012 | 35 [15, 56] | alone-frontier better |

## Warnings

- alone-weak: tokens known for 6 of 34 runs only.
- engine-weak-checked-n6: tokens known for 11 of 34 runs only.
- alone-frontier: tokens known for 13 of 34 runs only.

## How to read this

- Pass is hidden tests (and visible tests, if the task has them) exiting 0 after the agent stops. Pass-rate CI is a Wilson interval over runs.
- False-ready = the agent claimed it was done and the hidden tests still failed, among runs where the claim is known. `n/a` means the arm cannot tell, not zero.
- Tokens are whatever the agent CLI reports about itself (`n/a` if it reports nothing); cached tokens may or may not be included. Compare tokens only between arms that count the same way.
- Small task sets cannot separate close arms: see the underpowered warnings and the README limits.
