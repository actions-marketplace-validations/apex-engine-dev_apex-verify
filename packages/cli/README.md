# reallydone (the command line)

`reallydone verify`: is an AI's change really done? Any agent's change in, `ready` / `not ready` / `unknown` out, with proof. See the [repository README](../../README.md) for what it does, the measured results and the caveats.

```sh
export GEMINI_API_KEY=...                 # the model that writes the checks (use a different one than your agent)
reallydone verify "what the change should do"   # in a git repo with the AI's uncommitted change; or --base <ref>, or --diff <file>
reallydone verify "..." --no-model              # tests, type check and cheating scan only; no key
reallydone verify "..." --format markdown       # a pull request comment; also json, sarif, text
reallydone verify --hook                        # as an agent's Stop hook (Claude Code, Codex); see docs/INTEGRATIONS.md
reallydone verify --mcp                         # as an MCP server (tool: verify_change)
```

Exit codes: `0` ready, `1` not ready, `3` unknown, `2` usage or setup error. `reallydone --help` lists every flag; environment equivalents for hooks and CI: `REALLYDONE_CHECKER_MODEL`, `REALLYDONE_PROVIDER`, `REALLYDONE_BASE_URL`, `REALLYDONE_API_KEY_ENV`, `REALLYDONE_MODE=warn`.

Install without npm: `npx --yes https://github.com/apex-engine-dev/apex-done-checker/releases/latest/download/reallydone.tgz verify "<task>"`. As a library: `import { verify } from "reallydone-cli"` (see `src/index.ts`).

Files: `verify.ts` (the gate), `cheats.ts` (the scan), `report.ts` (formats), `verify-cmd.ts` (arguments), `hook.ts`, `mcp.ts`, `providers.ts`, `openai-client.ts`. End-to-end tests: `e2e.test.ts`.
