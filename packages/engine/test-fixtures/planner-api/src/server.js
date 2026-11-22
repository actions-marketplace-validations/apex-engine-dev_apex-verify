import { createSession, endSession, sessionFromHeaders } from "./auth/session.js";
import { isPriority } from "./tasks/priority.js";
import { isTimeZone } from "./time/zone.js";
import { ok, created, badRequest, unauthorized, notFound } from "./http/respond.js";

/**
 * The app's router. Returns an async function (method, path, headers, body) => { status, body }.
 * Routes are registered in the table below; each handler gets { headers, body, params }.
 */
export function createRouter(store) {
  const routes = {
    "POST /api/sessions": signIn,
    "DELETE /api/sessions": signOut,
    "GET /api/tasks": signedIn((session) => ok(store.forUser(session.userId))),
    "POST /api/tasks": signedIn((session, { body }) => addTask(store, session, body)),
    "POST /api/tasks/:id/done": signedIn((session, { params }) => completeTask(store, session, params.id)),
  };
  return async (method, path, headers = {}, body = {}) => {
    const found = match(routes, method, path);
    return found ? found.handler({ headers, body: body || {}, params: found.params }) : notFound();
  };
}

function signIn({ body }) {
  if (!body.userId) return badRequest("userId is required.");
  const timeZone = body.timeZone || "UTC";
  if (!isTimeZone(timeZone)) return badRequest(`Unknown time zone: ${timeZone}`);
  return created({ token: createSession(String(body.userId), timeZone), userId: String(body.userId), timeZone });
}

function signOut({ headers }) {
  const m = /^Bearer\s+(.+)$/i.exec(headers.authorization || "");
  return ok({ signedOut: m ? endSession(m[1].trim()) : false });
}

/** Wraps a handler so it only runs for a signed-in request. */
function signedIn(handler) {
  return (request) => {
    const session = sessionFromHeaders(request.headers);
    return session ? handler(session, request) : unauthorized();
  };
}

function addTask(store, session, body) {
  if (!body.title || typeof body.title !== "string") return badRequest("title is required.");
  if (!body.due || Number.isNaN(Date.parse(body.due))) return badRequest("due must be an ISO date.");
  if (body.priority !== undefined && !isPriority(body.priority)) return badRequest("priority must be high, medium or low.");
  const task = { userId: session.userId, title: body.title.trim(), due: body.due };
  if (body.priority) task.priority = body.priority;
  return created(store.add(task));
}

function completeTask(store, session, id) {
  const task = store.complete(session.userId, id);
  return task ? ok(task) : notFound();
}

/** Finds the route for "METHOD /path"; ":name" segments are captured into params. */
function match(routes, method, path) {
  const parts = path.split("?")[0].split("/");
  for (const [key, handler] of Object.entries(routes)) {
    const [m, pattern] = key.split(" ");
    const want = pattern.split("/");
    if (m !== method || want.length !== parts.length) continue;
    const params = {};
    if (want.every((seg, i) => (seg.startsWith(":") ? ((params[seg.slice(1)] = decodeURIComponent(parts[i])), true) : seg === parts[i]))) {
      return { handler, params };
    }
  }
  return null;
}
