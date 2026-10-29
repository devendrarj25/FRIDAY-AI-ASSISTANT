/**
 * FRIDAY · agents/manifests
 *
 * Real capability source: discovers every `agents/manifests/*.json` manifest
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

export const manifestsModule: ManifestsModule = createTreeSource("agents", "manifests");

/** Current on-disk entries for this folder. */
export const listAgentsManifests = (): CapabilityEntry[] => manifestsModule.scan();

/** Re-scan after a file was added or removed. */
export const refreshAgentsManifests = (ctx?: ModuleContext): CapabilityEntry[] => {
  if (ctx?.root) capabilities.setRoot(ctx.root);
  capabilities.refresh("agents/manifests");
  return listAgentsManifests();
};

export default manifestsModule;
