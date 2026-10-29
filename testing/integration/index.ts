/**
 * FRIDAY · testing/integration
 *
 * Cross-module suites covering boot, IPC parity and pipelines. Suites are discovered from disk; nothing is reported as passing unless the runner actually ran it.
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

export interface IntegrationSuiteFile {
  name: string;
  path: string;
  sizeBytes: number;
}

export const INTEGRATION_SUITE_FOLDER = "core/__tests__";
export const INTEGRATION_SUITE_SUFFIX = ".test.ts";

export function integrationSuites(root = capabilities.getRoot()): IntegrationSuiteFile[] {
  const dir = path.join(root, INTEGRATION_SUITE_FOLDER);
  if (!exists(dir)) return [];
  return findFiles(dir, INTEGRATION_SUITE_SUFFIX).map((file) => ({
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

export type IntegrationModule = FridayModule;

export const integrationModule: IntegrationModule = {
  id: "testing/integration",
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    ctx.log("info", "testing/integration ready");
  },
};

export default integrationModule;
