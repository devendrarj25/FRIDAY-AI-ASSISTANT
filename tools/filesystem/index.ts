/**
 * FRIDAY · tools/filesystem
 *
 * Real capability source: discovers every folder under `tools/filesystem/`
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

export type FilesystemModule = TreeSourceModule;

export const filesystemModule: FilesystemModule = createTreeSource("tools", "filesystem");

/** Current on-disk entries for this folder. */
export const listToolsFilesystem = (): CapabilityEntry[] => filesystemModule.scan();

/** Re-scan after a file was added or removed. */
export const refreshToolsFilesystem = (ctx?: ModuleContext): CapabilityEntry[] => {
  if (ctx?.root) capabilities.setRoot(ctx.root);
  capabilities.refresh("tools/filesystem");
  return listToolsFilesystem();
};

export default filesystemModule;
