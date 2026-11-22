# Fresh inputs: does telling the checker to avoid the task's own examples help?

Same 108 changes and the same protocol as `verify-gate-round1`, with `--fresh-inputs` (the checker is told to test the rule with values other than the task's examples).

| | Wrong changes blocked | Right changes wrongly blocked |
|---|---|---|
| Default | 28 of 43 (65%) | 2 of 65 (3%) |
| `--fresh-inputs` | 27 of 43 (63%) | 4 of 65 (6%) |

**Reading it.** No gain: one fewer wrong change blocked and two more false alarms, which is inside run-to-run noise. The option exists (`--fresh-inputs`) but is **off by default**, and we do not recommend it.

**Limits.** One run per change, Gemini checker and Gemini-written changes only, small projects. A different task style (bug reports with literal examples) might behave differently; the data is in `results.json`.
