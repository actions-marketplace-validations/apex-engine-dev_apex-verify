# Two checkers from the same company: does requiring both to object help?

Same 108 changes and protocol as `verify-gate-round1`, with `--second-model gemini-2.5-pro` next to the default `gemini-3.1-pro-preview` (the change is `not ready` only when both object; one objection gives `unknown`).

| | Wrong changes blocked | Right changes wrongly blocked | `unknown` |
|---|---|---|---|
| One checker | 28 of 43 (65%) | 2 of 65 (3%) | 1 |
| Two Gemini checkers, both must object | 23 of 43 (53%) | 3 of 65 (5%) | 26 |

**Reading it.** Two checkers from the *same* company did not help: fewer wrong changes blocked and no fewer false alarms. The earlier test with checkers from **different** companies (`second-vendor`: 60% blocked, 2% false alarms) is a different and smaller experiment (16 tasks, one check set per task) and is still the only evidence for the option, so use two different companies' models if you use it at all.

**Limits.** One run per change; Gemini only; the second model is weaker than the first.
