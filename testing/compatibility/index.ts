/**
 * FRIDAY · testing/compatibility
 *
 * Windows/runtime compatibility suites. Suites are discovered from disk; nothing is reported as passing unless the runner actually ran it.
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

export interface CompatibilitySuiteFile {
  name: string;
  path: string;
  sizeBytes: number;
}

export const COMPATIBILITY_SUITE_FOLDER = "testing/compatibility";
export const COMPATIBILITY_SUITE_SUFFIX = ".compat.ts";

export function compatibilitySuites(root = capabilities.getRoot()): CompatibilitySuiteFile[] {
  const dir = path.join(root, COMPATIBILITY_SUITE_FOLDER);
  if (!exists(dir)) return [];
  return findFiles(dir, COMPATIBILITY_SUITE_SUFFIX).map((file) => ({
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

export type CompatibilityModule = FridayModule;

export const compatibilityModule: CompatibilityModule = {
  id: "testing/compatibility",
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    ctx.log("info", "testing/compatibility ready");
  },
};

export default compatibilityModule;
