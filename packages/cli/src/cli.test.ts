import { test } from "node:test";
import assert from "node:assert/strict";
import { openAiClient } from "./openai-client.js";

test("openAiClient streams text and usage from an SSE body", async () => {
  const sse = ['data: {"choices":[{"delta":{"content":"he"}}]}', 'data: {"choices":[{"delta":{"content":"llo"},"finish_reason":"stop"}]}', 'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}', "data: [DONE]", ""].join("\n");
  const c = openAiClient({ baseUrl: "http://x/v1", fetchImpl: (async () => new Response(sse)) as typeof fetch });
  const ev = [];
  for await (const e of c.stream({ messages: [{ id: "1", role: "user", content: "hi", createdAt: "" }], tools: [], model: "m" })) ev.push(e);
  assert.equal(ev.filter((e) => e.type === "text-delta").map((e: any) => e.text).join(""), "hello");
  assert.deepEqual(ev.find((e) => e.type === "usage"), { type: "usage", inputTokens: 5, outputTokens: 2 });
  assert.equal(ev.at(-1)?.type, "done");
});

test("openAiClient reports an HTTP error as an error event", async () => {
  const c = openAiClient({ baseUrl: "http://x/v1", fetchImpl: (async () => new Response("nope", { status: 401 })) as typeof fetch });
  const ev = [];
  for await (const e of c.stream({ messages: [], tools: [], model: "m" })) ev.push(e);
  assert.equal(ev[0]?.type, "error");
});

