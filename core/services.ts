/**
 * FRIDAY · core/services
 *
 * Lazy service registry. Heavy subsystems (models, agents, skills, tools,
 * plugins, workflows, system probes) are declared here but only started the
 * first time something actually needs them, and are released again after an
 * idle period. Acquiring the same service twice returns the same instance —
 * duplicate workers, watchers or model runners cannot be created.
 */
import { bus } from "./event-bus";
import { lifecycle } from "./lifecycle";
import { singleFlight } from "./synchronization";

export interface ServiceDefinition<T> {
  id: string;
  /** Milliseconds of inactivity after which the service is released. 0 = keep. */
  idleMs?: number;
  start: () => Promise<T> | T;
  stop?: (instance: T) => Promise<void> | void;
}

interface Entry<T> {
  def: ServiceDefinition<T>;
  instance: T | null;
  refs: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastUsed: number;
}

export class ServiceRegistry {
  private entries = new Map<string, Entry<unknown>>();

  define<T>(def: ServiceDefinition<T>): void {
    if (this.entries.has(def.id)) return; // never register a service twice
    this.entries.set(def.id, {
      def: def as ServiceDefinition<unknown>,
      instance: null,
      refs: 0,
      idleTimer: null,
      lastUsed: 0,
    });
  }

  list(): Array<{ id: string; started: boolean; refs: number; lastUsed: number }> {
    return [...this.entries.values()].map((e) => ({
      id: e.def.id,
      started: e.instance !== null,
      refs: e.refs,
      lastUsed: e.lastUsed,
    }));
  }

  /** Starts the service on first use and returns the shared instance. */
  async acquire<T>(id: string): Promise<T> {
    const entry = this.entries.get(id) as Entry<T> | undefined;
    if (!entry) throw new Error(`unknown service: ${id}`);
    entry.refs += 1;
    entry.lastUsed = Date.now();
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    if (entry.instance) return entry.instance;

    // singleFlight: two parallel acquires cannot start two instances.
    const instance = await singleFlight.run(`service:${id}`, async () => {
      const started = await entry.def.start();
      bus.emit("service:started", id);
      lifecycle.onDispose(`service:${id}`, () => this.stop(id));
      return started;
    });
    entry.instance = instance;
    return instance;
  }

  /** Signals that the caller is done. The service idles out, it is not killed. */
  release(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    entry.lastUsed = Date.now();
    const idleMs = entry.def.idleMs ?? 0;
    if (entry.refs > 0 || idleMs <= 0 || !entry.instance) return;
    entry.idleTimer = setTimeout(() => void this.stop(id), idleMs);
  }

  /** Runs work with the service and always releases it afterwards. */
  async use<T, R>(id: string, work: (instance: T) => Promise<R> | R): Promise<R> {
    const instance = await this.acquire<T>(id);
    try {
      return await work(instance);
    } finally {
      this.release(id);
    }
  }

  async stop(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || !entry.instance) return;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    const instance = entry.instance;
    entry.instance = null;
    entry.refs = 0;
    await entry.def.stop?.(instance);
    bus.emit("service:stopped", id);
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.entries.keys()]) await this.stop(id);
  }
}

export const services = new ServiceRegistry();
