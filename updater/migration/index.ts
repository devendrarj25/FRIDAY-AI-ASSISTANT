/**
 * FRIDAY · updater/migration
 *
 * Version-to-version data migrations run after an update is applied; delegates to the installer migration ledger, which holds the typed list.
 * electron/data-migrations.cjs runs the same ids at boot, and a damaged ledger is handled the same way by both: a ledger that cannot
 * be read is left as it is and nothing runs, and a damaged main file with a good backup is rebuilt from that backup first.
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

import { appliedMigrations, runMigrations, type MigrationRecord } from "../../installer/migration";

export interface UpgradeMigrationReport {
  from: string | null;
  to: string | null;
  applied: MigrationRecord[];
}

const ledgerFile = (root: string) => path.join(root, "database", "migrations.json");

function readRows(file: string): unknown[] | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Makes the ledger safe to hand to the installer runner, which reads only the main file and would treat a damaged
 * one as empty and run everything again. False means "leave it alone": a ledger exists but cannot be read.
 */
function settleLedger(root: string): boolean {
  const file = ledgerFile(root);
  const backup = `${file}.bak`;
  if (!fs.existsSync(file) && !fs.existsSync(backup)) return true;
  if (readRows(file)) return true;
  if (!readRows(backup)) return false;
  fs.copyFileSync(backup, file);
  return true;
}

export function migrateAfterUpdate(
  from: string | null,
  to: string | null,
  root = capabilities.getRoot(),
): UpgradeMigrationReport {
  if (!settleLedger(root)) return { from, to, applied: [] };
  return { from, to, applied: runMigrations(root, to) };
}

export function migrationLedger(root = capabilities.getRoot()): MigrationRecord[] {
  return appliedMigrations(root);
}

export type MigrationModule = FridayModule;

export const migrationModule: MigrationModule = {
  id: "updater/migration",
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    ctx.log("info", "updater/migration ready");
  },
};

export default migrationModule;
