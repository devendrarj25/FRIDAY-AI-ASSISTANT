/**
 * FRIDAY · modules/developer
 *
 * Real capability source: discovers every folder under `modules/developer/`
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

export const developerModule: DeveloperModule = createTreeSource("modules", "developer");

/** Current on-disk entries for this folder. */
export const listModulesDeveloper = (): CapabilityEntry[] => developerModule.scan();

/** Re-scan after a file was added or removed. */
export const refreshModulesDeveloper = (ctx?: ModuleContext): CapabilityEntry[] => {
  if (ctx?.root) capabilities.setRoot(ctx.root);
  capabilities.refresh("modules/developer");
  return listModulesDeveloper();
};

export default developerModule;
