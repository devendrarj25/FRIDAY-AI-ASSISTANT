/**
 * FRIDAY · modules/ai
 *
 * Real capability source: discovers every folder under `modules/ai/`
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

export type AiModule = TreeSourceModule;

export const aiModule: AiModule = createTreeSource("modules", "ai");

/** Current on-disk entries for this folder. */
export const listModulesAi = (): CapabilityEntry[] => aiModule.scan();

/** Re-scan after a file was added or removed. */
export const refreshModulesAi = (ctx?: ModuleContext): CapabilityEntry[] => {
  if (ctx?.root) capabilities.setRoot(ctx.root);
  capabilities.refresh("modules/ai");
  return listModulesAi();
};

export default aiModule;
