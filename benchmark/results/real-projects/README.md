# Real open-source projects

**23 real libraries, 200 AI-written changes, each task a real historical bug fix** (jshttp, visionmedia, micromatch/picomatch, simov/slugify, EvanHahn/HumanizeDuration). `project/` is the code at the commit before the fix, `hidden/` holds the test(s) the fix added, `reference/` the fixed code. Each task carries the upstream LICENSE and a `SOURCE.txt` (repository, commit, issue). Checked for every task: the visible tests pass on `project/`; the hidden tests fail on `project/` and pass on `reference/`. (One exception, noted in its SOURCE.txt: in `real-cookie-domain-dot` upstream also moved a case between the visible tests' lists.)

Two passes: the first five tasks (30 changes) and eighteen more (170 changes), chosen for harder multi-case bugs so that small models write a meaningful share of wrong changes.

## How the changes were made

Per task, 6 to 10 samples from Gemini through the OpenAI-compatible endpoint: `gemini-2.5-flash` and `gemini-2.5-flash-lite`, temperature 0.8 to 0.9. The prompt was the task text plus the project's source and test files; the model returned edited files, turned into unified diffs. Empty and duplicate diffs were dropped; nothing was selected on how it looked. Each change was labelled **right or wrong by the hidden tests**. Upstream tests written for mocha run on `node --test` through a small shim (`project/test/mocha-shim.cjs`).

## Correction (2026-11-23): the first numbers published here were wrong

The first version of this page said the projects' own tests stopped **none** of the wrong changes and that "the visible tests passed for every change". That was false. Apex verify had a bug: it did not find the test command of a project with no installed dependencies, so on all 23 libraries it never ran the project's tests, and the "tests only" column was `unknown` everywhere. Nobody checked the visible tests directly. When we did, they failed on 85 of the 107 wrong changes. The bug is fixed in 0.2.4 and everything below is a fresh run with it. The withdrawn rows are kept in `results-first-run-withdrawn.json`.

## Results (one run, Apex verify 0.2.4, checker `gemini-3.1-pro-preview`)

| | The project's tests + cheating scan | Apex verify (tests + scan + checks) |
|---|---|---|
| Wrong changes blocked (107) | **80 (75%)** | **97 (91%)** |
| Wrong changes called READY | 0 | 1 |
| Wrong changes left `unknown` | 27 | 9 |
| Right changes wrongly blocked (93) | **10 (11%)** | **21 (23%)** |
| Right changes called READY | 0 (no checker: at most `unknown`) | 64 |

**What the checker adds.** Of the 27 wrong changes that the project's own tests did not catch, the generated checks caught **17**, called 1 `ready` and left 9 `unknown`. That is the real question this tool exists for, and 27 changes is a small sample.

**What it costs.** Of the 83 right changes that pass the project's tests, the generated checks wrongly blocked **11 (13%)**: `cookie-rfc6265` 5, `contentdisp-attrchar` 2, and one each in four other tasks. The other 10 wrong blocks come from the project's tests themselves: 8 in `real-cookie-domain-dot`, where the upstream fix also changed a visible test, so every correct fix fails the old one, and 2 in `bytes-thousands`.

## An earlier audit (of the withdrawn run)

In the withdrawn run we looked by hand at the 10 right-by-label changes the checks blocked and found that 6 really did not do what the task text says (the upstream hidden test was narrower than the task), 2 were checker errors and 2 were noise (`audit.json`). **That audit has not been repeated for the run above**, so it does not turn the 13% into a smaller number; it only says some of those blocks are probably deserved.

## Limits, plainly

- The set is **lopsided**: many tasks have no right change at all (so no false-alarm information), others few. The false-alarm rate rests on 93 right changes in 18 tasks.
- Gemini models wrote every change and the checker is also Gemini. One run per change. The hidden tests are the narrow upstream fix tests and can themselves be narrow; changes that only differ from upstream in untested ways count as right.
- In the slugify tasks many wrong changes come from the model retyping a huge character-map line and dropping characters, not from the logic; that inflates the number of wrong changes.
- Dropped before building (and why): `vercel/ms`, `basic-auth`, `media-typer` (tests need `should` or `expect.js`), `cookie` as TypeScript at some commits, `etag e5714b6` (the hidden test could not fail on modern Node), `mustache.js d820d25` (needs chai, pins an internal token shape), `real-extglob-branches` (the hidden test asserts a regex's exact source, so labels would be unreliable). About 8 unusable model answers (hunk-only or empty diffs) were not counted.
- The first pass's parser mislabelled changes once; it was fixed and rerun on the saved raw answers, with no resampling.
