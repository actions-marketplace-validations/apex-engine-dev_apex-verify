import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The version in package.json next to the running file (dist/main.js, or dist/apex.mjs in the release bundle). */
export const VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version as string;
