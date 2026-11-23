# Security

The engine runs model-written code (tests and checks) on a copy of your project. **Isolation is limited:** the sandboxes are best effort, not a security boundary: on macOS the test run uses a Seatbelt profile (open reads, only credential folders denied, no outbound network except localhost). On Linux bubblewrap isolates it, and on Windows an AppContainer does (the CLI prints `sandbox: ...` for the one in use); where none is available the code runs as you. In every case the environment is scrubbed (variables that look like keys, tokens or passwords are removed). Run the engine in a container or a throwaway checkout for projects you do not trust. The CLI prints which mode is active. Report privately, not in a public issue: https://github.com/apex-engine-dev/apex-verify/security/advisories/new

In scope: a sandbox escape in the test runner, a write outside the project copy, leaking files the project asked to hide into a prompt, secrets in output, a profile or task that executes code at validation time, a validator bypass.
Out of scope: the model producing bad code (that is what the proof is for).

Include the version, a synthetic reproduction and the platform. Supported: the latest release.
