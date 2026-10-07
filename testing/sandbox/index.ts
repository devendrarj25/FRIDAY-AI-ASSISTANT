/**
 * FRIDAY · testing/sandbox
 *
 * Suites executed inside the isolated Sandbox Lab. Suites are discovered from disk; nothing is reported as passing unless the runner actually ran it.
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

export interface SandboxSuiteFile {
  name: string;
  path: string;
  sizeBytes: number;
}

export const SANDBOX_SUITE_FOLDER = "testing/sandbox";
export const SANDBOX_SUITE_SUFFIX = ".sandbox.ts";

export function sandboxSuites(root = capabilities.getRoot()): SandboxSuiteFile[] {
  const dir = path.join(root, SANDBOX_SUITE_FOLDER);
  if (!exists(dir)) return [];
  return findFiles(dir, SANDBOX_SUITE_SUFFIX).map((file) => ({
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

export type SandboxModule = FridayModule;

export const sandboxModule: SandboxModule = {
  id: "testing/sandbox",
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    ctx.log("info", "testing/sandbox ready");
  },
};

export default sandboxModule;
