/**
 * FRIDAY · plugins/disabled
 *
 * Real capability source: discovers every folder under `plugins/disabled/`
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

export type DisabledModule = TreeSourceModule;

export const disabledModule: DisabledModule = createTreeSource("plugins", "disabled");

/** Current on-disk entries for this folder. */
export const listPluginsDisabled = (): CapabilityEntry[] => disabledModule.scan();

/** Re-scan after a file was added or removed. */
export const refreshPluginsDisabled = (ctx?: ModuleContext): CapabilityEntry[] => {
  if (ctx?.root) capabilities.setRoot(ctx.root);
  capabilities.refresh("plugins/disabled");
  return listPluginsDisabled();
};

export default disabledModule;
