/**
 * FRIDAY · core/ai/ollama
 *
 * Adapter for a local Ollama daemon (NDJSON streaming, /api/tags for health,
 * explicit keep-alive control so idle models are unloaded from VRAM).
 */
import type { FridayModule, ModuleContext } from "../../types";
import type { ChatProvider, ChatRequest, ModelSpec, ProviderHealth } from "../contracts";

export const ollamaProvider: ChatProvider = {
  id: "ollama",

  async *stream(request: ChatRequest) {
    const { model, messages, signal, temperature } = request;
    const response = await fetch(`${model.endpoint.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: signal ?? null,
      body: JSON.stringify({
        model: model.model ?? model.id,
        messages,
        stream: true,
        ...(temperature === undefined ? {} : { options: { temperature } }),
      }),
    });
    if (!response.ok || !response.body) {
      throw new Error(`${model.label}: ${response.status} ${response.statusText}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const content = JSON.parse(line)?.message?.content;
          if (typeof content === "string" && content) yield content;
        } catch {
          // Incomplete JSON line — completed by the next chunk.
        }
      }
    }
  },

  async probe(model: ModelSpec): Promise<ProviderHealth> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch(`${model.endpoint.replace(/\/$/, "")}/api/tags`, {
        signal: controller.signal,
      });
      if (response.ok) return { health: "ready", checkedAt: Date.now() };
      return { health: "error", detail: `HTTP ${response.status}`, checkedAt: Date.now() };
    } catch (error) {
      return { health: "offline", detail: String(error), checkedAt: Date.now() };
    } finally {
      clearTimeout(timer);
    }
  },

  /** Frees the model from memory instead of leaving it resident. */
  async unload(model: ModelSpec): Promise<void> {
    await fetch(`${model.endpoint.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: model.model ?? model.id, keep_alive: 0 }),
    }).catch(() => undefined);
  },
};

export type OllamaModule = FridayModule;

export const ollamaModule: OllamaModule = {
  id: "core/ai/ollama",
  init(_ctx: ModuleContext) {},
};

export default ollamaModule;
