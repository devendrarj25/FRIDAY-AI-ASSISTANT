/**
 * FRIDAY · core/ai contracts.
 *
 * One shape for every model, local or cloud. Adapters (ollama, openai,
 * local) implement `ChatProvider`; nothing else in FRIDAY talks HTTP to a
 * model directly.
 */
export type ModelRole = "brain" | "coder" | "researcher" | "fast" | "embed" | "vision";
export type ModelKind = "local" | "cloud";
export type ModelHealth = "unknown" | "ready" | "loading" | "error" | "offline";

export interface ModelSpec {
  id: string;
  label: string;
  provider: string;
  kind: ModelKind;
  endpoint: string;
  role: ModelRole;
  /** Provider-side model name, when it differs from the FRIDAY id. */
  model?: string;
  apiKey?: string;
  contextK?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: ModelSpec;
  messages: ChatMessage[];
  signal?: AbortSignal;
  temperature?: number;
}

export interface ProviderHealth {
  health: ModelHealth;
  detail?: string;
  checkedAt: number;
}

export interface ChatProvider {
  readonly id: string;
  /** Streams answer deltas. Buffered callers just join the chunks. */
  stream(request: ChatRequest): AsyncIterable<string>;
  /** Cheap reachability probe — never downloads or loads a model. */
  probe(model: ModelSpec): Promise<ProviderHealth>;
  /** Optional explicit load/unload for runners that keep models resident. */
  load?(model: ModelSpec): Promise<void>;
  unload?(model: ModelSpec): Promise<void>;
}
