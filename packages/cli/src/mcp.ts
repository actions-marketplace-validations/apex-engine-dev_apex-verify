import readline from "node:readline";
import { parseVerifyArgs } from "./verify-cmd.js";
import { verify } from "./verify.js";
import { openAiClient } from "./openai-client.js";
import { renderMarkdown } from "./report.js";

/**
 * A minimal MCP server over stdio (JSON-RPC, one message per line) with one tool, verify_change. Any MCP client (Claude
 * Code, Codex, Cursor, Gemini CLI) can call it to ask "is this change really done?" before it says done.
 */
const TOOL = {
  name: "verify_change",
  description: "Check whether the change made in a project (git working copy vs a base) really does what the task says. An independent model writes checks from the task, proves they fail on the old code, and runs them with the project's tests on the new code. Returns READY, NOT READY (with the failing check and a fix hint) or UNKNOWN. Call it before saying a task is done.",
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", description: "What the change was supposed to do, in the user's words." },
      dir: { type: "string", description: "The project folder (default: the server's working directory)." },
      base: { type: "string", description: "Git ref to compare with (default HEAD)." },
    },
    required: ["task"],
  },
};

export async function handle(msg: any, env: NodeJS.ProcessEnv = process.env): Promise<any | null> {
  const id = msg.id;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  switch (msg.method) {
    case "initialize": return ok({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "apex", version: "0.2.0" } });
    case "ping": return ok({});
    case "tools/list": return ok({ tools: [TOOL] });
    case "tools/call": {
      if (msg.params?.name !== TOOL.name) return fail(-32602, `unknown tool ${msg.params?.name}`);
      const args = msg.params.arguments ?? {};
      try {
        const a = parseVerifyArgs([String(args.task ?? ""), "--dir", String(args.dir ?? process.cwd()), "--quiet", ...(args.base ? ["--base", String(args.base)] : []), ...(env.APEX_NO_MODEL === "1" ? ["--no-model"] : [])], env);
        const checker = a.noModel ? null : { client: openAiClient({ baseUrl: a.baseUrl, apiKey: a.apiKey }), model: a.model! };
        const report = await verify({ dir: a.dir, task: a.task, base: a.base, checker, timeoutSec: a.timeoutSec });
        return ok({ content: [{ type: "text", text: renderMarkdown(report) }], structuredContent: report, isError: false });
      } catch (e) { return ok({ content: [{ type: "text", text: `apex verify could not run: ${e instanceof Error ? e.message : String(e)}` }], isError: true }); }
    }
    default: return id === undefined ? null : fail(-32601, `method not found: ${msg.method}`);
  }
}

export function runMcp(input: NodeJS.ReadableStream = process.stdin, write: (s: string) => void = (s) => process.stdout.write(s)): Promise<void> {
  const rl = readline.createInterface({ input });
  const pending: Promise<void>[] = [];
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: any; try { msg = JSON.parse(line); } catch { return; }
    pending.push(handle(msg).then((r) => { if (r) write(JSON.stringify(r) + "\n"); }));
  });
  return new Promise((resolve) => rl.on("close", () => { void Promise.all(pending).then(() => resolve()); }));
}
