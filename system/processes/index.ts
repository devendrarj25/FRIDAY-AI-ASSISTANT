/**
 * FRIDAY · system/processes
 *
 * Running processes and this process' own footprint. Read-only probe backed by core/probes — no simulated values; a
 * value that cannot be read is reported as unavailable.
 */
import * as probes from "../../core/probes";
import { capabilities } from "../../core/discovery";
import { bus } from "../../core/event-bus";
import type { FridayModule, ModuleContext } from "../../core/types";

export type ProcessesModule = FridayModule & { read(): ReturnType<typeof readProcesses> };

/** Current reading for this subsystem. */
export function readProcesses() {
  return probes.topProcesses();
}

export const selfProcess = () => probes.currentProcess();
export const processesModule: ProcessesModule = {
  id: "system/processes",
  read: readProcesses,
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    bus.emit("system:probe", { id: "system/processes" });
    ctx.log("info", "system/processes probe ready");
  },
};

export default processesModule;
