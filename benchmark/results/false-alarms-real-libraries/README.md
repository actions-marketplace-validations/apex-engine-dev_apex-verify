# Fewer false alarms from the generated checks: three attempts, none adopted

**Question.** On the 200 changes to real libraries (`../real-projects`), Apex verify wrongly blocks 21 of 93 right changes; 11 of those blocks come from the generated checks. Can that number be cut without losing wrong changes?

**Short answer.** No candidate beat the unchanged tool. And most of those 11 are not false alarms of the checker in the first place: in about 7 of 10 the blocked change really does not do what the task text says, and the hidden upstream test is too narrow to notice.

## What the false alarms are

For every right-by-label change the checks blocked (in the published 0.2.4 run and in a fresh rerun), the checks that run wrote were run again on three trees: the project before the fix, **the upstream fix itself** (`reference/`), and the change. A check that fails on the upstream fix is a checker error, whatever the task says. A check that passes on the upstream fix and fails on the change was read against the task text. Per-change evidence: `diagnosis.json`.

| Class | Published run (11) | Baseline rerun (10) |
|---|---|---|
| (a) the check asserts something the task does not state | 3 | 3 |
| (b) the check contradicts the task | 0 | 0 |
| (c) bug in the test code (wrong expected value in a "pin nearby behaviour" test) | 1 | 0 |
| (d) the change does not do what the task says, or breaks something that worked: the label is too narrow | 7 | 7 |

Class (d) in detail: `real-cookie-rfc6265` (5 and 4 blocks): the changes reject a double-quoted value, which the task allows in so many words, or accept `;` in domain and path, or reject an ordinary path. `real-contentdisp-attrchar`: `,` stays unescaped although the task lists it. `real-slugify-strict-trim`: strict mode with an empty replacement now throws `Invalid regular expression`; it worked before. `real-windows-basename` (rerun, one of three): `picomatch.test(..., { basename: true, windows: true })` still does not match. In every one of these the same checks pass on the upstream fix.

Class (a) is partly borderline: two of the three in each run are checks the upstream fix passes (calling `picomatch.matchBase` directly; a lone `%` keeping the simple header form; valid attr-chars left unescaped) on points the task text does not settle. We counted them against the checker.

**(e) Run-to-run noise** cuts across the classes: 15 distinct right changes were blocked by checks in at least one of the two runs of the same code, 6 in both and 9 in only one. 25 of the 200 verdicts differ between the two runs.

So with the labels taken at face value the checks wrongly block 10 or 11 of the 83 right changes that pass the projects' tests (12 to 13%); counting only the blocks that are the checker's own doing it is 3 or 4 of 83 (4 to 5%). The second figure rests on our reading of the task texts; the first does not. Quote both.

## The three candidates

All three aim at class (a), the only one a change to the tool can remove. Diffs: `candidate-A.diff`, `candidate-B.diff`, `candidate-C.diff` (against 0.2.5).

- **A. Name the task's words (check-writing prompt).** Every test must carry, in its name, the words of the task that decide its expected result; no words, no test. Where the task points to a standard, no stricter reading than its words require.
- **B. The second look must quote.** When checks fail, the second look lists each failing check as `STATED "<words copied from the task>"` or `UNSTATED`. The tool verifies the quote is really in the task; a change is blocked only on a verified quote. (Different from the earlier per-check second look in `../second-look-per-check`: one call, and the burden of proof is on blocking.)
- **C. Review before any change is seen.** One more model call rereads the drafted checks against the task and removes the tests the task does not decide. The tool accepts the shorter file only if it removes tests and adds or renames none.

## Method (fixed before any candidate result existed: `PROTOCOL.txt`)

The 200 `real-*` changes (107 wrong, 93 right by hidden tests), one run per arm, checker `gemini-3.1-pro-preview`, concurrency 4, fresh checks for every change, Apex verify 0.2.5. `rungate.mjs` is `benchmark/run-gate.mjs` with two additions: a manifest path, and saving each report's reason kinds (to split blocks into tests-caused and checks-caused). A block is tests-caused when the report has a regression or cheat reason. A candidate wins only if checks-caused false alarms fall by more than the difference between the baseline rerun and the published run, without wrong-blocked falling by more than that difference.

## Results

| Arm | Wrong blocked (of 107) | Wrong called READY | Wrong `unknown` | Right blocked (of 93): tests + checks | Right READY | Right `unknown` |
|---|---|---|---|---|---|---|
| Published (0.2.4, earlier run) | 97 | 1 | 9 | 21 = 10 + **11** | 64 | 8 |
| Tests and cheating scan only (no model) | 80 | 0 | 27 | 10 = 10 + 0 | 0 | 83 |
| **Baseline rerun (0.2.5, unchanged)** | **100** | 1 | 6 | 20 = 10 + **10** | 62 | 11 |
| A. name the task's words | 104 | 1 | 2 | 26 = 10 + **16** | 60 | 7 |
| B. second look must quote | 105 | 1 | 1 | 22 = 10 + **12** | 57 | 14 |
| C. review before the change | 101 | 1 | 5 | 20 = 10 + **10** | 66 | 7 |

No errors in any arm. The one wrong change called READY is the same in every run (`real-humanize-plural-maxdecimals:a5f7bacab3`).

**Noise.** Two runs of the same code (published and baseline) differ by 3 on wrong-blocked and by 1 on checks-caused false alarms, and on 25 individual verdicts. The candidates differ from the baseline on 22 (A), 25 (B) and 28 (C) verdicts: the same as rerunning the unchanged tool.

**Reading.**
- **A made it worse**: 16 checks-caused false alarms against 10. The checks did not get fewer (6.7 per change against 6.8); the quoted words in the test names seem to make the second look side with the check more often (it blamed the change in 16 of 24 cases with a failing check on a right change, against 10 of 21). Not adopted.
- **B did not reduce false alarms** (12 against 10) and left more right changes `unknown` (14 against 11). It blocked 5 more wrong changes; that is larger than the 3 we saw between two baseline runs, but it is one run, it was not what we were testing for, and it came with more false alarms. A verified quote does not stop a misreading: B blocked twice on checks that fail on the upstream fix too, each time with a real sentence of the task quoted for a wrong expectation. Not adopted.
- **C changed nothing we can measure** on the blocks (10 against 10; 101 wrong blocked against 100). It had fewer right changes with any failing check (15 against 21) and more right changes READY (66 against 62), both inside the noise, for one more model call per verify (2.7 calls against 1.7, 78 s against 43 s per change). Not adopted.
- **The checker's own errors are few in every arm** (looked at after the fact, not part of the protocol; `upstream-fix-check.json`): of the checks-caused blocks of right changes, those where a failing check also fails on the upstream fix are 2 of 10 (baseline), 2 of 16 (A), 3 of 12 (B), 3 of 10 (C). The rest are checks the real fix passes and the change does not.

**The 12 public small projects** (first 40 right and 40 wrong changes, `--limit 80`), baseline and C (the candidate with the fewest false alarms, run as the protocol says even without a winner):

| Arm | Wrong blocked (of 40) | Wrong called READY | Right blocked (of 40) | Right READY | Right `unknown` |
|---|---|---|---|---|---|
| Baseline | 18 | 22 | 0 | 39 | 1 |
| C | 15 | 24 | 0 | 40 | 0 |

No false alarms in either; C blocked 3 fewer wrong changes (one more left `unknown`). One run each, so this is not evidence that C hurts, and it is certainly not evidence that it helps.

## What we conclude

1. Nothing ships. The default stays as it is.
2. The 23% false-alarm headline on real libraries overstates the checker's own error: 10 of the 21 blocks come from the projects' tests, and about 7 of the other 10 or 11 are changes that do not do what the task says. The labels, not the checker, are the next thing to fix: relabel with a wider hidden test, or report both figures.
3. A cheap objective measure for this benchmark: run every generated check file on `reference/`. A check that fails there is wrong, with no hand audit. That would give a checker-error rate per run directly.
4. Single runs cannot resolve differences of a few changes on this set. Any next attempt needs at least three runs per arm.

## Limits

- One run per arm. The noise figure comes from one pair of runs (and that pair is 0.2.4 against 0.2.5; by the changelog they differ in sandbox details and one Python-only parsing fix, not in how checks are written or judged).
- The classification into (a) and (d) is our reading of six task texts; the "passes on the upstream fix" part is mechanical. The published run's check files were taken from a cache left on the machine by an earlier full run; for all 11 changes they fail on the change, as the published verdicts say, but we cannot prove it is the same run.
- 93 right changes in 18 tasks; the checks-caused blocks sit in 5 or 6 tasks, so the figures cluster. Checker and change writer are both Gemini. Candidates were run at the same time as each other (and A, B, C overlapped the end of the baseline run), so API load differed a little between arms; checks failed to be written for 4 (baseline), 0 (A), 3 (B) and 5 (C) changes.
- The example in A's prompt and the tests are not taken from benchmark tasks.

## Files

`baseline.json`, `tests-only.json`, `candidate-A.json`, `candidate-B.json`, `candidate-C.json`, `small-baseline.json`, `small-candidate-C.json`: one row per change (`verdict`, `reasons`). `diagnosis.json`: the classification. `upstream-fix-check/`: for every checks-caused block in every arm, the failing checks on the old code, the upstream fix and the change. `rungate.mjs`, `summarize.mjs`, `refcheck.mjs`: the scripts.
