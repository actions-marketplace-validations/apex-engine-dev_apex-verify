// Summarize a run-gate result file: node summarize.mjs results/<arm>.json
import fs from "node:fs";
for (const f of process.argv.slice(2)) {
  const rows = JSON.parse(fs.readFileSync(f, "utf8"));
  const W = rows.filter((r) => !r.correct), R = rows.filter((r) => r.correct);
  const n = (xs, v) => xs.filter((r) => r.verdict === v).length;
  const byTests = (r) => (r.reasons ?? []).some((k) => k === "regression" || k === "cheat");
  const fa = R.filter((r) => r.verdict === "not_ready");
  const per = {}; for (const r of fa.filter((r) => !byTests(r))) per[r.task] = (per[r.task] ?? 0) + 1;
  console.log(JSON.stringify({ file: f, wrong: W.length, wrongBlocked: n(W, "not_ready"), wrongBlockedByChecksOnly: W.filter((r) => r.verdict === "not_ready" && !byTests(r)).length, wrongReady: n(W, "ready"), wrongUnknown: n(W, "unknown"), right: R.length, rightBlocked: fa.length, rightBlockedByTests: fa.filter(byTests).length, rightBlockedByChecks: fa.filter((r) => !byTests(r)).length, rightReady: n(R, "ready"), rightUnknown: n(R, "unknown"), errors: n(rows, "error"), checksFalseAlarmsByTask: per }));
}
