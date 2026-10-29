/**
 * FRIDAY · testing/experimental
 *
 * Opt-in experimental suites. Suites are discovered from disk; nothing is reported as passing unless the runner actually ran it.
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

export interface ExperimentalSuiteFile {
  name: string;
  path: string;
  sizeBytes: number;
}

export const EXPERIMENTAL_SUITE_FOLDER = "testing/experimental";
export const EXPERIMENTAL_SUITE_SUFFIX = ".exp.ts";

export function experimentalSuites(root = capabilities.getRoot()): ExperimentalSuiteFile[] {
  const dir = path.join(root, EXPERIMENTAL_SUITE_FOLDER);
  if (!exists(dir)) return [];
  return findFiles(dir, EXPERIMENTAL_SUITE_SUFFIX).map((file) => ({
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

export type ExperimentalModule = FridayModule;

export const experimentalModule: ExperimentalModule = {
  id: "testing/experimental",
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    ctx.log("info", "testing/experimental ready");
  },
};

export default experimentalModule;
