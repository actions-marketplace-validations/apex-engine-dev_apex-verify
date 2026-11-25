# Experiments: a second draft of the checks, and a "did it keep what worked?" probe

Both were tried because of what the misses look like. In the no-key baseline ([`../no-key-claude-cli`](../no-key-claude-cli)) and in the Gemini run before it, every wrong change that got through was called `ready`: checks were written and run, they just did not test the thing that was broken. Running the 15 Gemini-run misses against their hidden tests sorted them into four groups: old behaviour the change should have kept (4, emitter), conventions the task does not state (7: negative money, CRLF, surrounding spaces), a snapshot that is not a copy (3), and one plainly stated rule (1).

**Protocol.** The same 79 public changes and settings as the baseline (Claude Code as the checker, one run per change, a fresh draft per change), with one switch each. Neither switch is on by default.

- **Two drafts** (`APEX_EXP_DRAFTS=2`): when the first set of checks passes, a second, independent set is written (with inputs other than the task's examples) and the change is blocked if either set finds a problem. A second draft costs one more model call on the changes the first set passed.
- **Kept behaviour** (`APEX_EXP_KEEP=1`, JavaScript only): the checker writes a probe that calls code that existed before the change on inputs the task is not about; the probe runs twice on the old code (unstable lines are dropped) and once on the new; any difference goes to a second look that decides whether the task asked for it. Two more model calls per change. Code: `packages/cli/src/kept.ts`.

| Run | Wrong changes blocked | Right changes wrongly blocked |
|---|---|---|
| Baseline (Claude Code, no key) | 19 of 31 (61%) | 0 of 48 |
| **Two drafts** | **21 of 31 (68%)** | **0 of 48** |
| **Kept behaviour** | **22 of 31 (71%)** | 2 of 48 (4%) |
| Either experiment objects (computed) | 24 of 31 (77%) | 2 of 48 (4%) |

`results.json` and `log.txt` here (two drafts) and in [`../exp-kept-behaviour`](../exp-kept-behaviour).

**What changed, change by change.**
- Two drafts caught 3 the baseline missed (two todo-persist, one emitter) and missed 1 the baseline caught (todo-persist): run-to-run variation of the checks is part of this.
- Kept behaviour caught 3 the baseline missed (emitter "off removes the wrong copy", todo-persist, csv) and lost none. Some of that may be the ordinary checks varying, not the probe.
- Both false alarms from the probe are csv changes that now return an empty row for a blank line. That is a real behaviour change the task did not ask for; the hidden tests do not care about it, so the benchmark counts it as a false alarm. That is the trade-off this probe makes: it notices side effects the task's author may or may not mind.

**Reading it.** Both point the right way and neither is proven: one run each on 31 wrong changes, where 2 or 3 changes either way is within the noise. Two drafts improved the catch rate here with no false alarms. The probe catches a different kind of miss at the cost of flagging real but harmless side effects.

**Next, before either ships.** Repeat on the 23 real libraries, where false alarms are already 23 in 100 and where the probe's side-effect alarms would cost the most; and repeat the small set once more to see how much is variation.

**Outcome (2026-11-25).** On the 23 real libraries both only added false alarms (28 and 26 of 93, against 23) and caught nothing extra: [`../real-libraries-experiments`](../real-libraries-experiments). Neither is on by default; the switches stay for further experiments.
