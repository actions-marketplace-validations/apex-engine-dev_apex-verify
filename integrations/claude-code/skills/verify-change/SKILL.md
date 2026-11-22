---
name: verify-change
description: Before telling the user a coding task is done, check the change with ReallyDone. Use after making or finishing code changes, when the user asks "is it really done", or when about to claim the work is complete.
---

# Verify the change before saying it is done

When you have finished a code change, do not just say it is done. Check it:

1. Call the `verify_change` tool from the `reallydone` MCP server with the user's request as `task` (their words, not yours).
2. Read the verdict.
   - **READY**: say so, and mention what was checked.
   - **NOT READY**: the result names the failing check, the expected and actual values, and a fix hint. Fix the *code* (never delete, skip or weaken a test), then verify again.
   - **UNKNOWN**: say plainly that the change could not be independently checked and why; do not describe it as verified.
3. Never claim success on a NOT READY or UNKNOWN verdict.

If the tool is unavailable, run `npx --yes https://github.com/apex-engine-dev/apex-done-checker/releases/latest/download/reallydone.tgz verify "<the user's request>"` in the project folder and read its output the same way.
