/**
 * FRIDAY · testing/ui
 *
 * Renderer component suites. Suites are discovered from disk; nothing is reported as passing unless the runner actually ran it.
 */
import path from "node:path";
import fs from "node:fs";
import { capabilities } from "../../core/discovery";
import {
  countFiles,
  ensureDirs,
  exists,
  findFiles,
  hashFile,
  isWritable,
  listDir,
  readJson,
  writeJson,
} from "../../core/paths";
import type { FridayModule, ModuleContext } from "../../core/types";

export interface UiSuiteFile {
  name: string;
  path: string;
  sizeBytes: number;
}

export const UI_SUITE_FOLDER = "src";
export const UI_SUITE_SUFFIX = ".test.tsx";

export function uiSuites(root = capabilities.getRoot()): UiSuiteFile[] {
  const dir = path.join(root, UI_SUITE_FOLDER);
  if (!exists(dir)) return [];
  return findFiles(dir, UI_SUITE_SUFFIX).map((file) => ({
    name: path.basename(file),
    path: file,
    sizeBytes: (() => {
      try {
        return fs.statSync(file).size;
      } catch {
        return 0;
      }
    })(),
  }));
}

export type UiModule = FridayModule;

export const uiModule: UiModule = {
  id: "testing/ui",
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    ctx.log("info", "testing/ui ready");
  },
};

export default uiModule;
