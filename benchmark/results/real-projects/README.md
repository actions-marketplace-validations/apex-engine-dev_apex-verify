# Real open-source projects

**23 real libraries, 200 AI-written changes, each task a real historical bug fix** (jshttp, visionmedia, micromatch/picomatch, simov/slugify, EvanHahn/HumanizeDuration). `project/` is the code at the commit before the fix, `hidden/` holds the test(s) the fix added, `reference/` the fixed code. Each task carries the upstream LICENSE and a `SOURCE.txt` (repository, commit, issue). Checked for every task: the visible tests pass on `project/`; the hidden tests fail on `project/` and pass on `reference/`. (One exception, noted in its SOURCE.txt: in `real-cookie-domain-dot` upstream also moved a case between the visible tests' lists.)

Two passes: the first five tasks (30 changes) and eighteen more (170 changes), chosen for harder multi-case bugs so that small models write a meaningful share of wrong changes.

## How the changes were made

Per task, 6 to 10 samples from Gemini through the OpenAI-compatible endpoint: `gemini-2.5-flash` and `gemini-2.5-flash-lite`, temperature 0.8 to 0.9. The prompt was the task text plus the project's source and test files; the model returned edited files, turned into unified diffs. Empty and duplicate diffs were dropped; nothing was selected on how it looked. Each change was labelled **right or wrong by the hidden tests**. Upstream tests written for mocha run on `node --test` through a small shim (`project/test/mocha-shim.cjs`).

## Results (one run, checker `gemini-3.1-pro-preview`)

| | Tests + cheating scan alone | Gate with the checker |
|---|---|---|
| Wrong changes blocked | **0 of 107** | **86 of 107 (80%)** |
| Wrong changes marked READY (missed) | 0 | 14 of 107 |
| Right changes wrongly blocked | 0 of 93 | **10 of 93 (11%)** |
| Right changes marked READY | 0 | 70 of 93 |
| Left `unknown` | everything | 7 wrong, 13 right |

Without a checker the gate cannot say `ready` on these projects (the visible tests passed for every change), so everything is `unknown` and nothing is blocked: **the project's tests plus the cheating scan caught none of the wrong changes here.**

**Per task** (wrong / right changes, then what the gate did):

| Task | Changes | Wrong blocked | Right wrongly blocked |
|---|---|---|---|
| `real-bracket-negation` | 9 / 0 | 8 of 9 | 0 of 0 |
| `real-bytes-thousands` | 1 / 5 | 1 of 1 | 0 of 5 |
| `real-contentdisp-attrchar` | 4 / 6 | 3 of 4 | 2 of 6 |
| `real-contentdisp-hexescape` | 6 / 4 | 3 of 6 | 0 of 4 |
| `real-contentdisp-lws` | 6 / 4 | 6 of 6 | 0 of 4 |
| `real-cookie-domain-dot` | 2 / 8 | 2 of 2 | 1 of 8 |
| `real-cookie-rfc6265` | 4 / 6 | 4 of 4 | 3 of 6 |
| `real-forwarded-ows` | 1 / 5 | 1 of 1 | 0 of 5 |
| `real-fresh-modified` | 1 / 5 | 1 of 1 | 0 of 5 |
| `real-globstar-in-parens` | 6 / 0 | 6 of 6 | 0 of 0 |
| `real-globstar-literal-adjacent` | 7 / 0 | 7 of 7 | 0 of 0 |
| `real-humanize-decimal-dollar` | 5 / 5 | 3 of 5 | 0 of 5 |
| `real-humanize-plural-maxdecimals` | 6 / 4 | 5 of 6 | 0 of 4 |
| `real-negated-extglob-star` | 10 / 0 | 9 of 10 | 0 of 0 |
| `real-negotiator-params` | 0 / 6 | 0 of 0 | 1 of 6 |
| `real-range-parser-partial` | 0 / 6 | 0 of 0 | 0 of 6 |
| `real-scan-parts` | 8 / 0 | 6 of 8 | 0 of 0 |
| `real-slugify-empty-charmap` | 5 / 5 | 5 of 5 | 0 of 5 |
| `real-slugify-extend-replacement` | 7 / 3 | 2 of 7 | 0 of 3 |
| `real-slugify-strict-trim` | 5 / 5 | 5 of 5 | 0 of 5 |
| `real-slugify-trim-replacement` | 8 / 2 | 3 of 8 | 0 of 2 |
| `real-statuses-proto` | 4 / 6 | 4 of 4 | 1 of 6 |
| `real-windows-basename` | 2 / 8 | 2 of 2 | 2 of 8 |

## What to read from this

- The checker catches most wrong changes on real libraries (80%), against none for tests alone.
- By the hidden-test label it wrongly blocks 11 in 100 right changes, more than on the small projects; **after the audit above, about 4 in 100 are checker mistakes** (the rest are changes that really miss something the task text says).
- It missed 14 wrong changes (called them READY).

## Audit of the 10 wrongly blocked right changes (done after seeing the results)

We looked at each one by hand and, where the task text makes a claim, ran that claim against the change (`audit.json` has the evidence per change). Result:

| What it was | Count |
|---|---|
| **The change passes the upstream hidden test but does not do what the task text says**: the gate was right, the label (the hidden test) was too narrow | 6 |
| **A real checker error**: a generated check contradicted the task, or had a harness mistake | 2 |
| **Checker noise**: READY on a rerun of the same change | 2 |

So by the benchmark's own label (hidden tests) the gate wrongly blocks **10 of 93 (11%)**, but **only 4 of 93 (4%) are mistakes of the checker**; the other 6 are changes that really do not satisfy the stated task. Read the 4% with care: one reviewer (the maintainers' tooling, not an independent person) did the audit after the numbers were known, and the checks are rewritten on every run, so three of the ten flipped on a rerun. We keep the original labels in `results.json` and report both numbers.

A second check on the same question: the gate was run on each task's own **upstream reference fix** (the real maintainers' fix). It said READY for 18 of 23, `unknown` for 4, and NOT READY for 1 (`real-negotiator-params`), so a correct fix usually passes.

## Limits, plainly

- The set is **lopsided**: many tasks have no right change at all (so no false-alarm information), others few. The false-alarm rate rests on 93 right changes in 18 tasks.
- Gemini models wrote every change and the checker is also Gemini. One run per change. The hidden tests are the narrow upstream fix tests and can themselves be narrow; changes that only differ from upstream in untested ways count as right.
- In the slugify tasks many wrong changes come from the model retyping a huge character-map line and dropping characters, not from the logic; that inflates the number of wrong changes.
- Dropped before building (and why): `vercel/ms`, `basic-auth`, `media-typer` (tests need `should` or `expect.js`), `cookie` as TypeScript at some commits, `etag e5714b6` (the hidden test could not fail on modern Node), `mustache.js d820d25` (needs chai, pins an internal token shape), `real-extglob-branches` (the hidden test asserts a regex's exact source, so labels would be unreliable). About 8 unusable model answers (hunk-only or empty diffs) were not counted.
- The first pass's parser mislabelled changes once; it was fixed and rerun on the saved raw answers, with no resampling.
