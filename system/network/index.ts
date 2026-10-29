/**
 * FRIDAY · system/network
 *
 * Local network interfaces. Read-only probe backed by core/probes — no simulated values; a
 * value that cannot be read is reported as unavailable.
 */
import * as probes from "../../core/probes";
import { capabilities } from "../../core/discovery";
import { bus } from "../../core/event-bus";
import type { FridayModule, ModuleContext } from "../../core/types";

export type NetworkModule = FridayModule & { read(): ReturnType<typeof readNetwork> };

/** Current reading for this subsystem. */
export function readNetwork() {
  return probes.interfaces();
}

export const networkModule: NetworkModule = {
  id: "system/network",
  read: readNetwork,
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    bus.emit("system:probe", { id: "system/network" });
    ctx.log("info", "system/network probe ready");
  },
};

export default networkModule;
