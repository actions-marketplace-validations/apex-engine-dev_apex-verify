# Security

The engine runs model-written code (tests and checks) on a copy of your project. **Isolation is limited:** on macOS the test run uses a Seatbelt sandbox profile that is best effort, not a security boundary (open reads, only credential folders denied, no outbound network except localhost). On Linux there is no sandbox: that code runs as you with a scrubbed environment (variables that look like keys, tokens, passwords are removed). Run the engine in a container or a throwaway checkout for projects you do not trust. The CLI prints which mode is active. Report privately, not in a public issue: https://github.com/apex-engine-dev/apex-done-checker/security/advisories/new

In scope: a sandbox escape in the test runner, a write outside the project copy, leaking files the project asked to hide into a prompt, secrets in output, a profile or task that executes code at validation time, a validator bypass.
Out of scope: the model producing bad code (that is what the proof is for).

Include the version, a synthetic reproduction and the platform. Supported: the latest release.
