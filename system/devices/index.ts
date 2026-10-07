/**
 * FRIDAY · system/devices
 *
 * Present PnP devices. Read-only probe backed by core/probes — no simulated values; a
 * value that cannot be read is reported as unavailable.
 */
import * as probes from "../../core/probes";
import { capabilities } from "../../core/discovery";
import { bus } from "../../core/event-bus";
import type { FridayModule, ModuleContext } from "../../core/types";

export type DevicesModule = FridayModule & { read(): ReturnType<typeof readDevices> };

/** Current reading for this subsystem. */
export function readDevices() {
  return probes.devices();
}

export const devicesModule: DevicesModule = {
  id: "system/devices",
  read: readDevices,
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    bus.emit("system:probe", { id: "system/devices" });
    ctx.log("info", "system/devices probe ready");
  },
};

export default devicesModule;
