/**
 * FRIDAY · core/ai/local
 *
 * Local runners (llama.cpp / llama-server, LM Studio, vLLM, LocalAI, Jan, MLX-LM) all speak the
 * OpenAI wire format, so they reuse that adapter and only differ in how
 * FRIDAY discovers and labels them.
 */
import type { FridayModule, ModuleContext } from "../../types";
import type { ChatProvider } from "../contracts";
import { openAiProvider } from "../openai";

export const LOCAL_PROVIDERS = ["llamacpp", "lmstudio", "vllm", "localai", "jan", "mlx"] as const;
export type LocalProviderId = (typeof LOCAL_PROVIDERS)[number];

export const DEFAULT_LOCAL_ENDPOINTS: Record<LocalProviderId, string> = {
  llamacpp: "http://127.0.0.1:8080/v1",
  lmstudio: "http://127.0.0.1:1234/v1",
  vllm: "http://127.0.0.1:8000/v1",
  localai: "http://127.0.0.1:8081/v1",
  jan: "http://127.0.0.1:1337/v1",
  mlx: "http://127.0.0.1:8082/v1",
};

/** Same wire protocol, distinct provider id so the UI can label it. */
export function createLocalProvider(id: LocalProviderId): ChatProvider {
  return { ...openAiProvider, id };
}

export type LocalModule = FridayModule;

export const localModule: LocalModule = {
  id: "core/ai/local",
  init(_ctx: ModuleContext) {},
};

export default localModule;
