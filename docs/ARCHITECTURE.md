# Architecture

```
task + the change (git working copy, a branch, or a diff file)
   |
   v   two scratch copies: before and after. Your project is never written.
cheating scan        deleted / skipped / focused tests, a test script that cannot fail, agent config edits (deterministic)
   |
   v
your tests + type check   run before and after; only what the change broke counts (sandboxed where Apex verify can: macOS Seatbelt, Linux bubblewrap)
   |
   v
independent checks   a different model writes a test file from the task text only (never the agent's own tests);
                     it runs on the OLD code first (a check that passes there proves nothing), then on the new code
   |
   v
verdict              ready | not_ready | unknown, with the failing check (expected vs actual), a fix hint, a proof digest
                     output: text, JSON, Markdown (PR comment), SARIF; exit codes 0 / 1 / 3
```

Where the code is:
- `packages/cli/src/verify.ts` the gate; `cheats.ts` the scan; `report.ts` the output formats; `verify-cmd.ts` the command line; `hook.ts` the agent stop hook; `mcp.ts` the MCP server.
- `packages/engine/src/proof-gate.ts` writes and runs the checks (`draftAcceptance`, `runAcceptance`); `test-runner.ts` detects and runs your tests and holds the sandbox; `check-results.ts` and `check-screen.ts` read test output and decide which check results count; `surgical.ts` holds helpers the gate uses (context, running tests, copying a project).
- The engine is shared with a separate commercial product (an IDE with an agent loop), so it contains more than `verify` uses: the code-writing loop in `surgical.ts` and `verified.ts` is not used by `apex verify`.

Rules worth knowing:
- A check that also passes on the unchanged project proves nothing: the verdict is at most `unknown`.
- If no checks could be written, or nothing ran, the verdict is at most `unknown`, never `ready`.
- A failing check that a second look judges to be wrong (not the change) gives `unknown`, not `not_ready`. The second look can only soften a block, never turn a failure into a pass.
- The same task on the same starting code with the same checker model reuses its checks (cached outside your project), so an agent that retries sees stable checks and you pay for one model call.
- The only things sent to the checker model: the task and a budgeted excerpt (about 24 KB) of relevant files. No telemetry.
