# Open issues

## #1 Adding a task gives it an id another task already has

**Reported by:** dana · **Labels:** bug

Steps:
1. Start the server (`npm start`). It starts with the demo tasks (ids 3, 5, 8, 12).
2. Sign in as `dana` and add a task with `POST /api/tasks`.
3. `GET /api/tasks`.

Expected: the new task has an id no other task has.
Actual: the new task comes back with id `5`, the same as "Review the onboarding copy". Marking the new task done (`POST /api/tasks/5/done`) marks the old one done instead.

When the store is created with tasks that already have ids, adding a new task can give it an id that another task already has, so two tasks share an id. The tests pass because they never seed ids.

## #2 Feature: a "Today" endpoint

**Reported by:** omer · **Labels:** feature

Add a "Today" API to this planner.

`GET /api/today` returns the signed-in user's tasks for today: tasks that are not done and are due today in the user's own time zone, plus overdue tasks that are not done. Sort by priority (high, then medium, then low), then by due time. Add `overdue: true` to tasks due before today and `overdue: false` to the others. Requests without a valid sign-in get 401.

Put the logic in `todayTasks(store, session, now)` exported from `src/today.js` (`session` is what `verifySession` returns; it returns the list), and register the route in `src/server.js`.

## #3 Review request: src/auth/session.js

**Reported by:** security review rota · **Labels:** review

We added session expiry last sprint (8 hours). Please review `src/auth/session.js` before we ship: is expiry actually enforced, and is anything else off?
