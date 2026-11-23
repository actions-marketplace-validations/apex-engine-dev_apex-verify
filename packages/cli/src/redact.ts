import type { ModelClient, ModelEvent, ModelRequest } from "apex-verify-engine";

/**
 * Everything sent to the checker model is an excerpt of the user's project and the agent's change. Files that look like
 * secrets are not offered to the model at all (`looksSecret`), and strings that look like keys or tokens are replaced
 * before a request leaves the machine, whatever file they sit in. This is a safety net, not a guarantee.
 */
export const looksSecret = (rel: string): boolean =>
  /(^|\/)\.env(\.|$)|\.(pem|key|p12|pfx|keystore|jks)$|(^|\/)(id_rsa|id_ed25519|id_ecdsa)(\.pub)?$|(^|\/)(credentials?|secrets?)(\.|\/|$)|(^|\/)\.(netrc|npmrc|pypirc|git-credentials|pgpass)$/i.test(rel);

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bsk_(?:live|test)_[0-9A-Za-z]{10,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];
const ASSIGNMENT = /((?:api[_-]?key|secret|token|passwd|password|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?)([A-Za-z0-9_\-./+=]{12,})/gi;

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, "[REDACTED]");
  return out.replace(ASSIGNMENT, "$1[REDACTED]");
}

/** A model client whose requests are redacted before they are sent. */
export function redactingClient(inner: ModelClient): ModelClient {
  return { stream(req: ModelRequest): AsyncIterable<ModelEvent> { return inner.stream({ ...req, messages: req.messages.map((m) => (typeof m.content === "string" ? { ...m, content: redactSecrets(m.content) } : m)) }); } };
}
