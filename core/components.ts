/**
 * FRIDAY · core/components
 *
 * One registry shape for agents, skills, tools, plugins and modules. Every
 * component has an id, version, manifest, dependencies, status and an
 * enable/disable state, and is instantiated at most once. Anything installed
 * later reuses this registry instead of inventing its own.
 */
import { bus } from "./event-bus";
import { lifecycle } from "./lifecycle";
import { services } from "./services";
import type { Capability } from "./permissions";
import type { ModuleContext } from "./types";

export type ComponentKind = "agent" | "skill" | "tool" | "plugin" | "module";
export type ComponentStatus = "registered" | "loading" | "ready" | "disabled" | "error";

export interface ComponentManifest {
  id: string;
  kind: ComponentKind;
  name: string;
  version: string;
  description?: string;
  /** Ids of other components that must be ready first. */
  dependencies?: string[];
  /** Capabilities the component may request. Anything else is refused. */
  capabilities?: Capability[];
  /** Plugins default to isolated: they only see the context they are handed. */
  isolated?: boolean;
  idleMs?: number;
}

export interface ComponentRuntime {
  init?(ctx: ModuleContext): Promise<void> | void;
  dispose?(): Promise<void> | void;
  run?(input: unknown, ctx: ModuleContext): Promise<unknown>;
}

export interface ComponentRecord {
  manifest: ComponentManifest;
  status: ComponentStatus;
  enabled: boolean;
  error?: string;
  lastRunAt?: number;
}

interface Registration {
  manifest: ComponentManifest;
  factory: () => ComponentRuntime | Promise<ComponentRuntime>;
  status: ComponentStatus;
  enabled: boolean;
  error?: string;
  lastRunAt?: number;
}

const DEFAULT_IDLE_MS = 2 * 60_000;

export class ComponentRegistry {
  private items = new Map<string, Registration>();

  /** Registering an existing id is ignored — duplicates cannot be created. */
  register(
    manifest: ComponentManifest,
    factory: () => ComponentRuntime | Promise<ComponentRuntime>,
  ): void {
    if (this.items.has(manifest.id)) {
      bus.emit("component:duplicate", manifest.id);
      return;
    }
    this.items.set(manifest.id, { manifest, factory, status: "registered", enabled: true });
    // The instance itself is owned by the lazy service registry.
    services.define<ComponentRuntime>({
      id: `component:${manifest.id}`,
      idleMs: manifest.idleMs ?? DEFAULT_IDLE_MS,
      start: async () => {
        const runtime = await factory();
        await runtime.init?.(this.contextFor(manifest));
        return runtime;
      },
      stop: async (runtime) => {
        await runtime.dispose?.();
      },
    });
    bus.emit("component:registered", { id: manifest.id, kind: manifest.kind });
  }

  list(kind?: ComponentKind): ComponentRecord[] {
    return [...this.items.values()]
      .filter((r) => !kind || r.manifest.kind === kind)
      .map((r) => ({
        manifest: r.manifest,
        status: r.status,
        enabled: r.enabled,
        ...(r.error ? { error: r.error } : {}),
        ...(r.lastRunAt ? { lastRunAt: r.lastRunAt } : {}),
      }));
  }

  get(id: string): ComponentRecord | null {
    const found = this.items.get(id);
    if (!found) return null;
    return {
      manifest: found.manifest,
      status: found.status,
      enabled: found.enabled,
      ...(found.error ? { error: found.error } : {}),
      ...(found.lastRunAt ? { lastRunAt: found.lastRunAt } : {}),
    };
  }

  setEnabled(id: string, enabled: boolean): void {
    const found = this.items.get(id);
    if (!found) return;
    found.enabled = enabled;
    found.status = enabled ? "registered" : "disabled";
    if (!enabled) void services.stop(`component:${id}`);
    bus.emit("component:enabled", { id, enabled });
  }

  /**
   * Loads the component on demand, runs it, then lets it idle out. Missing
   * dependencies and disabled components fail loudly instead of silently.
   */
  async run(id: string, input: unknown = {}): Promise<unknown> {
    const found = this.items.get(id);
    if (!found) throw new Error(`unknown component: ${id}`);
    if (!found.enabled) throw new Error(`component disabled: ${id}`);

    for (const dep of found.manifest.dependencies ?? []) {
      const depRecord = this.items.get(dep);
      if (!depRecord) throw new Error(`${id} needs missing component: ${dep}`);
      if (!depRecord.enabled) throw new Error(`${id} needs disabled component: ${dep}`);
    }

    found.status = "loading";
    try {
      const result = await services.use<ComponentRuntime, unknown>(`component:${id}`, (runtime) => {
        if (!runtime.run) throw new Error(`component ${id} has no run()`);
        return runtime.run(input, this.contextFor(found.manifest));
      });
      found.status = "ready";
      delete found.error;
      found.lastRunAt = Date.now();
      bus.emit("component:ran", { id });
      return result;
    } catch (error) {
      found.status = "error";
      found.error = String(error);
      bus.emit("component:error", { id, error: found.error });
      throw error;
    }
  }

  async stopAll(): Promise<void> {
    for (const id of this.items.keys()) await services.stop(`component:${id}`);
  }

  /** Isolated components get a logger and event access, nothing more. */
  private contextFor(manifest: ComponentManifest): ModuleContext {
    return {
      root: "",
      log: (level, message, meta) =>
        bus.emit("component:log", { id: manifest.id, level, message, meta }),
      emit: (event, payload) => bus.emit(`component:${manifest.id}:${event}`, payload),
      on: (event, handler) => bus.on(`component:${manifest.id}:${event}`, handler),
    };
  }
}

export const components = new ComponentRegistry();

lifecycle.onDispose("core/components", () => components.stopAll());
