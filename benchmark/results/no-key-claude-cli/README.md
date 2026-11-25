# No API key: Claude Code as the checker (0.3.0)

**Question.** With no API key, Apex verify 0.3.0 can use a signed-in Claude Code (`--provider claude-cli`) to write the checks. Does that work as well as the default Gemini API checker?

**Protocol.** The full `apex verify` 0.3.0 pipeline, unchanged, on the same changes the Gemini checker judged in [`../verify-gate-round1`](../verify-gate-round1): the 79 of those 108 changes that belong to the 12 public projects in this repository (the other 29 are in 5 projects that are not published). One run per change, a fresh draft of the checks for every change, Claude Code's default model, `GEMINI_API_KEY` unset. Rerun:

```sh
node benchmark/run-gate.mjs --items benchmark/results/verify-gate-round1/results.json -- --provider claude-cli
```

| Checker | Wrong changes blocked | Right changes wrongly blocked |
|---|---|---|
| Gemini 3.1 Pro API (`verify-gate-round1`, same 79) | 16 of 31 (52%) | 1 of 48 (2%) |
| **Claude Code, no key** | **19 of 31 (61%)** | **0 of 48 (0%)** |
| Block when either objects | 20 of 31 | 1 of 48 |
| Block only when both object | 15 of 31 | 0 of 48 |

No errors, no `unknown` verdicts. Every `ready` on a wrong change (12) passed all the checks written for it. `results.json` has one row per change; `summary.txt` is the runner's output.

**Reading it.** The no-key mode is at least as good as the API checker on this set: 3 more wrong changes caught and no false alarm. The difference is within the noise of one run on 31 wrong changes (95% interval 44-76% for 19 of 31), so the claim is "about as good", not "better".

**Limits.** Small projects only (no real libraries yet), one run, Gemini-written changes, Claude Code's default model at the time of the run (2026-11-25). The Gemini run was made earlier, with an older version of `apex verify`.
