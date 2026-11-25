# Real libraries, no key: three experiments and one fix (0.3.0 to 0.3.1)

**Set.** The 200 labelled AI-written changes to 23 real open-source libraries from [`../real-projects`](../real-projects) (107 wrong, 93 right; labels from the upstream fix's hidden tests). Claude Code as the checker (`--provider claude-cli`, no key), one run per change, a fresh draft of the checks per change, the full pipeline. Rows: `<run>.json`; runner output: `<run>.log`.

| Run | Wrong changes blocked | Right changes wrongly blocked |
|---|---|---|
| Gemini API checker, 0.2.4 (`../real-projects`) | 91 in 100 | 23 in 100 |
| **0.3.0, Claude Code, no key** (`baseline`) | **106 of 107 (99%)** | 23 of 93 (25%) |
| Two drafts, block if either fails (`two-drafts`, `APEX_EXP_DRAFTS=2`) | 106 of 107 | 28 of 93 (30%) |
| Kept-behaviour probe (`kept`, `APEX_EXP_KEEP=1`) | 106 of 107 | 26 of 93 (28%) |
| **0.3.1: second look at out-of-date tests** (`outdated`) | **106 of 107 (99%)** | **16 of 93 (17%)** |

**Two drafts and the probe** helped on the small projects ([`../exp-two-drafts`](../exp-two-drafts)) but not here: on real libraries the checks already catch almost every wrong change, so a second draft or a probe can only add false alarms. Neither is turned on.

**Why right changes were stopped in the 0.3.0 run (all 23 read).**
- **10: the project's own tests.** In 8 of them a test asserts exactly the old behaviour the task asks to change. The cookie task says leading-dot domains such as `.example.com` "should be accepted"; the library's old test asserts that `.example.com` throws. The change is right and the test is out of date, but a test that passed before and fails now was always a regression.
- **13: generated checks**, almost all on two tasks (cookie RFC 6265, content-disposition). Reading them, the check follows the task text and the change does not (the task says quoted values are allowed; the change rejects them): the hidden upstream test is narrower than the task. This matches the earlier study ([`../false-alarms-real-libraries`](../false-alarms-real-libraries)). We did not tune for these.

**The fix (on by default in 0.3.1, `APEX_OUTDATED=0` turns it off).** When a test that passed before fails now, the checker gets a second look: the task, the failure output and the test's source, never the change. It must say whether every failing test asserts old behaviour the task explicitly asks to change, and quote the sentence of the task that contradicts it; the quote is checked against the task text, so it cannot invent one. If so, the failure is reported as `tests_outdated` and the verdict is `unknown`, with "update the test to the new behaviour" (never `ready`).

**Result.** It fired on 8 changes, all right ones, all on the cookie-domain task, and on no wrong change: false alarms 23 to 16, catches unchanged at 106 of 107. 7 of the 8 became `unknown`; one is still `not ready` because a generated check also failed.

**Limits.** One run each. All 8 excused changes come from one task, so this shows the mechanism works, not how often it applies. The small projects were not rerun for this change: their good changes did not fail their own tests, so the second look never runs there. Gemini models wrote every change.
