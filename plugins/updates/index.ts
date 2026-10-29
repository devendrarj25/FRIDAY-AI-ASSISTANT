/**
 * FRIDAY · plugins/updates
 *
 * Real capability source: discovers every folder under `plugins/updates/`
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

export type UpdatesModule = TreeSourceModule;

export const updatesModule: UpdatesModule = createTreeSource("plugins", "updates");

/** Current on-disk entries for this folder. */
export const listPluginsUpdates = (): CapabilityEntry[] => updatesModule.scan();

/** Re-scan after a file was added or removed. */
export const refreshPluginsUpdates = (ctx?: ModuleContext): CapabilityEntry[] => {
  if (ctx?.root) capabilities.setRoot(ctx.root);
  capabilities.refresh("plugins/updates");
  return listPluginsUpdates();
};

export default updatesModule;
