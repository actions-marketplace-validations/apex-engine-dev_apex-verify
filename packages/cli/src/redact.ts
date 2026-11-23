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
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];
/** "sk-..." keys: long, and with digits in them (a name like sk-learn-pipeline-for-models is not a key). */
const SK = /\bsk-[A-Za-z0-9_-]{24,}\b/g;
/** A password inside a URL: scheme://user:PASSWORD@host. */
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi;
const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/-]{16,}=*)/g;
const NAME = "(?:api[_-]?key|secret(?:[_-]?access)?(?:[_-]?key)?|token|passwd|password|private[_-]?key|client[_-]?secret)";
/** A quoted literal assigned to a secret-looking name: password = "..." or "apiKey": "...". Code such as token = parseToken(x) is left alone. */
const QUOTED = new RegExp(`(${NAME}["']?\\s*[:=]\\s*)(["'])([^"'\\n]{6,})\\2`, "gi");
/** A .env-style line: NAME_WITH_SECRET_WORD=value, nothing else on the line. */
const ENV_LINE = new RegExp(`^([ \\t]*(?:export[ \\t]+)?[A-Za-z0-9_.-]*${NAME}[A-Za-z0-9_.-]*[ \\t]*=[ \\t]*)([^\\s"'(){}\\[\\],;]{6,})[ \\t]*$`, "gim");

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, "[REDACTED]");
  out = out.replace(SK, (m) => (/\d/.test(m) && !/^sk-[a-z]+(?:-[a-z]+)+(?:-v?\d+)?$/.test(m) ? "[REDACTED]" : m));
  out = out.replace(URL_PASSWORD, "$1[REDACTED]$3").replace(BEARER, "$1[REDACTED]");
  return out.replace(QUOTED, "$1$2[REDACTED]$2").replace(ENV_LINE, "$1[REDACTED]");
}

/** A model client whose requests are redacted before they are sent. */
export function redactingClient(inner: ModelClient): ModelClient {
  return { stream(req: ModelRequest): AsyncIterable<ModelEvent> { return inner.stream({ ...req, messages: req.messages.map((m) => (typeof m.content === "string" ? { ...m, content: redactSecrets(m.content) } : m)) }); } };
}
