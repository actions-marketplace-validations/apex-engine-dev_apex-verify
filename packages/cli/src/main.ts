#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseVerifyArgs, runVerify, VERIFY_USAGE } from "./verify-cmd.js";
import { runHook } from "./hook.js";
import { runMcp } from "./mcp.js";

const VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "package.json"), "utf8")).version as string;

const USAGE = VERIFY_USAGE.replace(/^apex verify /, "apex [verify] ");

async function main(argv: string[]): Promise<number> {
  // `apex verify ...` and `apex ...` are the same: verify is the only command.
  const rest = argv[0] === "verify" ? argv.slice(1) : argv;
  if (!rest.length || rest.includes("--help") || rest.includes("-h") || rest[0] === "help") { console.log(USAGE); return 0; }
  if (rest.includes("--version") || rest.includes("-v")) { console.log(VERSION); return 0; }
  if (rest.includes("--hook")) { const chunks: Buffer[] = []; for await (const c of process.stdin) chunks.push(c as Buffer); return runHook(Buffer.concat(chunks).toString("utf8")); }
  if (rest.includes("--mcp")) { await runMcp(); return 0; }
  return runVerify(parseVerifyArgs(rest));
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  console.error("Run apex --help for usage.");
  process.exitCode = 2;
}
