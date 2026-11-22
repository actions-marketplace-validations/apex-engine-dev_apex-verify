/**
 * Engine options. Every knob the verified edit loop reads is a field here; each field falls back to the environment
 * variable it has always been read from (the names stay as aliases), so a host that sets nothing gets exactly the
 * behaviour measured in the benchmarks, and a library user can configure everything without touching the environment.
 *
 * Fields are resolved when they are used, not when the options object is made, as the variables always were.
 */
export interface EngineOptions {
  /** Where the environment aliases are read from. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Hidden-thinking tokens for the call that writes edits with a scoped context (APEX_GRAPH_THINKING); "default" = the client's own. */
  graphEditThinking?: number | "default";
  /** Same, for the call that writes the checks (APEX_GRAPH_CHECKS_THINKING). */
  graphChecksThinking?: number | "default";
  /** Hidden-thinking tokens for every version call, overriding the above (APEX_SURGICAL_THINKING). */
  surgicalThinking?: number;
  /** "full" sends the edit's context to the checks call as well (APEX_GRAPH_CHECKS_CONTEXT=full). Default "slim". */
  checksContext?: "slim" | "full";
  /** Characters of the scoped context (APEX_GRAPH_SCOPED_BUDGET; at least 2000). */
  scopedBudget?: number;
  /** Characters of the checks call's context (APEX_GRAPH_CHECKS_BUDGET; at least 2000). */
  checksBudget?: number;
  /** Seconds one version call may take (APEX_VERSION_CALL_SEC). */
  versionCallSeconds?: number;
  /** Seconds after which no new version starts (APEX_VERSIONS_MAX_SEC). */
  versionsMaxSeconds?: number;
  /** A folder that receives unusable answers and edits that did not apply, for diagnosis (APEX_SURGICAL_DEBUG). */
  debugDir?: string;
  /**
   * Text that marks a masked secret in a prompt (the host replaced a secret with a placeholder before the model
   * saw it). An edit containing it is refused, never applied. Default: the Apex placeholder mark.
   */
  secretMark?: string;
}

export const GRAPH_EDIT_THINKING = 2048;
export const GRAPH_CHECKS_THINKING = 1024;
export const CHECKS_BUDGET = 6000;
export const SCOPED_BUDGET = 12_000;
/** The mark the Apex host puts in a masked secret: `«secret:<kind>#<n>»`. */
export const SECRET_PLACEHOLDER_MARK = "«secret:";

/** Thinking budget of the edit or checks call (see GRAPH_*_THINKING): a number, or undefined for the client's default. */
export function graphThinking(kind: "edit" | "checks", env: NodeJS.ProcessEnv = process.env): number | undefined {
  const v = kind === "edit" ? env.APEX_GRAPH_THINKING : env.APEX_GRAPH_CHECKS_THINKING;
  if (v === "default") return undefined;
  const n = v !== undefined && v !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : kind === "edit" ? GRAPH_EDIT_THINKING : GRAPH_CHECKS_THINKING;
}
export const slimChecksContext = (env: NodeJS.ProcessEnv = process.env): boolean => env.APEX_GRAPH_CHECKS_CONTEXT !== "full";

/** The settings of one run, read through the options first and the environment aliases second. */
export interface EngineSettings {
  graphThinking(kind: "edit" | "checks"): number | undefined;
  /** The thinking budget when the options or APEX_SURGICAL_THINKING set one for every call, else undefined. */
  surgicalThinking(): number | undefined;
  slimChecks(): boolean;
  scopedBudget(): number;
  checksBudget(): number;
  /** Seconds, or 0 when unset (the caller applies its default). */
  versionCallSeconds(): number;
  versionsMaxSeconds(): number;
  debugDir(): string | undefined;
  secretMark(): string;
}

export function engineSettings(o: EngineOptions = {}): EngineSettings {
  const env = () => o.env ?? process.env;
  const budget = (own: number | undefined, name: string, fallback: number): number => {
    if (own !== undefined && Number.isFinite(own) && own >= 2000) return own;
    const e = env(); const n = Number(e[name]);
    return e[name] && Number.isFinite(n) && n >= 2000 ? n : fallback;
  };
  return {
    graphThinking(kind) {
      const own = kind === "edit" ? o.graphEditThinking : o.graphChecksThinking;
      if (own === "default") return undefined;
      if (own !== undefined && Number.isFinite(own) && own >= 0) return own;
      return graphThinking(kind, env());
    },
    surgicalThinking() {
      if (o.surgicalThinking !== undefined) return o.surgicalThinking;
      const v = env().APEX_SURGICAL_THINKING;
      return v !== undefined ? Number(v) : undefined;
    },
    slimChecks: () => (o.checksContext !== undefined ? o.checksContext !== "full" : slimChecksContext(env())),
    scopedBudget: () => budget(o.scopedBudget, "APEX_GRAPH_SCOPED_BUDGET", SCOPED_BUDGET),
    checksBudget: () => budget(o.checksBudget, "APEX_GRAPH_CHECKS_BUDGET", CHECKS_BUDGET),
    versionCallSeconds: () => o.versionCallSeconds ?? (Number(env().APEX_VERSION_CALL_SEC) || 0),
    versionsMaxSeconds: () => o.versionsMaxSeconds ?? (Number(env().APEX_VERSIONS_MAX_SEC) || 0),
    debugDir: () => o.debugDir ?? (env().APEX_SURGICAL_DEBUG || undefined),
    secretMark: () => o.secretMark ?? SECRET_PLACEHOLDER_MARK,
  };
}
