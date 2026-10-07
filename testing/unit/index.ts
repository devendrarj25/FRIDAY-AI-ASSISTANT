/**
 * FRIDAY · testing/unit
 *
 * Unit suites that run in-process (vitest). Suites are discovered from disk; nothing is reported as passing unless the runner actually ran it.
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

export interface UnitSuiteFile {
  name: string;
  path: string;
  sizeBytes: number;
}

export const UNIT_SUITE_FOLDER = "core/__tests__";
export const UNIT_SUITE_SUFFIX = ".test.ts";

export function unitSuites(root = capabilities.getRoot()): UnitSuiteFile[] {
  const dir = path.join(root, UNIT_SUITE_FOLDER);
  if (!exists(dir)) return [];
  return findFiles(dir, UNIT_SUITE_SUFFIX).map((file) => ({
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

export type UnitModule = FridayModule;

export const unitModule: UnitModule = {
  id: "testing/unit",
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    ctx.log("info", "testing/unit ready");
  },
};

export default unitModule;
