/**
 * FRIDAY · modules/custom
 *
 * Real capability source: discovers every folder under `modules/custom/`
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

export type CustomModule = TreeSourceModule;

export const customModule: CustomModule = createTreeSource("modules", "custom");

/** Current on-disk entries for this folder. */
export const listModulesCustom = (): CapabilityEntry[] => customModule.scan();

/** Re-scan after a file was added or removed. */
export const refreshModulesCustom = (ctx?: ModuleContext): CapabilityEntry[] => {
  if (ctx?.root) capabilities.setRoot(ctx.root);
  capabilities.refresh("modules/custom");
  return listModulesCustom();
};

export default customModule;
