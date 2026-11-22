import { surgicalBestOfN, type CandidateResult, type FileEdit, type SurgicalOptions, type SurgicalResult } from "./surgical.js";
import { surgicalDecision } from "./check-screen.js";
import type { CheckResult } from "./check-results.js";
import type { ModelClient } from "./model.js";
import type { Workspace } from "./workspace.js";

/**
 * verifiedOutcome: ask a model for a change to a project and get back the change together with what was run to check
 * it. This wraps the versions step (`surgicalBestOfN`) and reads its result with the same rules the Apex agent loop
 * applies to decide "ready" or "unverified"; it adds no rule of its own.
 *
 * Where the rule lives (so nothing here is a second copy):
 *  - surgical.ts decides the verdict of the chosen version (`SurgicalResult.verdict`): the project's tests must pass
 *    (`testsOk`), every proven check must pass, no check may be pending (`checksVerdict`, check-results.ts), and the
 *    checks must show the change (`vacuousChecks`: checks that also passed before the change make it "unverified").
 *  - `surgicalDecision` (check-screen.ts) turns that into write / write unverified / hold; the loop calls it with
 *    `warnOnly` = the profile's `checks !== "block"`. Here that is `checksPolicy`.
 *  - A second look that finds the CHECKS at fault (`SurgicalResult.secondLook.verdict === "test"`) makes the change
 *    "unverified", never "ready" (agent-loop.ts, `checksAtFault`).
 *
 * What stays in the app (agent-loop.ts, ~lines 1196-1330 and 1936-2150) and is NOT applied here: the step-by-step
 * loop that continues from a draft; the dependents' tests of the code graph; a rename that left the old name in the
 * code; "asked for a test, none written"; "nothing was run"; the end-of-turn acceptance proof gate
 * (draftAcceptance/runAcceptance exist in proof-gate.ts but are wired by the loop); the user's stop and time-outs.
 * A host that wants those calls the same exported pieces.
 */
export type OutcomeStatus = "ready" | "not_ready" | "unverified" | "failed" | "answer";

export interface VerifiedOutcomeOptions extends Omit<SurgicalOptions, "gateway" | "model" | "root" | "workspace"> {
  /** The model to ask. */
  model: ModelClient;
  /** The model id passed in every request (clients that serve several models read it). Default "". */
  modelId?: string;
  /** The project folder. A string is the root of a plain folder; an object adds a custom `files` workspace for the engine's own reads and writes. */
  workspace: string | { root: string; files?: Workspace };
  /** "block" (default): a proven failing check holds the change ("not_ready"). "warn": it is "unverified" instead (the app's weaker-model profile). */
  checksPolicy?: "block" | "warn";
}

export interface Evidence {
  testsPassed: number;
  testsFailed: number;
  /** Per-check results for the chosen version; passed null = could not be judged. */
  checks: CheckResult[];
  checksPassed: number;
  checksFailed: number;
  /** Why the status is not "ready" (empty when it is). */
  reasons: string[];
  securityFlags: string[];
  droppedChecks: Array<{ text: string; reason: string }>;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  seconds: number;
}

export interface VerifiedOutcome {
  status: OutcomeStatus;
  /** The chosen version's search/replace edits ([] when there is none). */
  edits: FileEdit[];
  /** The same change as whole files, before and after. */
  changes: SurgicalResult["changes"];
  evidence: Evidence;
  /** The versions step's full result, for callers that need more. */
  result: SurgicalResult;
}

/** The status the evidence supports (see the rule list above). Exported so a host that ran the versions step itself can use it. */
export function outcomeStatus(r: SurgicalResult, checksPolicy: "block" | "warn" = "block"): { status: OutcomeStatus; reasons: string[] } {
  const reasons: string[] = [];
  if (!r.chosen) {
    if (r.gaveUp) return { status: "failed", reasons: [r.gaveUp] };
    // No version proposed any edit: the model answered without changing anything.
    if (!r.candidates.some((c: CandidateResult) => c.edits.length)) return { status: "answer", reasons };
    return { status: "failed", reasons: ["no version could be applied"] };
  }
  const verdict = r.verdict;
  // The project's own tests did not pass on the chosen version, or it changed nothing.
  if (!verdict || !r.changes.length) return { status: "failed", reasons: [r.chosen.failed ? `${r.chosen.failed} of the project's tests fail` : "the change could not be verified against the project's tests"] };
  if (verdict.reason) reasons.push(verdict.reason);
  if (r.secondLook?.verdict === "test") return { status: "unverified", reasons: [...reasons, `the failing checks look wrong, not the change${r.secondLook.reason ? ` (${r.secondLook.reason})` : ""}`] };
  const decision = surgicalDecision({ testsOk: true, checksFailing: verdict.outcome === "not_ready", checksNotLoaded: Boolean(r.checksNotLoaded), pending: verdict.outcome === "unverified", warnOnly: checksPolicy === "warn" });
  if (decision === "hold_not_ready") return { status: "not_ready", reasons };
  if (decision === "write_unverified") return { status: "unverified", reasons };
  return verdict.outcome === "ready" ? { status: "ready", reasons: [] } : { status: "unverified", reasons };
}

/** Ask for the change and verify it. Writes nothing to the project unless `apply: true`. */
export async function verifiedOutcome(o: VerifiedOutcomeOptions): Promise<VerifiedOutcome> {
  const { model, modelId, workspace, checksPolicy, ...rest } = o;
  const root = typeof workspace === "string" ? workspace : workspace.root;
  const files = typeof workspace === "string" ? undefined : workspace.files;
  const result = await surgicalBestOfN({ apply: false, ...rest, gateway: model, model: modelId ?? "", root, ...(files ? { workspace: files } : {}) });
  const { status, reasons } = outcomeStatus(result, checksPolicy);
  const chosen = result.chosen;
  return {
    status,
    edits: chosen?.edits ?? [],
    changes: result.changes,
    evidence: {
      testsPassed: chosen?.passed ?? 0,
      testsFailed: chosen?.failed ?? 0,
      checks: result.checkResults ?? [],
      checksPassed: chosen?.checksPassed ?? 0,
      checksFailed: chosen?.checksFailed ?? 0,
      reasons,
      securityFlags: result.securityFlags ?? [],
      droppedChecks: (result.droppedChecks ?? []).map((d) => ({ text: d.text, reason: d.reason })),
      modelCalls: result.modelCalls,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      seconds: Math.round(result.ms / 100) / 10,
    },
    result,
  };
}
