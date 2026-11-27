/**
 * Data migrations at boot.
 *
 * A newer build opening an older workspace reshapes stored data here, before the kernel starts. It works on the
 * same ledger (database/migrations.json) and the same migration ids as installer/migration/index.ts, which
 * stays the typed list for the TypeScript side. core/__tests__/data-migrations.test.ts fails when the two lists
 * differ. Each migration runs once; the ledger row carries the app version that applied it.
 *
 * Never throws: a failed step is returned as `error`, earlier steps stay recorded, and boot goes on.
 * FRIDAY_DATA_MIGRATIONS=0 switches it off.
 */
const fs = require("node:fs");
const path = require("node:path");
const safeWrite = require("./safe-write.cjs");

const ledgerFile = (root) => path.join(root, "database", "migrations.json");

/** Built-in workspace migrations, oldest first. Keep in step with installer/migration/index.ts. */
const MIGRATIONS = [
  {
    id: "0001-config-capabilities",
    describe: "create config/capabilities.json for persisted capability toggles",
    run(root) {
      const file = path.join(root, "config", "capabilities.json");
      if (!fs.existsSync(file)) safeWrite.writeJsonSafe(file, {}, 2, { keepBackup: false });
    },
  },
];

/** The ledger rows, or null when the file exists but neither it nor its backup can be read. */
function readLedger(root) {
  const file = ledgerFile(root);
  if (!fs.existsSync(file) && !fs.existsSync(`${file}.bak`)) return [];
  const read = safeWrite.readJsonSafe(file, null);
  return Array.isArray(read.value) ? read.value : null;
}

function appliedMigrations(root) {
  return readLedger(root) || [];
}

function run(
  root,
  appVersion,
  { env = process.env, migrations = MIGRATIONS, now = Date.now } = {},
) {
  if (String(env.FRIDAY_DATA_MIGRATIONS ?? "1").trim() === "0")
    return { applied: [], skipped: "disabled" };
  if (!root) return { applied: [], error: "no FRIDAY folder is set" };
  try {
    const rows = readLedger(root);
    if (!rows)
      return { applied: [], error: "the migration ledger is damaged and was left as it is" };
    const seen = new Set(rows.map((row) => row && row.id));
    const pending = migrations.filter((migration) => !seen.has(migration.id));
    if (!pending.length) return { applied: [] };

    const file = ledgerFile(root);
    try {
      if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
    } catch {
      /* the write below keeps a backup of its own */
    }
    const applied = [];
    let error = null;
    for (const migration of pending) {
      try {
        migration.run(root);
      } catch (cause) {
        error = `${migration.id} failed: ${cause && cause.message ? cause.message : cause}`;
        break;
      }
      rows.push({
        id: migration.id,
        appliedAt: now(),
        ...(appVersion ? { appVersion: String(appVersion) } : {}),
      });
      applied.push(migration.id);
    }
    if (applied.length) safeWrite.writeJsonSafe(file, rows);
    return error ? { applied, error } : { applied };
  } catch (cause) {
    return { applied: [], error: String(cause && cause.message ? cause.message : cause) };
  }
}

module.exports = { MIGRATIONS, ledgerFile, appliedMigrations, run };
