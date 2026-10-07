/**
 * FRIDAY · core/ai/model-manager
 *
 * Tracks which models are actually resident. A model is loaded on first use,
 * reference-counted while it is in use and unloaded again after an idle
 * period, so an unused local model never keeps holding VRAM.
 */
import type { FridayModule, ModuleContext } from "../../types";
import type { ModelHealth, ModelSpec } from "../contracts";
import { providers } from "../providers";
import { bus } from "../../event-bus";
import { lifecycle } from "../../lifecycle";

const IDLE_UNLOAD_MS = 5 * 60_000;

interface ResidentModel {
  spec: ModelSpec;
  refs: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  loadedAt: number;
}

export class ModelManager {
  private resident = new Map<string, ResidentModel>();

  status(): Array<{ id: string; refs: number; loadedAt: number }> {
    return [...this.resident.values()].map((m) => ({
      id: m.spec.id,
      refs: m.refs,
      loadedAt: m.loadedAt,
    }));
  }

  async health(model: ModelSpec, force = false): Promise<ModelHealth> {
    return (await providers.checkHealth(model, force)).health;
  }

  async acquire(model: ModelSpec): Promise<void> {
    const entry = this.resident.get(model.id);
    if (entry) {
      entry.refs += 1;
      if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
      }
      return;
    }
    await providers.resolve(model).load?.(model);
    this.resident.set(model.id, { spec: model, refs: 1, idleTimer: null, loadedAt: Date.now() });
    lifecycle.onDispose(`model:${model.id}`, () => this.unload(model.id));
    bus.emit("model:loaded", model.id);
  }

  release(modelId: string): void {
    const entry = this.resident.get(modelId);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0) return;
    entry.idleTimer = setTimeout(() => void this.unload(modelId), IDLE_UNLOAD_MS);
  }

  /** Runs work with the model held, and always releases it afterwards. */
  async use<T>(model: ModelSpec, work: () => Promise<T>): Promise<T> {
    await this.acquire(model);
    try {
      return await work();
    } finally {
      this.release(model.id);
    }
  }

  async unload(modelId: string): Promise<void> {
    const entry = this.resident.get(modelId);
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    this.resident.delete(modelId);
    await providers.resolve(entry.spec).unload?.(entry.spec);
    bus.emit("model:unloaded", modelId);
  }

  async unloadAll(): Promise<void> {
    for (const id of [...this.resident.keys()]) await this.unload(id);
  }
}

export const modelManager = new ModelManager();

export type ModelManagerModule = FridayModule;

export const modelManagerModule: ModelManagerModule = {
  id: "core/ai/model-manager",
  init(_ctx: ModuleContext) {},
  async dispose() {
    await modelManager.unloadAll();
  },
};

export default modelManagerModule;
