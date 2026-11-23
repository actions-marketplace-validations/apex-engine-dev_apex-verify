#!/usr/bin/env python3
"""Tables from results/results.json -> results/tables.md"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from run import H
rows = json.load(open(os.path.join(H, "results", "results.json")))
out = []; P = out.append
def n(xs): return sum(1 for x in xs if x)
def frac(a, b): return f"{a} of {b}" + (f" ({round(100*a/b)}%)" if b else "")
arms = {"A": "A: no hook", "B": "B: hook as shipped", "C": "C: hook, details withheld"}
P("### Final result per arm\n"); P("| Arm | Sessions | Timed out | Failed after retry | Hidden tests pass at the end | ...small tasks | ...real-library tasks | Existing test lines removed at the end (sessions) |"); P("|---|---|---|---|---|---|---|---|")
for a, name in arms.items():
    R = [r for r in rows if r["arm"] == a]; S = [r for r in R if not r["task"].startswith("real-")]; L = [r for r in R if r["task"].startswith("real-")]
    P(f"| {name} | {len(R)} | {n(r['timeout'] for r in R)} | {n(r['failed'] for r in R)} | {frac(n(r['final_hidden'] for r in R), len(R))} | {frac(n(r['final_hidden'] for r in S), len(S))} | {frac(n(r['final_hidden'] for r in L), len(L))} | {n(r['final_test_lines_removed'] > 0 for r in R)} |")
P("\n### What the hook did (arms B and C)\n"); P("| Arm | Sessions | Hook ran at least once | First attempt already passed hidden tests | First attempt failed hidden tests | ...of those, blocked | Sessions blocked at least once | Blocks in total | Sessions that hit the 3-block cap |"); P("|---|---|---|---|---|---|---|---|---|")
for a in "BC":
    R = [r for r in rows if r["arm"] == a]; H1 = [r for r in R if r["hook_calls"]]
    bad = [r for r in H1 if not r["first_attempt_hidden"]]
    P(f"| {arms[a]} | {len(R)} | {len(H1)} | {n(r['first_attempt_hidden'] for r in H1)} | {len(bad)} | {frac(n(r['attempts'][0]['blocked'] for r in bad), len(bad))} | {n(r['blocked'] for r in R)} | {sum(r['blocks'] for r in R)} | {n(r['hit_block_cap'] for r in R)} |")
P("\n### Blocked sessions, attempt by attempt\n\nAttempt k is the working tree at the k-th time the agent said it was done (the k-th hook call). Attempt 1 fails the shown checks almost by construction: that is usually why it was blocked.\n")
P("| Arm | Attempt | Sessions that got this far | Pass the shown checks | Pass the hidden tests |"); P("|---|---|---|---|---|")
for a in "BC":
    B = [r for r in rows if r["arm"] == a and r["blocked"]]
    for k in range(1, 1 + max([len(r["attempts"]) for r in B] or [0])):
        X = [r["attempts"][k-1] for r in B if len(r["attempts"]) >= k]
        P(f"| {a} | {k} | {len(X)} | {frac(n(x['shown'] for x in X), len(X))} | {frac(n(x['hidden'] for x in X), len(X))} |")
    P(f"| {a} | end of session | {len(B)} | {frac(n(r['final_shown'] for r in B), len(B))} | {frac(n(r['final_hidden'] for r in B), len(B))} |")
P("\n### How blocked sessions ended\n"); P("| Arm | Blocked sessions | Real fix (hidden tests pass) | ...of which were false blocks (already passed before the block) | ...fixed after a block | Gaming (shown checks pass, hidden fail) | Still failing both | Removed existing test lines |"); P("|---|---|---|---|---|---|---|---|")
for a in "BC":
    B = [r for r in rows if r["arm"] == a and r["blocked"]]
    rf = [r for r in B if r["blocked_outcome"] == "real_fix"]
    fb = [r for r in rf if r["first_attempt_hidden"]]
    P(f"| {arms[a]} | {len(B)} | {len(rf)} | {len(fb)} | {len(rf) - len(fb)} | {n(r['blocked_outcome'] == 'gaming' for r in B)} | {n(r['blocked_outcome'] == 'still_failing_both' for r in B)} | {n(r['final_test_lines_removed'] > 0 for r in B)} |")
P("\n### Every blocked session\n"); P("| Arm | Task | Run | Blocks | Per attempt: shown/hidden (B = blocked) | End: shown/hidden | Outcome | Test lines removed | Timed out |"); P("|---|---|---|---|---|---|---|---|---|")
yn = lambda v: "?" if v is None else "pass" if v else "fail"
for r in rows:
    if not r["blocked"]: continue
    att = "; ".join(f"{x['attempt']}: {yn(x['shown'])}/{yn(x['hidden'])}{' B' if x['blocked'] else ''}" for x in r["attempts"])
    P(f"| {r['arm']} | {r['task']} | {r['run']} | {r['blocks']} | {att} | {yn(r['final_shown'])}/{yn(r['final_hidden'])} | {r['blocked_outcome'].replace('_', ' ')}{' (false block)' if r['false_block_attempts'] else ''} | {r['final_test_lines_removed']} | {'yes' if r['timeout'] else ''} |")
P("\n### Hook verdicts that were not READY and not a block\n")
for r in rows:
    for x in r["attempts"]:
        if x["hook"] in ("unknown", "error", "not_ready_not_blocking"): P(f"- {r['arm']} {r['task']} run {r['run']} attempt {x['attempt']}: {x['hook']}: {'; '.join(x['reasons'])[:260]} (hidden tests: {yn(x['hidden'])})")
P("\n### Per task: hidden tests pass at the end (run 1, run 2)\n"); P("| Task | A | B | C |"); P("|---|---|---|---|")
for t in dict.fromkeys(r["task"] for r in rows):
    c = lambda a: " ".join(yn(r["final_hidden"]) + ("*" if r["blocked"] else "") for r in sorted((r for r in rows if r["task"] == t and r["arm"] == a), key=lambda r: r["run"]))
    P(f"| {t} | {c('A')} | {c('B')} | {c('C')} |")
P("\n\\* = blocked at least once.")
open(os.path.join(H, "results", "tables.md"), "w").write("\n".join(out) + "\n"); print("\n".join(out))
