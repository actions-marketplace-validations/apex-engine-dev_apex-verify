import type { ModelRequest, ProvenanceItem } from "./model.js";

/**
 * What context went into a model request, and why: the request type with provenance, purpose and prompt-segment
 * sizes (the same fields as `ModelRequest`; kept as an alias for the callers that named it).
 */
export type ProvenanceReason = ProvenanceItem["reason"];
export type { ProvenanceItem };
export type ModelRequestX = ModelRequest;

/** One provenance list per path (first reason wins; chars add up). */
export function mergeProvenance(...lists: Array<ProvenanceItem[] | undefined>): ProvenanceItem[] {
  const out = new Map<string, ProvenanceItem>();
  for (const list of lists) for (const item of list ?? []) {
    const key = `${item.path}#${item.lines ?? ""}`;
    const had = out.get(key);
    if (had) had.chars += item.chars;
    else out.set(key, { ...item });
  }
  return [...out.values()];
}
