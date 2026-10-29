/**
 * FRIDAY · modules/communication
 *
 * Real capability source: discovers every folder under `modules/communication/`
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

export type CommunicationModule = TreeSourceModule;

export const communicationModule: CommunicationModule = createTreeSource(
  "modules",
  "communication",
);

/** Current on-disk entries for this folder. */
export const listModulesCommunication = (): CapabilityEntry[] => communicationModule.scan();

/** Re-scan after a file was added or removed. */
export const refreshModulesCommunication = (ctx?: ModuleContext): CapabilityEntry[] => {
  if (ctx?.root) capabilities.setRoot(ctx.root);
  capabilities.refresh("modules/communication");
  return listModulesCommunication();
};

export default communicationModule;
