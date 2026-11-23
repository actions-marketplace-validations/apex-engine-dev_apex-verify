import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify as cryptoVerify } from "node:crypto";
import fs from "node:fs";
import type { VerifyReport } from "./verify.js";

/**
 * Signed reports. The signature covers the whole report (verdict, reasons, warnings, tests, checks, proof), so nothing in
 * it can be edited afterwards without breaking it. Ed25519, keys
 * from node:crypto. Whoever holds the private key must be outside the agent's reach (a CI secret, not the project folder).
 */
export interface Signature { alg: "ed25519"; publicKey: string; value: string }
/** Key order does not matter: the report is serialised with sorted keys, without its own signature. */
const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as any)[k])])) : v);
const payload = (r: VerifyReport) => { const { signature: _sig, ...rest } = r as VerifyReport & { signature?: unknown }; return Buffer.from(JSON.stringify({ v: 2, report: canon(rest) })); };

/** Writes a new private key (PEM, mode 600) and returns the public key as base64 (share this one). */
export function generateKey(file: string): string {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  if (fs.existsSync(file)) throw new Error(`${file} already exists: refusing to overwrite it (a key file left over from before may have looser permissions)`);
  fs.writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  return publicKey.export({ type: "spki", format: "der" }).toString("base64");
}

export function signReport(r: VerifyReport, keyFile: string): Signature {
  const priv = createPrivateKey(fs.readFileSync(keyFile));
  const pub = createPublicKey(priv).export({ type: "spki", format: "der" }).toString("base64");
  return { alg: "ed25519", publicKey: pub, value: sign(null, payload(r), priv).toString("base64") };
}

/**
 * Whether the report is signed by the key you trust. A signature proves only that SOME key signed it: anyone can sign a
 * forged report with their own key. So without `expectedPublicKey` this is never ok, and the reason names the signer so
 * you can pin it (`allowAnyKey` accepts it anyway, for a quick look).
 */
export function checkReport(r: VerifyReport & { signature?: Signature }, expectedPublicKey?: string, allowAnyKey = false): { ok: boolean; reason: string } {
  const s = r.signature;
  if (!s || s.alg !== "ed25519") return { ok: false, reason: "the report is not signed" };
  let valid = false;
  try {
    const pub = createPublicKey({ key: Buffer.from(s.publicKey, "base64"), format: "der", type: "spki" });
    valid = cryptoVerify(null, payload(r), pub, Buffer.from(s.value, "base64"));
  } catch (e) { return { ok: false, reason: `unreadable signature: ${e instanceof Error ? e.message : String(e)}` }; }
  if (!valid) return { ok: false, reason: "the signature does not match the report: it was changed after signing" };
  if (expectedPublicKey) return expectedPublicKey.trim() === s.publicKey ? { ok: true, reason: `signature valid, signed by the key you trust (${r.verdict})` } : { ok: false, reason: "valid, but signed by a different key than the one you expected" };
  return allowAnyKey ? { ok: true, reason: `signature valid, signer NOT checked (${r.verdict}); key ${s.publicKey}` } : { ok: false, reason: `the signature is valid but anyone can sign a report with their own key; pass --pub-key <the key you trust> (this report was signed by ${s.publicKey})` };
}
