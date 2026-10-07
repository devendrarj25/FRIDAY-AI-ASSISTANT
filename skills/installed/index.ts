/**
 * FRIDAY · skills/installed
 *
 * Real capability source: discovers every folder under `skills/installed/`
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

export type InstalledModule = TreeSourceModule;

export const installedModule: InstalledModule = createTreeSource("skills", "installed");

/** Current on-disk entries for this folder. */
export const listSkillsInstalled = (): CapabilityEntry[] => installedModule.scan();

/** Re-scan after a file was added or removed. */
export const refreshSkillsInstalled = (ctx?: ModuleContext): CapabilityEntry[] => {
  if (ctx?.root) capabilities.setRoot(ctx.root);
  capabilities.refresh("skills/installed");
  return listSkillsInstalled();
};

export default installedModule;
