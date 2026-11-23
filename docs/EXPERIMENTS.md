# Experiments, including the ones that did not work

**A "done without proof" hook (Gemini CLI, 12 tasks, 120 runs, 2026-11-19).** The question: does a Stop-style hook that warns or blocks when code was edited and no test ran afterwards reduce wrong "done" claims? Result: no measurable effect. Gemini ran the project's tests in 119 of 120 runs with or without the hook, so the hook fired twice. Pass 41/60 (68%) without it, 39/60 (65%) with it; claimed done but hidden tests failed 19/60 and 21/59. All 40 failed runs had run a test after the last edit and claimed done: plausible fixes that miss edge cases the visible tests do not cover. The hook checks that *some* test ran, so it cannot see that. Consequence for this project: the proof must come from checks written against the request and from the model's change being shown to fail them before and pass them after (the proof gate), not from "a test ran". The hook and the log report were removed from the public project.

**Token savings are not the headline.** Against Claude Code, cached reads dominate the bill, so a context tool's savings did not carry over; the measured savings (77-88% fewer tokens than the plain engine on Flash) are for this engine's own edit loop. Never quote them for other agents without a with/without run.


## Gate round 1 (2026-11-22): does `apex verify` catch wrong AI changes?
199 labelled AI-written changes, three conditions (tests + cheating scan only; plus an independent checker; plus a prompt for unstated standard-practice cases). The independent checker moved the share of wrong changes blocked from 8% to 65% at a 3% false-alarm rate; the unstated-cases prompt did not help (60%, 5%). Method, numbers and limits: [`benchmark/results/verify-gate-round1`](../benchmark/results/verify-gate-round1/README.md).

**What went wrong on the way (kept for honesty).** The first prototype run said the checker caught 70% and the weak model's own checks 89% with 56% false alarms; it drew one set of checks per task, so results clustered, and the check-writing call was cut off at about 400 characters because the model's reasoning used the output limit, which made checks fail to write for 41% of tasks. After fixing the limit and re-measuring with independent checks per change, the real product caught 65%.


## Second look per check (2026-11-22): tried, not adopted
Judging each failing check separately instead of together (so an over-strict check cannot soften a right one) gave the same catch rate (28 of 43) and more false alarms (5 of 65 against 2 of 65) on the 108-change benchmark. It was not shipped. Data and method: [`benchmark/results/second-look-per-check`](../benchmark/results/second-look-per-check/README.md).


## Fresh inputs and two same-company checkers (2026-11-22): tried, not recommended
Telling the checker to avoid the task's own example values caught 27 of 43 wrong changes (28 without) with 4 of 65 false alarms (2 without). Requiring two Gemini checkers to both object caught 23 of 43 with 3 of 65 false alarms and 26 `unknown` verdicts. Neither is on by default. Data and method: [`benchmark/results/fresh-inputs`](../benchmark/results/fresh-inputs), [`benchmark/results/two-checkers-same-vendor`](../benchmark/results/two-checkers-same-vendor). 


## Claude as the checker, full pipeline (2026-11-22)
Claude-written checks through the whole pipeline on 101 changes: 22 of 40 wrong changes blocked (Gemini 25 of 40), 1 of 61 false alarms. Both must object: 17 of 40. Either objects: 30 of 40 at 2 of 61 false alarms. The earlier "60% / 2% when both object" result did not survive the full pipeline and is withdrawn. Data: [`benchmark/results/cross-vendor-full-set`](../benchmark/results/cross-vendor-full-set).


## A wrong headline, and how it happened (2026-11-23)
We published that on 23 real libraries the projects' own tests stopped none of 107 wrong AI changes while Apex verify stopped 80%. The tests-only arm was `unknown` for every change, and we read that as "the tests passed". In fact the tool had not found those projects' test command (a detection bug for zero-dependency projects), so no test ever ran. Running the tests directly showed they fail on 85 of the 107. Lesson kept: an arm that returns `unknown` everywhere is a broken measurement, not a result; check the baseline by hand before quoting it. Corrected numbers: `benchmark/results/real-projects`.

## When the hook blocks, does the agent fix the bug or game the check? (2026-11-23)
120 Gemini CLI sessions on 20 tasks (a weak agent model on purpose), three arms: no hook, the hook as shipped, and the hook with the failing check's details withheld. Result: **too few cases to say much.** With the hook as shipped, 12 sessions were blocked on a change that really was wrong; 4 ended with a real fix, none went from failing the shown check to passing it while still wrong. Zero of 12 cannot rule out a gaming rate of 20% or more. Two agents broke a correct change after a false block (both blocked by the project's own test, which asserted the old behaviour). The run also found a bug: Gemini CLI's retry call carries no prompt, so the hook judged each session only once (fixed in 0.2.8). Protocol, every session and the scripts: [`benchmark/results/hook-fix-or-game`](../benchmark/results/hook-fix-or-game).

## Cutting the checks' false alarms on real libraries (2026-11-23): three attempts, none adopted
On the 200 real-library changes the generated checks block 10 or 11 of the 83 right changes that pass the projects' tests. Each was re-run against the upstream fix itself: about 7 in 10 are changes that really do not do what the task text says (the hidden test is too narrow), 3 or 4 are the checker asserting something the task does not state. Three candidates aimed at those (make each test name the task words it rests on; make the second look quote the task; an extra review that prunes undecided tests) did not beat the unchanged tool: 16, 12 and 10 checks-caused blocks against 10. Run-to-run noise is large: 25 of 200 verdicts differ between two runs of the same code, so future comparisons need at least 3 runs per arm. Everything: [`benchmark/results/false-alarms-real-libraries`](../benchmark/results/false-alarms-real-libraries).
