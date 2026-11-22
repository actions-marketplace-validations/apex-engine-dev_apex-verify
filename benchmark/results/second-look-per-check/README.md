# Tried and not adopted: judge each failing check separately

**Idea.** When a check fails, a short "second look" asks a model whether the check or the change is at fault. It judges all failing checks together, so one over-strict check could soften a clearly right failure into `unknown`. The change judged each failing check on its own and kept `not ready` if any one stood.

**Test.** The same 108 AI-written changes as `../verify-gate-round1` (43 wrong, 65 right, 17 projects), the full default pipeline, fresh checks for every change, a Gemini checker.

| | wrong changes blocked | right changes wrongly blocked | wrong changes turned into `unknown` |
|---|---|---|---|
| **Before** (judged together; the shipped behaviour) | 28 of 43 (65%) | 2 of 65 (3%) | 0 |
| After (judged one by one) | 28 of 43 (65%) | 5 of 65 (8%) | 0 |

On the built-in example (`examples/said-done`): 10 of 11 runs `not ready` before, 19 of 20 after. Not a real difference.

**Result.** No gain in catch rate, no wrong change was ever softened in the benchmark (so the problem is rare), and false alarms went from 3% to 8% (the intervals overlap, but the direction matches the design: a check judged on its own is easier to dismiss as wrong in the other direction too, and each run also writes fresh checks, so some of the difference is noise). **We did not ship it.** The shipped behaviour and all published numbers are unchanged. A single run of each condition cannot settle a small difference; if you want to try again with repeated runs, the script is `benchmark/run-gate.mjs`.
