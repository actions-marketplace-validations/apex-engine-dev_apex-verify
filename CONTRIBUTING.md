# Contributing

Thank you. Read the [Code of Conduct](CODE_OF_CONDUCT.md) first.

## Setup

Node >= 20.

```sh
git clone <your fork> && cd reallydone
npm install
npm run build
npm test
```

## Ways to help

- **Break it.** Find a change `reallydone verify` calls `ready` that is wrong, or blocks one that is right ([issue templates](https://github.com/apex-engine-dev/apex-verify/issues/new/choose)). Add it to `benchmark/` as a labelled change if you can.
- **Languages and test runners:** write checks for Jest/Vitest, Go, Rust (today: node:test and pytest); better detection of a project's own tests. See issues labelled `good first issue`.
- **Integrations:** try the Codex, Cursor or Gemini CLI hook or an MCP client and fix the documented configuration ([docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)). Windows support.
- **Measurements:** a checker from another vendor, bigger real projects, more labelled changes (`benchmark/README.md`).
- **Sandboxing and safety:** locked tests, signed evidence ([docs/RELATED-WORK.md](docs/RELATED-WORK.md) lists who does what).

## Ground rules

- A change to what the gate decides, or to what is sent to a model, needs a measured reason: run `node benchmark/run-gate.mjs` before and after, and show the numbers (catch rate *and* false-alarm rate). No claims without numbers.
- Every use case the README claims has a test (`docs/USE-CASES.md`). A new claim needs one; a claim we cannot test is marked "not tested".
- No telemetry, no network calls except to the model endpoint you configure.
- Never commit real prompts, keys, file paths or personal data. Tests use synthetic fixtures.

## Sign-off (DCO)

Contributions come under the project's licence, Apache-2.0 (see [LICENSE](LICENSE)), inbound and outbound, with a [Developer Certificate of Origin](https://developercertificate.org) sign-off: every commit carries `Signed-off-by: Your Name <you@example.com>` (`git commit -s`), which says you wrote it or have the right to submit it. You keep your copyright. CI checks the sign-off. There is no separate contributor agreement.

## Pull requests

One topic each. Run `npm test`. Fill in the template, including what you verified live and what only tests cover.
