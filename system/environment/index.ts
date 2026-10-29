/**
 * FRIDAY · system/environment
 *
 * OS, CPU, memory, locale and app version. Read-only probe backed by core/probes — no simulated values; a
 * value that cannot be read is reported as unavailable.
 */
import * as probes from "../../core/probes";
import { capabilities } from "../../core/discovery";
import { bus } from "../../core/event-bus";
import type { FridayModule, ModuleContext } from "../../core/types";

export type EnvironmentModule = FridayModule & { read(): ReturnType<typeof readEnvironment> };

/** Current reading for this subsystem. */
export function readEnvironment() {
  return probes.environment(capabilities.getRoot());
}

export const environmentModule: EnvironmentModule = {
  id: "system/environment",
  read: readEnvironment,
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    bus.emit("system:probe", { id: "system/environment" });
    ctx.log("info", "system/environment probe ready");
  },
};

export default environmentModule;
