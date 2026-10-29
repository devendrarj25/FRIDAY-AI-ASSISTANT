/**
 * FRIDAY · core/event-bus
 *
 * One process-wide, typed event bus. Every pipeline stage talks through this
 * object, so no stage needs a direct reference to another and no stage can
 * register a duplicate listener by accident (subscriptions are keyed sets).
 */
import type { FridayModule, ModuleContext } from "../types";

export type EventHandler<T = unknown> = (payload: T) => void;
export type Unsubscribe = () => void;

export interface BusEvent {
  event: string;
  payload: unknown;
  at: number;
}

export class EventBus {
  private handlers = new Map<string, Set<EventHandler<never>>>();
  private history: BusEvent[] = [];
  private readonly historyLimit = 200;

  on<T = unknown>(event: string, handler: EventHandler<T>): Unsubscribe {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    // A Set makes re-registering the same function reference a no-op.
    set.add(handler as EventHandler<never>);
    return () => {
      set?.delete(handler as EventHandler<never>);
      if (set && set.size === 0) this.handlers.delete(event);
    };
  }

  once<T = unknown>(event: string, handler: EventHandler<T>): Unsubscribe {
    const off = this.on<T>(event, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  emit<T = unknown>(event: string, payload?: T): void {
    this.history.push({ event, payload, at: Date.now() });
    if (this.history.length > this.historyLimit) this.history.shift();
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        (handler as EventHandler<T | undefined>)(payload);
      } catch (error) {
        // A failing listener must never take the pipeline down.
        const errorSet = this.handlers.get("bus:listener-error");
        errorSet?.forEach((h) => (h as EventHandler<unknown>)({ event, error }));
      }
    }
  }

  /** Resolves on the next matching event, or rejects on timeout. */
  waitFor<T = unknown>(event: string, timeoutMs = 10_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timeout waiting for "${event}"`));
      }, timeoutMs);
      const off = this.once<T>(event, (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }

  recent(limit = 50): BusEvent[] {
    return this.history.slice(-limit);
  }

  listenerCount(event?: string): number {
    if (event) return this.handlers.get(event)?.size ?? 0;
    let total = 0;
    for (const set of this.handlers.values()) total += set.size;
    return total;
  }

  clear(): void {
    this.handlers.clear();
    this.history = [];
  }
}

/** The single bus for the whole application. Never construct a second one. */
export const bus = new EventBus();

export type EventBusModule = FridayModule;

export const eventBusModule: EventBusModule = {
  id: "core/event-bus",
  init(ctx: ModuleContext) {
    bus.on("bus:listener-error", (payload) => ctx.log("error", "event listener threw", payload));
  },
  dispose() {
    bus.clear();
  },
};

export default eventBusModule;
