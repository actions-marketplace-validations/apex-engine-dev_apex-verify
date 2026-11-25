# Security

The engine runs model-written code (tests and checks) on a copy of your project. **Isolation is limited:** the sandboxes are best effort, not a security boundary: on macOS the test run uses a Seatbelt profile (open reads, only credential folders denied, no outbound network except localhost). On Linux bubblewrap isolates it, and on Windows an AppContainer does (the CLI prints `sandbox: ...` for the one in use); where none is available the code runs as you. In every case the environment is scrubbed (variables that look like keys, tokens or passwords are removed). Run the engine in a container or a throwaway checkout for projects you do not trust. The CLI prints which mode is active. Report privately, not in a public issue: https://github.com/apex-engine-dev/apex-verify/security/advisories/new

In scope: a sandbox escape in the test runner, a write outside the project copy, leaking files the project asked to hide into a prompt, secrets in output, a profile or task that executes code at validation time, a validator bypass.
Out of scope: the model producing bad code (that is what the proof is for).

Include the version, a synthetic reproduction and the platform. Supported: the latest release.

## What Apex verify does not defend against (threat model)

- **A verdict is evidence, not a guarantee.** The checks are written by a model from the task text, so a task (or pull request description) written to mislead the checker can make a wrong change look `ready`. Treat `ready` on a change from an untrusted author as one signal next to review and CI, and run the Action from your base branch's workflow.
- **The checker sees an excerpt of your project.** Up to about 24 KB of relevant files and the change go to the model you configure. Secret-looking files are not offered and key-shaped strings are redacted, but that is a safety net: do not point it at a project whose source you may not share with that provider.
- **The sandboxes are best effort.** They limit writes and the network for generated checks and your tests (see docs/SANDBOX.md); reads are mostly open on macOS, and Windows has no localhost. For code you do not trust, use a container or VM.
- **The Action keeps drafted checks between re-runs of one commit.** They are stored with GitHub's cache and signed with the checker's API key; unsigned or altered entries are ignored. Anyone who can read that key (a collaborator with write access) could forge an entry, as they could change the workflow itself. A stable verdict is not a more correct one: re-running no longer changes the answer, right or wrong.
- **A shown failure can be gamed.** The stop hook returns the failing check to the agent, which may special-case it instead of fixing the cause; the 3-block cap and `--lock-tests` limit the damage, and measuring it is open (issue #22).
