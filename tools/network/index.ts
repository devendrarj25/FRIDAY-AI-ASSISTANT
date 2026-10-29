/**
 * FRIDAY · tools/network
 *
 * Real capability source: discovers every folder under `tools/network/`
 * on disk and registers it with the shared capability registry, so the UI and
 * the Core Brain see exactly what is installed — no hardcoded entries.
 */
import {
  capabilities,
  createTreeSource,
  type CapabilityEntry,
  type TreeSourceModule,
} from "../../core/discovery";
import type { ModuleContext } from "../../core/types";

export type NetworkModule = TreeSourceModule;

export const networkModule: NetworkModule = createTreeSource("tools", "network");

/** Current on-disk entries for this folder. */
export const listToolsNetwork = (): CapabilityEntry[] => networkModule.scan();

/** Re-scan after a file was added or removed. */
export const refreshToolsNetwork = (ctx?: ModuleContext): CapabilityEntry[] => {
  if (ctx?.root) capabilities.setRoot(ctx.root);
  capabilities.refresh("tools/network");
  return listToolsNetwork();
};

export default networkModule;
