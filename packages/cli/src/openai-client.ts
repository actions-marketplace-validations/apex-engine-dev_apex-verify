import type { ModelClient, ModelEvent, ModelRequest } from "reallydone-engine";

export interface OpenAiClientOptions {
  /** Base URL of an OpenAI-compatible API, e.g. https://api.openai.com/v1. */
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

/** A ModelClient over any OpenAI-compatible chat-completions endpoint (OpenAI, Gemini, ...). */
export function openAiClient(o: OpenAiClientOptions): ModelClient {
  const doFetch = o.fetchImpl ?? fetch;
  return {
    async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
      const body: Record<string, unknown> = {
        model: req.model,
        stream: true,
        stream_options: { include_usage: true },
        messages: req.messages.map((m) => ({ role: m.role === "tool" ? "user" : m.role, content: m.content })),
      };
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.maxTokens) body.max_tokens = req.maxTokens;
      if (req.stop?.length) body.stop = req.stop.slice(0, 4);
      let res: Response;
      try {
        res = await doFetch(`${o.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}) },
          body: JSON.stringify(body),
          signal: req.signal,
        });
      } catch (e) {
        yield { type: "error", message: e instanceof Error ? e.message : String(e) };
        return;
      }
      if (!res.ok || !res.body) {
        yield { type: "error", message: `HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}` };
        return;
      }
      const dec = new TextDecoder();
      let buf = "";
      let full = "";
      let truncated = false;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let j: any;
          try { j = JSON.parse(data); } catch { continue; }
          const delta = j.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) { full += delta; yield { type: "text-delta", text: delta }; }
          if (j.choices?.[0]?.finish_reason === "length") truncated = true;
          if (j.usage) yield { type: "usage", inputTokens: j.usage.prompt_tokens, outputTokens: j.usage.completion_tokens };
        }
      }
      if (truncated) yield { type: "truncated" };
      yield { type: "message-complete", message: { content: full } };
      yield { type: "done" };
    },
  };
}
