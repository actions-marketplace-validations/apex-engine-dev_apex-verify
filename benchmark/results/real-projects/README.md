# Real open-source projects

Five small, zero-dependency, MIT-licensed Node libraries (jshttp and visionmedia). Each task is a real historical bug fix: `project/` is the code at the commit before the fix, `hidden/` holds the test file(s) from the fix commit (copied unchanged, renamed `hidden-*.test.js`), `reference/` is the fixed source. Licence and `SOURCE.txt` (repo, commit hashes, issue where one exists) are in every task folder. The libraries' mocha tests run on `node --test` through our small shim `project/test/mocha-shim.cjs`, so nothing needs installing.

| Task | Library | Fix commit | Issue |
|---|---|---|---|
| `real-bytes-thousands` | visionmedia/bytes.js | db70acb | #51 |
| `real-negotiator-params` | jshttp/negotiator | 0484c74 | none linked |
| `real-fresh-modified` | jshttp/fresh | 7a2b460 | #23 |
| `real-forwarded-ows` | jshttp/forwarded | 0c489a1 | none linked |
| `real-range-parser-partial` | jshttp/range-parser | 8de80cd | #13 |

Checked for every task: visible tests pass on `project/`; hidden tests fail on `project/` and pass on `reference/`.

**Dropped candidates:** vercel/ms (2669f23) and jshttp/basic-auth (5de8cdc) were looked at and dropped before building, because their tests need `expect.js` / `should` (not zero-dependency), and cookie (71798d7) because it is TypeScript. No built candidate failed the check. Picked by us, not by a search over many projects.

## How the changes were made

Per task, 6 samples from Gemini through the OpenAI-compatible endpoint: `gemini-2.5-flash` x4 and `gemini-2.5-flash-lite` x2, temperature 0.8. The prompt was the task prompt plus the source and test files; the model returned whole edited files, turned into `diff -ruN` against `project/`. Duplicates (after ignoring timestamps) would have been dropped: 0 of 30 were duplicates or empty, so all 30 are kept. Labels come from running the hidden tests on project + diff: **27 right, 3 wrong** (one wrong per task for bytes, forwarded and fresh; none for negotiator and range-parser).

## Results (30 changes, one run)

Checker: `gemini-3.1-pro-preview`.

| | Tests + cheating scan alone | Gate with the checker |
|---|---|---|
| Wrong changes blocked | **0 of 3** (3 unknown) | **3 of 3** |
| Right changes wrongly blocked | 0 of 27 | **1 of 27** (negotiator) |
| Right changes left unknown | 27 of 27 | 5 of 27 (all bytes) |
| Right changes marked READY | 0 | 21 of 27 |

Without a checker the gate cannot say "ready" on these projects, since the visible tests passed for every change, so everything is "unknown".

## Limits, plainly

- **Tiny sample.** 5 tasks, 30 changes, only 3 wrong. "3 of 3 blocked" has a 95% interval of roughly 44-100%. Do not read a rate out of this.
- Gemini models wrote every change, and the checker is also Gemini. 90% of the changes were right, so there is little to catch.
- One run per change; the hidden tests are the upstream fix tests and can themselves be narrow.
- The test commands use our shim, not mocha.
- The one wrong block of a right change and the 5 unknowns are real misses of the gate; they are not removed.
