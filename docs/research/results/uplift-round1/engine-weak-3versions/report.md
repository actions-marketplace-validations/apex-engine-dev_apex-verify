# apex-bench report

Task set `8cd4fc4536c4`, 17 runs. Machine: darwin 27.2.0 arm64, Apple M4 Pro, 48 GB, node v22.22.1.

| Arm | Runs | Pass (95% CI) | Tokens median [95% CI] | Seconds median [95% CI] | False-ready |
|---|---|---|---|---|---|
| engine-weak | 17 | 1/17 6% [1%, 27%] | 121,699 [58,672, 200,923] | 7.88 [7.00, 12.52] | 2/3 67% [21%, 94%] |

## How to read this

- Pass is hidden tests (and visible tests, if the task has them) exiting 0 after the agent stops. Pass-rate CI is a Wilson interval over runs.
- False-ready = the agent claimed it was done and the hidden tests still failed, among runs where the claim is known. `n/a` means the arm cannot tell, not zero.
- Tokens are whatever the agent CLI reports about itself (`n/a` if it reports nothing); cached tokens may or may not be included. Compare tokens only between arms that count the same way.
- Small task sets cannot separate close arms: see the underpowered warnings and the README limits.
