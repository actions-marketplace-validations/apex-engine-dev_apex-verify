# planner-api

The Sample Co planner's back end: a small task API with sign-in and per-user time zones.
Plain Node 20+, ES modules, no dependencies.

## Run

```sh
cp .env.example .env   # optional; PORT defaults to 4100
npm start              # node src/main.js
npm run dev            # restarts on file changes
```

The server starts with a few demo tasks for the users `dana` and `omer`.

## Try it

```sh
TOKEN=$(curl -s -X POST localhost:4100/api/sessions -d '{"userId":"dana","timeZone":"Asia/Jerusalem"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s localhost:4100/api/tasks -H "Authorization: Bearer $TOKEN"
curl -s -X POST localhost:4100/api/tasks -H "Authorization: Bearer $TOKEN" -d '{"title":"Call the venue","due":"2026-11-20T10:00:00Z","priority":"high"}'
```

## API

| Method | Path | What it does |
| --- | --- | --- |
| POST | /api/sessions | Sign in with `{ userId, timeZone }`; returns `{ token }` |
| DELETE | /api/sessions | Sign out the bearer token |
| GET | /api/tasks | The signed-in user's tasks |
| POST | /api/tasks | Add `{ title, due, priority? }` |
| POST | /api/tasks/:id/done | Mark a task done |

A task looks like `{ id, userId, title, due, priority: "high" | "medium" | "low", done }`, with `due` an ISO date.

## Test

```sh
npm test   # node --test
```

## Layout

- `src/main.js` starts the HTTP server; `src/server.js` is the router.
- `src/auth/session.js` sign-in sessions (user id + IANA time zone).
- `src/tasks/` the store and priority sorting; `src/time/zone.js` calendar days per time zone.
- `src/http/respond.js` response helpers.
- `fixtures/private/` customer data for local testing; it is hidden from the AI by `.apexignore`.

Open issues are in `ISSUES.md`. License: MIT.
