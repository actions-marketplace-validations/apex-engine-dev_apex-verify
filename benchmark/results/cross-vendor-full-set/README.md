# Two companies, the full pipeline, 101 changes

The checks for 16 of the 17 tasks were written by **Claude** (Anthropic; the files are in `../second-vendor/checks/claude`) and run through the complete `apex verify` pipeline (tests, type check, cheating scan, the check must fail on the old code) on the same changes the Gemini checker judged in `verify-gate-round1` (101 of the 108: one task has no Claude checks). Claude's second look is off (no live Claude call in this test); Gemini's second look is on.

| Checker | Wrong changes blocked | Right changes wrongly blocked |
|---|---|---|
| Gemini 3.1 Pro (alone) | 25 of 40 (63%) | 2 of 61 (3%) |
| Claude (alone) | 22 of 40 (55%) | 1 of 61 (2%) |
| Block only when **both** object | 17 of 40 (43%) | 1 of 61 (2%) |
| Block when **either** objects | **30 of 40 (75%)** | 2 of 61 (3%) |

**Reading it.**
- A checker from a different company works about as well as the default one: 55% against 63%, both with 2-3% false alarms. That answers [#5](https://github.com/apex-engine-dev/apex-verify/issues/5).
- Requiring **both** to object does *not* help (43%): the earlier 60% / 2% figure (`../second-vendor`) came from a smaller test that counted failing checks without the rest of the pipeline. This corrects the README.
- Blocking when **either** objects caught the most (75%) at the same false-alarm rate here, because the pipeline already turns a check that cannot fail on the old code into `unknown`. It is **not** a shipped mode: it is one measurement on 40 wrong changes. If you run two checkers, `--second-model` today returns `unknown` when only one objects.

**Limits.** One run per change; 16 tasks, small projects, Gemini-written changes only; Claude's checks were written once per task by a Claude subagent from the prompt `apex verify` builds (an older prompt version), not through `--provider anthropic`; 40 wrong changes, so a few changes move the percentages a lot.
