/**
 * FRIDAY · models/cloud
 *
 * Real capability source: discovers every folder under `models/cloud/`
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

export type CloudModule = TreeSourceModule;

export const cloudModule: CloudModule = createTreeSource("models", "cloud");

/** Current on-disk entries for this folder. */
export const listModelsCloud = (): CapabilityEntry[] => cloudModule.scan();

/** Re-scan after a file was added or removed. */
export const refreshModelsCloud = (ctx?: ModuleContext): CapabilityEntry[] => {
  if (ctx?.root) capabilities.setRoot(ctx.root);
  capabilities.refresh("models/cloud");
  return listModelsCloud();
};

export default cloudModule;
