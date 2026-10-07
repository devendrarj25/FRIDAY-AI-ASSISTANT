/**
 * FRIDAY · core/ai/openai
 *
 * Adapter for every OpenAI-compatible endpoint: llama.cpp / llama-server,
 * LM Studio, vLLM and hosted providers that speak /v1/chat/completions.
 */
import type { FridayModule, ModuleContext } from "../../types";
import type { ChatProvider, ChatRequest, ModelSpec, ProviderHealth } from "../contracts";

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) yield delta;
      } catch {
        // Partial frame — the next chunk completes it.
      }
    }
  }
}

export const openAiProvider: ChatProvider = {
  id: "openai-compatible",

  async *stream(request: ChatRequest) {
    const { model, messages, signal, temperature } = request;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (model.apiKey) headers["Authorization"] = `Bearer ${model.apiKey}`;
    const response = await fetch(`${model.endpoint.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      signal: signal ?? null,
      body: JSON.stringify({
        model: model.model ?? model.id,
        messages,
        stream: true,
        ...(temperature === undefined ? {} : { temperature }),
      }),
    });
    if (!response.ok || !response.body) {
      throw new Error(`${model.label}: ${response.status} ${response.statusText}`);
    }
    yield* parseSse(response.body);
  },

  async probe(model: ModelSpec): Promise<ProviderHealth> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const headers: Record<string, string> = {};
      if (model.apiKey) headers["Authorization"] = `Bearer ${model.apiKey}`;
      const response = await fetch(`${model.endpoint.replace(/\/$/, "")}/models`, {
        headers,
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
};

export type OpenAiModule = FridayModule;

export const openAiModule: OpenAiModule = {
  id: "core/ai/openai",
  init(_ctx: ModuleContext) {},
};

export default openAiModule;
