/**
 * FRIDAY · plugins/sandbox
 *
 * Real capability source: discovers every folder under `plugins/sandbox/`
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

export type SandboxModule = TreeSourceModule;

export const sandboxModule: SandboxModule = createTreeSource("plugins", "sandbox");

/** Current on-disk entries for this folder. */
export const listPluginsSandbox = (): CapabilityEntry[] => sandboxModule.scan();

/** Re-scan after a file was added or removed. */
export const refreshPluginsSandbox = (ctx?: ModuleContext): CapabilityEntry[] => {
  if (ctx?.root) capabilities.setRoot(ctx.root);
  capabilities.refresh("plugins/sandbox");
  return listPluginsSandbox();
};

export default sandboxModule;
