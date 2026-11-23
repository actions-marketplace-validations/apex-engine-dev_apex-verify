import type { Reason, VerifyReport } from "./verify.js";

const LABEL = { ready: "READY", not_ready: "NOT READY", unknown: "UNKNOWN" } as const;
export const verdictLabel = (r: VerifyReport) => LABEL[r.verdict];
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function testsLine(r: VerifyReport): string {
  const t = r.tests;
  if (!t.command) return "tests: none found";
  if (!t.after) return `tests: ${t.command} (did not run)`;
  return `tests: ${t.after.passed} passed, ${t.after.failed} failed${t.before ? ` (before the change: ${t.before.passed} passed, ${t.before.failed} failed)` : ""}`;
}
function checksLine(r: VerifyReport): string {
  const c = r.checks;
  if (!c.written) return `checks: none written${c.writtenBy ? "" : " (no checker model)"}`;
  const second = r.secondChecks?.written ? `; second checker ${r.secondChecks.writtenBy}: ${r.secondChecks.passed} passed, ${r.secondChecks.failed} failed` : "";
  return `checks: ${c.passed} passed, ${c.failed} failed; written from the task by ${c.writtenBy}; ${c.failedOnOldCode ? "they fail on the old code" : "they do NOT fail on the old code"}${second}`;
}

/** What a person (and an agent that reads the output) sees. */
export function renderText(r: VerifyReport): string {
  const out = [`apex verify: ${verdictLabel(r)}`];
  if (r.reasons.length) out.push("");
  for (const x of r.reasons) {
    out.push(`  - ${x.summary}`);
    if (x.evidence) out.push(...x.evidence.split("\n").slice(0, 14).map((l) => `      ${l}`));
    if (x.hint) out.push(`      fix: ${x.hint}`);
  }
  if (r.verdict === "ready") out.push("", "  The checks written from your task pass, the tests pass, and nothing was weakened.");
  out.push("", `  ${testsLine(r)}`, `  ${checksLine(r)}`, `  change: ${plural(r.change.files.length, "file")} ${r.change.mode === "patch" ? "in the diff" : `compared with ${r.change.base}`}`);
  out.push(`  sandbox: ${r.sandbox}`);
  for (const w of r.warnings) out.push(`  note: ${w}`);
  out.push(`  ${r.usage.seconds}s, ${plural(r.usage.modelCalls, "model call")}; proof ${r.proof.slice(0, 19)}...  (--json for the full report)`);
  return out.join("\n");
}

/** One comment for a pull request; the marker lets the Action update it in place. */
export function renderMarkdown(r: VerifyReport): string {
  const icon = r.verdict === "ready" ? "✅" : r.verdict === "not_ready" ? "❌" : "❔";
  const out = ["<!-- apex-verify -->", `### ${icon} Apex verify: **${verdictLabel(r)}**`, ""];
  for (const x of r.reasons) {
    out.push(`- **${x.summary}**`);
    if (x.evidence) out.push("  <details><summary>evidence</summary>", "", "  ```", ...x.evidence.split("\n").slice(0, 20).map((l) => `  ${l}`), "  ```", "  </details>");
    if (x.hint) out.push(`  - fix: ${x.hint}`);
  }
  if (r.verdict === "ready") out.push("The checks written from the task pass, the tests pass, and nothing was weakened.");
  out.push("", `| | |`, `|---|---|`, `| ${testsLine(r).split(": ")[0]} | ${testsLine(r).split(": ").slice(1).join(": ")} |`, `| checks | ${checksLine(r).replace(/^checks: /, "")} |`, `| change | ${plural(r.change.files.length, "file")} vs \`${r.change.base}\` |`);
  if (r.warnings.length) out.push("", ...r.warnings.map((w) => `> note: ${w}`));
  out.push("", `<sub>${r.usage.seconds}s, ${plural(r.usage.modelCalls, "model call")} · proof \`${r.proof.slice(0, 19)}…\` · [Apex verify](https://github.com/apex-engine-dev/apex-verify)</sub>`);
  return out.join("\n");
}

/** SARIF 2.1.0 for code scanning: one result per reason (not-ready reasons as errors, the rest as warnings). */
export function renderSarif(r: VerifyReport): string {
  const level = (x: Reason) => (x.kind === "regression" || x.kind === "cheat" || x.kind === "check_failed" ? "error" : "warning");
  const results = r.reasons.map((x) => ({
    ruleId: `apex/${x.kind}`, level: level(x), message: { text: `${x.summary}${x.hint ? ` Fix: ${x.hint}` : ""}` },
    locations: [{ physicalLocation: { artifactLocation: { uri: r.change.files[0]?.path ?? "." } } }],
  }));
  const rules = [...new Set(r.reasons.map((x) => x.kind))].map((k) => ({ id: `apex/${k}`, shortDescription: { text: k.replace(/_/g, " ") } }));
  return JSON.stringify({ $schema: "https://json.schemastore.org/sarif-2.1.0.json", version: "2.1.0", runs: [{ tool: { driver: { name: "apex verify", informationUri: "https://github.com/apex-engine-dev/apex-verify", rules } }, results }] }, null, 2);
}

/** A shields.io endpoint badge: https://img.shields.io/endpoint?url=<raw URL of this file>. */
export function renderBadge(r: VerifyReport): string {
  const message = r.verdict === "ready" ? "ready" : r.verdict === "not_ready" ? "not ready" : "unknown";
  const color = r.verdict === "ready" ? "brightgreen" : r.verdict === "not_ready" ? "red" : "lightgrey";
  return JSON.stringify({ schemaVersion: 1, label: "apex verify", message, color });
}

/** The same badge as a static SVG (no shields.io needed): `--badge-out badge.svg`. Idea from the first outside pull request (#17). */
export function renderBadgeSvg(r: VerifyReport): string {
  const message = r.verdict === "ready" ? "ready" : r.verdict === "not_ready" ? "not ready" : "unknown";
  const color = r.verdict === "ready" ? "#4c1" : r.verdict === "not_ready" ? "#e05d44" : "#9f9f9f";
  const label = "apex verify";
  const w = (t: string) => Math.round(t.length * 6.6 + 12);
  const lw = w(label), mw = w(message), total = lw + mw;
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${esc(label)}: ${esc(message)}"><title>${esc(label)}: ${esc(message)}</title>` +
    `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>` +
    `<clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath>` +
    `<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${mw}" height="20" fill="${color}"/><rect width="${total}" height="20" fill="url(#s)"/></g>` +
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="${lw / 2}" y="14">${esc(label)}</text><text x="${lw + mw / 2}" y="14">${esc(message)}</text></g></svg>`;
}

/** The exit codes: 0 ready, 1 not ready, 3 unknown (2 is a usage or setup error). */
export const exitCode = (v: VerifyReport["verdict"]) => (v === "ready" ? 0 : v === "not_ready" ? 1 : 3);
