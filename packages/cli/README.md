# apex (the command line)

`apex verify`: is an AI's change really done? Any agent's change in, `ready` / `not ready` / `unknown` out, with proof. See the [repository README](../../README.md) for what it does, the measured results and the caveats.

```sh
export GEMINI_API_KEY=...                 # the model that writes the checks (use a different one than your agent)
apex verify "what the change should do"   # in a git repo with the AI's uncommitted change; or --base <ref>, or --diff <file>
apex verify "..." --no-model              # tests, type check and cheating scan only; no key
apex verify "..." --format markdown       # a pull request comment; also json, sarif, text
apex verify --hook                        # as an agent's Stop hook (Claude Code, Codex); see docs/INTEGRATIONS.md
apex verify --mcp                         # as an MCP server (tool: verify_change)
```

Exit codes: `0` ready, `1` not ready, `3` unknown, `2` usage or setup error. `apex --help` lists every flag; environment equivalents for hooks and CI: `APEX_CHECKER_MODEL`, `APEX_PROVIDER`, `APEX_BASE_URL`, `APEX_API_KEY_ENV`, `APEX_MODE=warn`.

Install without npm: `npx --yes https://github.com/apex-engine-dev/apex-verify/releases/latest/download/apex-verify.tgz verify "<task>"`. As a library: `import { verify } from "apex-verify-cli"` (see `src/index.ts`).

Files: `verify.ts` (the gate), `cheats.ts` (the scan), `report.ts` (formats), `verify-cmd.ts` (arguments), `hook.ts`, `mcp.ts`, `providers.ts`, `openai-client.ts`. End-to-end tests: `e2e.test.ts`.
