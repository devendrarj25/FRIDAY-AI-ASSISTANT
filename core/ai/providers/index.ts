/**
 * FRIDAY · core/ai/providers
 *
 * The provider registry. Every adapter is registered exactly once and looked
 * up by id, so no part of FRIDAY constructs its own HTTP client for a model.
 */
import type { FridayModule, ModuleContext } from "../../types";
import type { ChatProvider, ModelSpec, ProviderHealth } from "../contracts";
import { openAiProvider } from "../openai";
import { ollamaProvider } from "../ollama";
import { LOCAL_PROVIDERS, createLocalProvider } from "../local";
import { bus } from "../../event-bus";
import { singleFlight } from "../../synchronization";

const HEALTH_TTL_MS = 30_000;

export class ProviderRegistry {
  private providers = new Map<string, ChatProvider>();
  private health = new Map<string, ProviderHealth>();

  register(provider: ChatProvider): void {
    if (this.providers.has(provider.id)) return; // no duplicates
    this.providers.set(provider.id, provider);
  }

  get(id: string): ChatProvider | null {
    return this.providers.get(id) ?? this.providers.get("openai-compatible") ?? null;
  }

  ids(): string[] {
    return [...this.providers.keys()];
  }

  resolve(model: ModelSpec): ChatProvider {
    const provider = this.get(model.provider);
    if (!provider) throw new Error(`unsupported provider: ${model.provider}`);
    return provider;
  }

  /** Cached health probe — repeated calls inside the TTL do not hit the network. */
  async checkHealth(model: ModelSpec, force = false): Promise<ProviderHealth> {
    const cached = this.health.get(model.id);
    if (!force && cached && Date.now() - cached.checkedAt < HEALTH_TTL_MS) return cached;
    const result = await singleFlight.run(`health:${model.id}`, () =>
      this.resolve(model).probe(model),
    );
    this.health.set(model.id, result);
    bus.emit("provider:health", { modelId: model.id, ...result });
    return result;
  }

  clearHealth(): void {
    this.health.clear();
  }
}

export const providers = new ProviderRegistry();

export type ProvidersModule = FridayModule;

export const providersModule: ProvidersModule = {
  id: "core/ai/providers",
  init(ctx: ModuleContext) {
    providers.register(openAiProvider);
    providers.register(ollamaProvider);
    for (const id of LOCAL_PROVIDERS) providers.register(createLocalProvider(id));
    ctx.log("info", `providers ready: ${providers.ids().join(", ")}`);
  },
  dispose() {
    providers.clearHealth();
  },
};

export default providersModule;
