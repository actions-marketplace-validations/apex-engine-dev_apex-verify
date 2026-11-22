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

## Locked tests and signed evidence
`--lock-tests` (verify.ts, `lockedTests`): before the cheating scan and the test run, every test file the change edited or deleted is restored in the copy from the base version, so the project's own tests are the base's tests plus any new ones. `--sign-key` (sign.ts): an Ed25519 signature over `{verdict, task, proof}` where `proof` is a SHA-256 of the changed files' hashes, the checks' code, the test and check results and the verdict. `--check-report` verifies it. What this does not do: it does not protect a key stored where the agent can read it, and it does not pin the checker model's configuration (pin the Action version and keep the workflow on the base branch).
