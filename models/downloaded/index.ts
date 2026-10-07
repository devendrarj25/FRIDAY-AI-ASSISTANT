/**
 * FRIDAY · models/downloaded
 *
 * Real capability source: discovers every folder under `models/downloaded/`
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

export type DownloadedModule = TreeSourceModule;

export const downloadedModule: DownloadedModule = createTreeSource("models", "downloaded");

/** Current on-disk entries for this folder. */
export const listModelsDownloaded = (): CapabilityEntry[] => downloadedModule.scan();

/** Re-scan after a file was added or removed. */
export const refreshModelsDownloaded = (ctx?: ModuleContext): CapabilityEntry[] => {
  if (ctx?.root) capabilities.setRoot(ctx.root);
  capabilities.refresh("models/downloaded");
  return listModelsDownloaded();
};

export default downloadedModule;
