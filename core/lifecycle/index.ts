/**
 * FRIDAY · core/lifecycle
 *
 * Owns the application phases and the disposer stack. Anything that allocates
 * a resource registers its cleanup here, so shutdown is deterministic and no
 * timer, watcher or worker survives a restart.
 */
import type { FridayModule, ModuleContext } from "../types";
import { bus } from "../event-bus";

export type LifecyclePhase = "created" | "booting" | "ready" | "suspended" | "shutdown";

type Disposer = () => void | Promise<void>;

export class Lifecycle {
  private phase: LifecyclePhase = "created";
  private disposers: Array<{ id: string; run: Disposer }> = [];

  current(): LifecyclePhase {
    return this.phase;
  }

  set(phase: LifecyclePhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    bus.emit("lifecycle:phase", phase);
  }

  /** Registers cleanup. Re-registering the same id replaces the old disposer. */
  onDispose(id: string, run: Disposer): void {
    this.disposers = this.disposers.filter((d) => d.id !== id);
    this.disposers.push({ id, run });
  }

  async release(id: string): Promise<void> {
    const found = this.disposers.find((d) => d.id === id);
    if (!found) return;
    this.disposers = this.disposers.filter((d) => d.id !== id);
    await found.run();
  }

  async shutdown(): Promise<void> {
    this.set("shutdown");
    for (const disposer of [...this.disposers].reverse()) {
      try {
        await disposer.run();
      } catch (error) {
        bus.emit("lifecycle:dispose-error", { id: disposer.id, error });
      }
    }
    this.disposers = [];
  }
}

export const lifecycle = new Lifecycle();

export type LifecycleModule = FridayModule;

export const lifecycleModule: LifecycleModule = {
  id: "core/lifecycle",
  init(ctx: ModuleContext) {
    lifecycle.set("booting");
    bus.on("lifecycle:dispose-error", (payload) => ctx.log("error", "dispose failed", payload));
  },
  async dispose() {
    await lifecycle.shutdown();
  },
};

export default lifecycleModule;
