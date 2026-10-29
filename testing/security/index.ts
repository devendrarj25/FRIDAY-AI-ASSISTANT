/**
 * FRIDAY · testing/security
 *
 * Permission and sandbox boundary suites. Suites are discovered from disk; nothing is reported as passing unless the runner actually ran it.
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

export interface SecuritySuiteFile {
  name: string;
  path: string;
  sizeBytes: number;
}

export const SECURITY_SUITE_FOLDER = "testing/security";
export const SECURITY_SUITE_SUFFIX = ".sec.ts";

export function securitySuites(root = capabilities.getRoot()): SecuritySuiteFile[] {
  const dir = path.join(root, SECURITY_SUITE_FOLDER);
  if (!exists(dir)) return [];
  return findFiles(dir, SECURITY_SUITE_SUFFIX).map((file) => ({
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

export type SecurityModule = FridayModule;

export const securityModule: SecurityModule = {
  id: "testing/security",
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    ctx.log("info", "testing/security ready");
  },
};

export default securityModule;
