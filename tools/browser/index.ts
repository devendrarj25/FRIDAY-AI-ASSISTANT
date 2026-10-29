/**
 * FRIDAY · tools/browser
 *
 * Real capability source: discovers every folder under `tools/browser/`
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

export type BrowserModule = TreeSourceModule;

export const browserModule: BrowserModule = createTreeSource("tools", "browser");

/** Current on-disk entries for this folder. */
export const listToolsBrowser = (): CapabilityEntry[] => browserModule.scan();

/** Re-scan after a file was added or removed. */
export const refreshToolsBrowser = (ctx?: ModuleContext): CapabilityEntry[] => {
  if (ctx?.root) capabilities.setRoot(ctx.root);
  capabilities.refresh("tools/browser");
  return listToolsBrowser();
};

export default browserModule;
