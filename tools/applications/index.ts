/**
 * FRIDAY · tools/applications
 *
 * Real capability source: discovers every folder under `tools/applications/`
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

export type ApplicationsModule = TreeSourceModule;

export const applicationsModule: ApplicationsModule = createTreeSource("tools", "applications");

/** Current on-disk entries for this folder. */
export const listToolsApplications = (): CapabilityEntry[] => applicationsModule.scan();

/** Re-scan after a file was added or removed. */
export const refreshToolsApplications = (ctx?: ModuleContext): CapabilityEntry[] => {
  if (ctx?.root) capabilities.setRoot(ctx.root);
  capabilities.refresh("tools/applications");
  return listToolsApplications();
};

export default applicationsModule;
