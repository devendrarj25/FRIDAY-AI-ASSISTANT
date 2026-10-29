/**
 * FRIDAY · skills/experimental
 *
 * Real capability source: discovers every folder under `skills/experimental/`
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

export type ExperimentalModule = TreeSourceModule;

export const experimentalModule: ExperimentalModule = createTreeSource("skills", "experimental");

/** Current on-disk entries for this folder. */
export const listSkillsExperimental = (): CapabilityEntry[] => experimentalModule.scan();

/** Re-scan after a file was added or removed. */
export const refreshSkillsExperimental = (ctx?: ModuleContext): CapabilityEntry[] => {
  if (ctx?.root) capabilities.setRoot(ctx.root);
  capabilities.refresh("skills/experimental");
  return listSkillsExperimental();
};

export default experimentalModule;
