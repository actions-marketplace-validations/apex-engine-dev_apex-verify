# Codex stop-hook: what is tested, and what is not (2026-11-23)

Contributed by HiZhenyu (pull request #18); status wording kept by the maintainer.

**What is tested.** The CLI end-to-end suite (`packages/cli/src/e2e.test.ts`) sends the stop-hook JSON contract (`cwd`, `transcript_path`, `session_id`) to `apex verify --hook` against a real changed checkout with a deliberately wrong change, and observes `decision: "block"` with the failing check in `reason`. It also checks that the hook stops blocking after its limit. Cursor's `workspace_roots` and `followup_message` contract is covered by the adjacent test.

Run from the repository root:

```sh
npm install
npm run build
node --test packages/cli/dist/e2e.test.js
```

**What is not tested.** This is the protocol with synthetic input. The hook has **not been run inside Codex or Cursor**. Codex ignores project hooks until they are reviewed and trusted once (`/hooks`), and a maintainer run stopped there. A real run, with the app version and what it printed, would replace this note.
