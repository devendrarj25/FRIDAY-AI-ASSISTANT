/**
 * FRIDAY · testing/performance
 *
 * Timing suites; each records real measured durations. Suites are discovered from disk; nothing is reported as passing unless the runner actually ran it.
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

export interface PerformanceSuiteFile {
  name: string;
  path: string;
  sizeBytes: number;
}

export const PERFORMANCE_SUITE_FOLDER = "testing/performance";
export const PERFORMANCE_SUITE_SUFFIX = ".perf.ts";

export function performanceSuites(root = capabilities.getRoot()): PerformanceSuiteFile[] {
  const dir = path.join(root, PERFORMANCE_SUITE_FOLDER);
  if (!exists(dir)) return [];
  return findFiles(dir, PERFORMANCE_SUITE_SUFFIX).map((file) => ({
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

export type PerformanceModule = FridayModule;

export const performanceModule: PerformanceModule = {
  id: "testing/performance",
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    ctx.log("info", "testing/performance ready");
  },
};

export default performanceModule;
