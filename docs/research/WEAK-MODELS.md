# Research track: can proof lift a weaker model? (not part of `apex verify`)

> **Status.** This was the project's first goal. The agent runner and the benchmark harness that served it were removed from this repository when the project focused on `apex verify`; the engine's code-writing loop is no longer in this repository either (it remains in the commercial product), so the files named in the table below are partly or wholly absent here. The measurements are kept in `docs/research/results/` and summarised in `docs/EXPERIMENTS.md`: the first uplift results were positive but not statistically significant.

# The goal, and how the code serves it

**Goal: help any cloud model, even a small cheap one, code at the level of a frontier model.**

That is a claim about capability, so it is measured as **uplift** and **gap closed**, not as a feeling:

- *uplift* = pass rate of (model + Apex verify) minus pass rate of the model alone, on tasks with hidden tests;
- *gap closed* = uplift divided by (frontier model alone minus the model alone), when the frontier model is better. 100% means the small model with Apex verify matches the frontier model; 0% means Apex added nothing.

Run it: `node leaderboard/run.mjs --weak=<weaker model> --frontier=<frontier model>` (see `leaderboard/README.md`).

## The levers (what in the code is meant to move a weak model up)

| Lever | What it does for a weaker model | Where |
|---|---|---|
| **Scoped context** | A weak model drowns in a whole repo. The code graph hands it the files, symbols and call sites that matter. | `graph.ts`, `scoped-context.ts` |
| **Checks first** | Tests written from the request, before the change, so the model codes against a target and the engine can tell a real fix from a plausible one. | `surgical.ts` (specFirst, drafted checks) |
| **Reproduce first** | For a bug, a test that fails on the current code must exist before a fix counts. | `surgical.ts` (reproFirst) |
| **Several versions, ranked by proof** | Small models are inconsistent; ask for more than one try and keep the one that passes. | `surgical.ts` (best-of-n, adaptive) |
| **Repair rounds from real failures** | Feed the actual failing test output back, once or twice. | `surgical.ts` (repairs) |
| **A second look** | When the proof disagrees, ask whether the change or the check is wrong; never call it `ready` on a broken check. | `surgical.ts` (secondLook), `proof-gate.ts` |
| **Per-model profiles** | Every model needs different settings (how many versions, how strict, how much context). Calibrate once, share the profile. | `calibration/`, `profiles/` |
| **Honest status** | The gate says `ready` only on proof, so a weaker model's mistakes are caught, not shipped. | `proof-gate.ts`, `verified.ts` |

## What is proven and what is not

Proven (see `leaderboard/`, `docs/EXPERIMENTS.md`): the engine uses far fewer tokens and less time for the same pass rate on easy tasks; nothing is written unless the proof holds.

**First uplift result (one run per task, not yet significant):** weak model `gemini-2.5-flash-lite` 6/17 alone, 9/17 with Apex verify when a stronger model writes the checks and the weak one gets six versions, frontier model 16/17: about 30% of the gap closed. A weak model checking itself scored 1/17. So the lever that matters most is *independent checks*, then *several versions*. See the README.

**Still not proven: uplift on hard tasks at scale.** An early private result (the same model going from 13/22 to 22/22) did not reproduce on the public tasks, because those were too easy for that model. The uplift study above is how we find out, and every contribution should be judged by it: does it raise gap closed for weak models, or cut cost for the same result? If it does neither, it needs a reason.
