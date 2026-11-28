/**
 * FRIDAY · installer/migration
 *
 * Applies data migrations when an older workspace is opened by a newer build. Every applied migration is recorded so it never runs twice.
 */
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
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

export interface MigrationRecord {
  id: string;
  appliedAt: number;
  /** The app version that applied it. Rows written before this field existed have none. */
  appVersion?: string;
}

export interface Migration {
  id: string;
  describe: string;
  run(root: string): void;
}

const ledgerFile = (root: string) => path.join(root, "database", "migrations.json");

// The one rule for reading the ledger lives in the boot runner (electron/data-migrations.cjs); both call it.
const bootRunner = createRequire(import.meta.url)("../../electron/data-migrations.cjs") as {
  readLedger(root: string): { rows: unknown[]; source: "file" | "backup" | "none" } | null;
  settleLedger(root: string): boolean;
};

/**
 * Makes the ledger safe to run on: a damaged main file with a good backup is rebuilt from that backup. False
 * means leave it alone: it exists but cannot be read (or the backup could not be copied over a locked file).
 */
export const settleLedger = (root: string): boolean => bootRunner.settleLedger(root);

/** Built-in workspace migrations, oldest first. */
export const MIGRATIONS: Migration[] = [
  {
    id: "0001-config-capabilities",
    describe: "create config/capabilities.json for persisted capability toggles",
    run(root) {
      const file = path.join(root, "config", "capabilities.json");
      // A missing main file with a readable .bak is still the owner's record: leave it to the readers.
      if (!exists(file) && !readJson(`${file}.bak`)) writeJson(file, {});
    },
  },
];

export function appliedMigrations(root = capabilities.getRoot()): MigrationRecord[] {
  return (bootRunner.readLedger(root)?.rows ?? []) as MigrationRecord[];
}

export function runMigrations(
  root = capabilities.getRoot(),
  appVersion?: string | null,
): MigrationRecord[] {
  // A ledger that cannot be read is left as it is: writing a fresh list over it would run everything again.
  if (!settleLedger(root)) return [];
  const applied = appliedMigrations(root);
  // A row that is not an object (null, a number) cannot name a migration: it is kept and skipped, as the boot runner does.
  const seen = new Set(applied.map((m) => m?.id));
  for (const migration of MIGRATIONS) {
    if (seen.has(migration.id)) continue;
    migration.run(root);
    applied.push({
      id: migration.id,
      appliedAt: Date.now(),
      ...(appVersion ? { appVersion } : {}),
    });
  }
  writeJson(ledgerFile(root), applied);
  return applied;
}

export type MigrationModule = FridayModule;

export const migrationModule: MigrationModule = {
  id: "installer/migration",
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    ctx.log("info", "installer/migration ready");
  },
};

export default migrationModule;
