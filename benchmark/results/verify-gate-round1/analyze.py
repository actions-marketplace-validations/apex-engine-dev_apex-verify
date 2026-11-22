"""Reads results.json and prints, per condition: wrong changes blocked, right changes wrongly blocked, READY precision (95% Wilson intervals)."""
import json, math, collections, os
def wilson(k, n):
    if n == 0: return (0, 0)
    p = k / n; z = 1.96; d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d; h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (round(100 * (c - h)), round(100 * (c + h)))
data = json.load(open(os.path.join(os.path.dirname(__file__), "results.json")))
for name, rows in data.items():
    rows = [r for r in rows if r["verdict"] != "error"]
    wrong = [r for r in rows if not r["correct"]]; right = [r for r in rows if r["correct"]]
    c = collections.Counter((r["correct"], r["verdict"]) for r in rows)
    caught, fa = c[(False, "not_ready")], c[(True, "not_ready")]
    ready = c[(True, "ready")] + c[(False, "ready")]
    print(f"{name}: {len(rows)} changes ({len(right)} right, {len(wrong)} wrong)")
    print(f"  wrong blocked   {caught}/{len(wrong)} = {100*caught/max(len(wrong),1):.0f}%  {wilson(caught, len(wrong))}")
    print(f"  right blocked   {fa}/{len(right)} = {100*fa/max(len(right),1):.0f}%  {wilson(fa, len(right))}")
    if ready: print(f"  READY correct   {c[(True,'ready')]}/{ready} = {100*c[(True,'ready')]/ready:.0f}%")
