import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify as cryptoVerify } from "node:crypto";
import fs from "node:fs";
import type { VerifyReport } from "./verify.js";

/**
 * Signed reports. The signature covers the verdict, the task and the report's `proof` (a hash of the changed files, the
 * checks, the test results and the verdict), so a report cannot be edited afterwards without breaking it. Ed25519, keys
 * from node:crypto. Whoever holds the private key must be outside the agent's reach (a CI secret, not the project folder).
 */
export interface Signature { alg: "ed25519"; publicKey: string; value: string }
const payload = (r: Pick<VerifyReport, "verdict" | "task" | "proof">) => Buffer.from(JSON.stringify({ v: 1, verdict: r.verdict, task: r.task, proof: r.proof }));

/** Writes a new private key (PEM, mode 600) and returns the public key as base64 (share this one). */
export function generateKey(file: string): string {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  fs.writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  return publicKey.export({ type: "spki", format: "der" }).toString("base64");
}

export function signReport(r: VerifyReport, keyFile: string): Signature {
  const priv = createPrivateKey(fs.readFileSync(keyFile));
  const pub = createPublicKey(priv).export({ type: "spki", format: "der" }).toString("base64");
  return { alg: "ed25519", publicKey: pub, value: sign(null, payload(r), priv).toString("base64") };
}

/** Whether the report's signature is valid; with `expectedPublicKey` also whether it was signed by that key. */
export function checkReport(r: VerifyReport & { signature?: Signature }, expectedPublicKey?: string): { ok: boolean; reason: string } {
  const s = r.signature;
  if (!s || s.alg !== "ed25519") return { ok: false, reason: "the report is not signed" };
  if (expectedPublicKey && expectedPublicKey.trim() !== s.publicKey) return { ok: false, reason: "signed by a different key than the one you expected" };
  try {
    const pub = createPublicKey({ key: Buffer.from(s.publicKey, "base64"), format: "der", type: "spki" });
    return cryptoVerify(null, payload(r), pub, Buffer.from(s.value, "base64")) ? { ok: true, reason: `signature valid (${r.verdict})` } : { ok: false, reason: "the signature does not match the report: it was changed after signing" };
  } catch (e) { return { ok: false, reason: `unreadable signature: ${e instanceof Error ? e.message : String(e)}` }; }
}
