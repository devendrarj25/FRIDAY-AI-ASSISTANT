/**
 * FRIDAY · skills/system
 *
 * Real capability source: discovers every folder under `skills/system/`
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

export type SystemModule = TreeSourceModule;

export const systemModule: SystemModule = createTreeSource("skills", "system");

/** Current on-disk entries for this folder. */
export const listSkillsSystem = (): CapabilityEntry[] => systemModule.scan();

/** Re-scan after a file was added or removed. */
export const refreshSkillsSystem = (ctx?: ModuleContext): CapabilityEntry[] => {
  if (ctx?.root) capabilities.setRoot(ctx.root);
  capabilities.refresh("skills/system");
  return listSkillsSystem();
};

export default systemModule;
