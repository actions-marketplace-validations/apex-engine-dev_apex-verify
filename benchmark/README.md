# Benchmark: how often is the gate right?

`benchmark/changes/` holds **154 AI-written changes** (diffs) to the 12 public projects in `benchmark/tasks/`. Each is labelled **right or wrong by hidden tests** (`tasks/<id>/hidden`) that `apex verify` never sees: 106 right, 48 wrong. The changes were written earlier by Gemini models (gemini-2.5-flash-lite, gemini-3.8-flash, gemini-3.1-pro-preview).

```sh
npm install                                   # builds dist/apex.mjs
node benchmark/run-gate.mjs --no-model        # tests + cheating scan only: free, no key
GEMINI_API_KEY=... node benchmark/run-gate.mjs --model gemini-3.1-pro-preview --limit 40
# other flags: --task <id>  --concurrency 3  --out results.json  -- <extra apex verify flags>
```

It prints: wrong changes blocked, right changes wrongly blocked (each with a 95% interval), READY verdicts that were right, and unknown counts. A fresh set of checks is written for every change.

## Results we have

| Folder | What | Headline |
|---|---|---|
| `results/verify-gate-round1/` | the default gate on 108 changes (79 on the public tasks, rest on five real bug fixes not included here) | all 17 tasks: **65%** of wrong changes blocked, **3%** of right ones wrongly blocked. **Public tasks only (the ones you can rerun): 16 of 31 wrong blocked (52%), 1 of 48 right blocked (2%).** Tests + cheating scan alone: 8% |
| `results/second-vendor/` | checks written by Claude (Anthropic) vs Gemini, one set per task, no repair or second look | Claude 69% blocked / 12% false alarms; Gemini 61% / 19%; **both must object: 60% blocked, 2% false alarms** |

Read `results/*/README.md` for the method and limits. In short: small projects, Gemini-written changes, one run per change, and the intervals understate the real uncertainty because changes cluster by task. Please try to break it.
