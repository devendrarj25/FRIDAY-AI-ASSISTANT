/**
 * FRIDAY · tools/developer
 *
 * Real capability source: discovers every folder under `tools/developer/`
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

export type DeveloperModule = TreeSourceModule;

export const developerModule: DeveloperModule = createTreeSource("tools", "developer");

/** Current on-disk entries for this folder. */
export const listToolsDeveloper = (): CapabilityEntry[] => developerModule.scan();

/** Re-scan after a file was added or removed. */
export const refreshToolsDeveloper = (ctx?: ModuleContext): CapabilityEntry[] => {
  if (ctx?.root) capabilities.setRoot(ctx.root);
  capabilities.refresh("tools/developer");
  return listToolsDeveloper();
};

export default developerModule;
