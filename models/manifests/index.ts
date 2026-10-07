/**
 * FRIDAY · models/manifests
 *
 * Real capability source: discovers every `models/manifests/*.json` manifest
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

export type ManifestsModule = TreeSourceModule;

export const manifestsModule: ManifestsModule = createTreeSource("models", "manifests");

/** Current on-disk entries for this folder. */
export const listModelsManifests = (): CapabilityEntry[] => manifestsModule.scan();

/** Re-scan after a file was added or removed. */
export const refreshModelsManifests = (ctx?: ModuleContext): CapabilityEntry[] => {
  if (ctx?.root) capabilities.setRoot(ctx.root);
  capabilities.refresh("models/manifests");
  return listModelsManifests();
};

export default manifestsModule;
