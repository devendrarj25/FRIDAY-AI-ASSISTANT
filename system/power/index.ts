/**
 * FRIDAY · system/power
 *
 * Battery / charging state. Read-only probe backed by core/probes — no simulated values; a
 * value that cannot be read is reported as unavailable.
 */
import * as probes from "../../core/probes";
import { capabilities } from "../../core/discovery";
import { bus } from "../../core/event-bus";
import type { FridayModule, ModuleContext } from "../../core/types";

export type PowerModule = FridayModule & { read(): ReturnType<typeof readPower> };

/** Current reading for this subsystem. */
export function readPower() {
  return probes.power();
}

export const powerModule: PowerModule = {
  id: "system/power",
  read: readPower,
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    bus.emit("system:probe", { id: "system/power" });
    ctx.log("info", "system/power probe ready");
  },
};

export default powerModule;
