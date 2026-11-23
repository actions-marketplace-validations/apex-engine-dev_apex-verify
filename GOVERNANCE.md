# Governance

## Scope
This repository is the open project: `apex verify` (CLI, stop hook, MCP server, GitHub Action, Claude Code plugin), the verification engine it uses, and the benchmark that measures it.

## Decisions
Maintainers decide in pull request review: one maintainer approval and passing CI for ordinary changes. Changes to what the engine sends to a model, to the proof rules (what counts as `ready`), to the licence or to this document need two maintainers (or the only maintainer, after the proposal has been open a week), with the measured evidence in the thread.

## Profiles
A profile is accepted when the validator passes. It becomes `verified` when a second contributor reproduces it. A maintainer may remove a profile found to be wrong or unreproducible, with the reason in the pull request.

## Maintainers
Listed in the repository settings. To become one: steady contribution over several months (code, review, profiles, tasks, triage). Current maintainers approve by consensus. Inactive maintainers move to emeritus and can return on request. Until there are at least two maintainers the project says so in README status.

## Licence and contributions
Apache-2.0 (see LICENSE). Contributions come under the Developer Certificate of Origin: a `Signed-off-by` on each commit; contributors keep their copyright. The Apex verify name and logo are the maintainers' to protect (TRADEMARKS.md).
