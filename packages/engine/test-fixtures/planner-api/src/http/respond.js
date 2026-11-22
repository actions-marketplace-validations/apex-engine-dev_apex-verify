/** Router responses: { status, body }. The server turns these into JSON replies. */
export const ok = (body) => ({ status: 200, body });
export const created = (body) => ({ status: 201, body });
export const badRequest = (error) => ({ status: 400, body: { error } });
export const unauthorized = () => ({ status: 401, body: { error: "Sign in first." } });
export const notFound = () => ({ status: 404, body: { error: "Not found." } });

/** Writes a router response to a node:http ServerResponse. */
export function send(res, { status, body }) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}
