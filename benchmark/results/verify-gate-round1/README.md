# Gate round 1: does `apex verify` catch wrong AI changes?

**Question.** Given a change an AI already made, how often does `apex verify` block it when it is wrong, and how often does it block it when it is right?

**Data.** 199 distinct AI-written changes (diffs) to 17 small projects, produced earlier by Gemini models (gemini-2.5-flash-lite, gemini-3.8-flash, gemini-3.1-pro-preview) run directly or through `apex-agent`. Each change is labelled right or wrong by **hidden tests that the verifier never saw** (134 right, 65 wrong). Tasks: the 12 public tasks in `benchmark/tasks` plus five real bug fixes in open-source projects (not included here).

**Conditions.**
- **A** (the default): the project's tests, the cheating scan, and an independent checker model (`gemini-3.1-pro-preview`) writing checks from the task, drafted independently for every change, with the second look. Run on a sample of up to 4 right and 4 wrong changes per task: **108 changes, 65 right, 43 wrong.**
- **B**: A plus a prompt asking for unstated standard-practice cases (line endings, empty input). Same 108 changes.
- **C**: no model: only the project's tests and the cheating scan, all 199 changes.

**Results** (`results.json`, `analyze.py`; 95% Wilson intervals; the intervals assume independent changes, but changes cluster by task, so the real uncertainty is wider):

| | wrong changes blocked | right changes wrongly blocked | READY verdicts that were right |
|---|---|---|---|
| **A: independent checker** | **28 of 43 (65%, 50-78%)** | **2 of 65 (3%, 1-11%)** | 62 of 77 (81%) |
| B: A + unstated cases | 26 of 43 (60%, 46-74%) | 3 of 65 (5%, 2-13%) | 58 of 72 (81%) |
| C: tests + cheating scan only | 5 of 65 (8%, 3-17%) | 2 of 134 (1%, 0-5%) | no model: never says ready |

**Reading it.** The independent checker is what moves the number: from 8% to 65% of wrong changes caught, for a small false-alarm rate. The unstated-cases hint did not help (within noise), so it is off by default (`--standard-cases`).

**Limits.** Small, mostly single-file projects; the right/wrong labels are our hidden tests, which cover the behaviour the task states; the changes come from weaker Gemini models, and the checker is another Gemini model (not another vendor); one run per change; the sample is balanced per task, so "81% of READY verdicts were right" depends on the mix (here 60% of changes were right). This is a first measurement, not a guarantee; please break it ([new issue](https://github.com/apex-engine-dev/apex-done-checker/issues/new/choose)).
