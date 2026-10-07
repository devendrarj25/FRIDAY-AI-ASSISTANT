/**
 * FRIDAY · system/services
 *
 * Windows services (read-only). Read-only probe backed by core/probes — no simulated values; a
 * value that cannot be read is reported as unavailable.
 */
import * as probes from "../../core/probes";
import { capabilities } from "../../core/discovery";
import { bus } from "../../core/event-bus";
import type { FridayModule, ModuleContext } from "../../core/types";

export type ServicesModule = FridayModule & { read(): ReturnType<typeof readServices> };

/** Current reading for this subsystem. */
export function readServices() {
  return probes.services();
}

export const servicesModule: ServicesModule = {
  id: "system/services",
  read: readServices,
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    bus.emit("system:probe", { id: "system/services" });
    ctx.log("info", "system/services probe ready");
  },
};

export default servicesModule;
