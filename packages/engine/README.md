# apex-verify-engine

The verification engine behind `apex verify`: it writes and runs checks in a scratch copy of a project, runs the project's own tests, and decides what counts as proof. See the [repository README](../../README.md) and [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

What `apex verify` uses:
- **The proof gate** (`proof-gate.ts`): `draftAcceptance` (a model writes a check file from the task), `runAcceptance` (runs it on a copy). A check that also passes on the old code proves nothing.
- **Test running** (`test-runner.ts`): detects a project's test command, runs it, reads the output, and sandboxes it: macOS Seatbelt, Linux bubblewrap (both tested in CI).
- **Reading results** (`check-results.ts`, `check-screen.ts`): which check results count, and which failures are the check's fault.
- **Helpers** in `surgical.ts` (project context, copying a project, running tests) and `graph.ts`/`scoped-context.ts` (a code graph, used when [Graphify](https://pypi.org/project/graphifyy/) is installed).

The engine is shared with a separate commercial product (an IDE with a code-writing agent loop), so it also contains that loop (`surgical.ts`'s best-of-n versions step, `verified.ts`). `apex verify` does not use it, and it is not part of what this repository supports.

Seams: `ModelClient` (one method, `stream(request)`), `Workspace` (file access), `EngineOptions`.

Not on npm: use it from the repository (`npm install`).
