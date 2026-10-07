/**
 * FRIDAY · system/registry
 *
 * Read-only Windows registry lookups. Read-only probe backed by core/probes — no simulated values; a
 * value that cannot be read is reported as unavailable.
 */
import * as probes from "../../core/probes";
import { capabilities } from "../../core/discovery";
import { bus } from "../../core/event-bus";
import type { FridayModule, ModuleContext } from "../../core/types";

export type RegistryModule = FridayModule & { read(): ReturnType<typeof readRegistry> };

/** Current reading for this subsystem. */
export function readRegistry() {
  return probes.registryValue(
    "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion",
    "ProductName",
  );
}

export const registryModule: RegistryModule = {
  id: "system/registry",
  read: readRegistry,
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    bus.emit("system:probe", { id: "system/registry" });
    ctx.log("info", "system/registry probe ready");
  },
};

export default registryModule;
