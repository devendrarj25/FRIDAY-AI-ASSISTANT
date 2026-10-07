/**
 * FRIDAY · system/applications
 *
 * Applications installed on this machine. Read-only probe backed by core/probes — no simulated values; a
 * value that cannot be read is reported as unavailable.
 */
import * as probes from "../../core/probes";
import { capabilities } from "../../core/discovery";
import { bus } from "../../core/event-bus";
import type { FridayModule, ModuleContext } from "../../core/types";

export type ApplicationsModule = FridayModule & { read(): ReturnType<typeof readApplications> };

/** Current reading for this subsystem. */
export function readApplications() {
  return probes.installedApps();
}

export const applicationsModule: ApplicationsModule = {
  id: "system/applications",
  read: readApplications,
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    bus.emit("system:probe", { id: "system/applications" });
    ctx.log("info", "system/applications probe ready");
  },
};

export default applicationsModule;
