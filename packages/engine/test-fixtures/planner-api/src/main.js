import http from "node:http";
import { createRouter } from "./server.js";
import { createStore } from "./tasks/store.js";
import { send } from "./http/respond.js";
import { seedTasks } from "./seed.js";

const PORT = Number(process.env.PORT || 4100);
const route = createRouter(createStore(seedTasks()));

const server = http.createServer(async (req, res) => {
  try {
    const body = req.method === "GET" ? {} : await readJson(req);
    send(res, await route(req.method, req.url, req.headers, body));
  } catch (err) {
    send(res, { status: err.status || 500, body: { error: err.status ? err.message : "Something went wrong." } });
  }
});

server.listen(PORT, () => console.log(`planner-api listening on http://localhost:${PORT}`));

async function readJson(req) {
  let text = "";
  for await (const chunk of req) text += chunk;
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("Body must be JSON."), { status: 400 });
  }
}
