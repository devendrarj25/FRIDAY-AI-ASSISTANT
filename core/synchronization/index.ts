/**
 * FRIDAY · core/synchronization
 *
 * Primitives that stop duplicate work: single-flight for identical async
 * calls, named locks for exclusive sections, debounce and throttle for
 * anything driven by file watchers or the UI.
 */
import type { FridayModule, ModuleContext } from "../types";

export class SingleFlight {
  private inFlight = new Map<string, Promise<unknown>>();

  /** Concurrent callers with the same key share one execution. */
  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const promise = work().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  has(key: string): boolean {
    return this.inFlight.has(key);
  }
}

export class LockTable {
  private queues = new Map<string, Promise<unknown>>();

  /** Serialises sections that share a name (one writer per resource). */
  async withLock<T>(name: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(name) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    this.queues.set(
      name,
      previous.then(() => gate),
    );
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const wrapped = (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return wrapped;
}

export function throttle<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let last = 0;
  return (...args: A) => {
    const now = Date.now();
    if (now - last < ms) return;
    last = now;
    fn(...args);
  };
}

export const singleFlight = new SingleFlight();
export const locks = new LockTable();

export type SynchronizationModule = FridayModule;

export const synchronizationModule: SynchronizationModule = {
  id: "core/synchronization",
  init(_ctx: ModuleContext) {},
};

export default synchronizationModule;
