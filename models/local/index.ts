/**
 * FRIDAY · models/local
 *
 * Real capability source: discovers every folder under `models/local/`
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

export type LocalModule = TreeSourceModule;

export const localModule: LocalModule = createTreeSource("models", "local");

/** Current on-disk entries for this folder. */
export const listModelsLocal = (): CapabilityEntry[] => localModule.scan();

/** Re-scan after a file was added or removed. */
export const refreshModelsLocal = (ctx?: ModuleContext): CapabilityEntry[] => {
  if (ctx?.root) capabilities.setRoot(ctx.root);
  capabilities.refresh("models/local");
  return listModelsLocal();
};

export default localModule;
