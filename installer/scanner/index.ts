/**
 * FRIDAY · installer/scanner
 *
 * Scans the selected root and reports what is really present: capability counts per tree, workspace folders and total file counts.
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

export interface ScanReport {
  root: string;
  folders: { name: string; files: number; folders: number }[];
  capabilities: Record<string, number>;
  totals: { files: number; folders: number };
  scannedAt: number;
}

export function scanRoot(root = capabilities.getRoot()): ScanReport {
  const folders = listDir(root)
    .filter(
      (entry) => entry.directory && entry.name !== "node_modules" && !entry.name.startsWith("."),
    )
    .map((entry) => ({ name: entry.name, ...countFiles(entry.path, 4000) }));
  const totals = folders.reduce(
    (acc, f) => ({ files: acc.files + f.files, folders: acc.folders + f.folders }),
    { files: 0, folders: 0 },
  );
  return { root, folders, capabilities: capabilities.counts(), totals, scannedAt: Date.now() };
}

export type ScannerModule = FridayModule;

export const scannerModule: ScannerModule = {
  id: "installer/scanner",
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    ctx.log("info", "installer/scanner ready");
  },
};

export default scannerModule;
