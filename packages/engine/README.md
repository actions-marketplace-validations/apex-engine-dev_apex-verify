# apex-verify-engine

The verification engine behind `apex verify`: it writes and runs checks in a scratch copy of a project, runs the project's own tests, and decides what counts as proof. See the [repository README](../../README.md) and [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

What `apex verify` uses:
- **The proof gate** (`proof-gate.ts`): `draftAcceptance` (a model writes a check file from the task), `runAcceptance` (runs it on a copy). A check that also passes on the old code proves nothing.
- **Test running** (`test-runner.ts`): detects a project's test command, runs it, reads the output, and sandboxes it: macOS Seatbelt, Linux bubblewrap (both tested in CI).
- **Reading results** (`check-results.ts`, `check-screen.ts`): which check results count, and which failures are the check's fault.
- **Helpers** in `surgical.ts` (project context, copying a project, running tests), `mechanical.ts` (reading which functions a request names) and `graph.ts`/`scoped-context.ts`/`symbols.ts` (choosing which parts of a project go into the context; they can read a code graph, but the code that builds one is not in this repository, so `apex verify` runs without it).

The engine was extracted from a larger project that also has a code-writing loop. That loop, and everything else `apex verify` cannot reach, is removed from this repository when it is published: what is here is what the command uses.

Seams: `ModelClient` (one method, `stream(request)`), `Workspace` (file access), `EngineOptions`.

Not on npm: use it from the repository (`npm install`).
