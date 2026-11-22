# planner-api rules

- ES modules only (`import`/`export`), Node 20+.
- No dependencies. Use Node's built-ins (`node:http`, `node:crypto`, `node:test`).
- Tests live in `tests/` and use `node:test` with `node:assert/strict`. Run them with `npm test`.
- Keep functions small and single-purpose; put route logic in its own function, not inline in the route table.
- Times are ISO strings. Anything about "today" or "overdue" must use the user's time zone via `src/time/zone.js`.
- Never read or copy files under `fixtures/private/`.
