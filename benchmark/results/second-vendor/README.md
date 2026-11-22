# Second vendor: does a checker from a different company work as well?

The first measurement used a Gemini model to judge changes written by Gemini models. Here the checks are written by **Claude** (Anthropic), the same way, and compared with Gemini under an identical protocol.

**Protocol.** For each of 16 tasks, one check file is written from exactly the prompt `apex verify` builds (`draftAcceptance`), by `gemini-3.1-pro-preview` and by Claude (four Claude subagents, each given only the prompt files and told to read nothing else). One call each: no repair step, no second look, no caching tricks. Each check file is first run on the old code (to see that it can fail), then on all 191 labelled changes (129 right, 62 wrong; `results.json`), alone, with no other signal. The raw check files are in `checks/`.

| Checker | Wrong changes blocked | Right changes wrongly blocked |
|---|---|---|
| Gemini 3.1 Pro | 38 of 62 (61%) | 24 of 129 (19%) |
| **Claude** (Anthropic) | **43 of 62 (69%)** | **15 of 129 (12%)** |
| Block only when **both** object | 37 of 62 (60%) | **2 of 129 (2%)** |
| Block when **either** objects | 46 of 62 (74%) | 40 of 129 (31%) |
| The project's tests alone | 7 of 62 (11%) | 2 of 129 (2%) |

(The "both" and "either" rows also count a failing project test; the single-checker rows are the checks alone.)

**Reading it.** A checker from a different vendor than the model that wrote the code works at least as well. Two independent checkers that must both object cut false alarms from 12-19% to 2% while still blocking 60%: this is the strongest finding so far, and it is the plan for the next version (issue "Cross-execution").

**Limits.** One set of checks per task (so results cluster by task and the true uncertainty is wide), 16 tasks, Claude was run as subagents of a Claude Code session (Sonnet), the changes were written by Gemini models only. The default `apex verify` additionally has a second look and writes fresh checks per change; its numbers are in `../verify-gate-round1`.
