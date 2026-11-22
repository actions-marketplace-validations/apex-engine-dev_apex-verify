/**
 * The model seam. The engine never imports a provider or the app's shared types: it speaks to a `ModelClient`, an
 * object with one streaming method, and these small request/event types. The Apex app passes its gateway through a
 * thin adapter (ai-runtime/engine-adapter.ts) that hands the same objects across unchanged; a third party writes
 * a `ModelClient` over any API that can stream text.
 *
 * The request carries exactly the fields the engine has always sent (system and user messages, temperature, token
 * and thinking budgets, stop strings, a cache slot, the project scope): changing them changes what a model is asked.
 */
export type ModelRole = "system" | "user" | "assistant" | "tool";

/** One chat message. `id` and `createdAt` are carried because gateways have always received them. */
export interface ModelMessage {
  id: string;
  role: ModelRole;
  content: string;
  createdAt: string;
}

export interface ProvenanceItem {
  path: string;
  lines?: string;
  reason: "named" | "ranked" | "reused" | "pack" | "attached" | "brief";
  chars: number;
}

export interface ModelRequest {
  messages: ModelMessage[];
  /** The engine never offers tools: the model answers in text. */
  tools: never[];
  signal?: AbortSignal;
  model?: string;
  /** Cap on generated tokens; a client that cannot set it ignores it. */
  maxTokens?: number;
  temperature?: number;
  /** The project this request belongs to (its folder). Engines that keep a prompt cache on disk keep it per scope. */
  scope?: string;
  /** Hidden reasoning tokens the model may spend before answering (clients that support it). 0 = none. */
  thinkingBudget?: number;
  stop?: string[];
  /** slow engines with conversation slots: keep this request's prompt cache apart. */
  slot?: number;
  /** What this call is for, for logs and accounting. */
  purpose?: string;
  /** Where the context in this request came from, and why each piece was included. */
  provenance?: ProvenanceItem[];
  /** Characters per part of the prompt (file listing, ranges, filler, ...), for traces only. */
  segments?: Record<string, number>;
}

/** What a model stream yields. A client may also yield other event types; the engine ignores them. */
export type ModelEvent =
  | { type: "text-delta"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "tool-call"; toolCall: unknown }
  | { type: "message-complete"; message: { content?: string } }
  | { type: "usage"; inputTokens?: number; outputTokens?: number; cachedTokens?: number }
  | { type: "error"; message: string }
  | { type: "truncated" }
  | { type: "masked"; count: number; kinds: string[] }
  | { type: "done" };

/** A model the engine can ask. */
export interface ModelClient {
  stream(req: ModelRequest): AsyncIterable<ModelEvent>;
  /** Prompt-reading progress of a slow slow engine, if it reports one. */
  progress?(): { layer: number; layers: number; tokens: number; seconds: number; state?: string; written?: number; tokS?: number; note?: string } | null;
  /** Optional structured judgement call (slow engines); the engine works without it. */
  decide?(model: string, req: { scope?: string; prefix?: string; state: string; questions: Record<string, { type: "noul" | "choice"; instructions: string; criteria?: Record<string, string | null> }>; signal?: AbortSignal }): Promise<Record<string, { noul?: number; choice?: string; probabilities?: Record<string, number>; confidence?: number }>>;
}

/** What the engine reports while it works (candidate started, check written, ...). The host maps these to its own UI. */
export interface EngineEvent { kind: string; text: string; n?: number }
export type EventSink = (e: EngineEvent) => void;
