/**
 * FRIDAY · plugins/installed
 *
 * Real capability source: discovers every folder under `plugins/installed/`
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

export type InstalledModule = TreeSourceModule;

export const installedModule: InstalledModule = createTreeSource("plugins", "installed");

/** Current on-disk entries for this folder. */
export const listPluginsInstalled = (): CapabilityEntry[] => installedModule.scan();

/** Re-scan after a file was added or removed. */
export const refreshPluginsInstalled = (ctx?: ModuleContext): CapabilityEntry[] => {
  if (ctx?.root) capabilities.setRoot(ctx.root);
  capabilities.refresh("plugins/installed");
  return listPluginsInstalled();
};

export default installedModule;
