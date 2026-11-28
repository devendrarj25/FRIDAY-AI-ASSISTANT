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
      // A missing main file with a readable .bak is a record the readers still find (capabilities.cjs
      // readStateFile): a fresh {} would hide its forks and tombstones, so nothing is created.
      if (fs.existsSync(file) || safeWrite.readJsonSafe(`${file}.bak`, null).value) return;
      safeWrite.writeJsonSafe(file, {}, 2, { keepBackup: false });
    },
  },
];

/** The rows of a ledger text (a leading byte order mark is ignored), or null when it is not a JSON list. */
function parseRows(text) {
  try {
    const value = JSON.parse(String(text).replace(/^\uFEFF/, ""));
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function rowsOf(file, fsApi) {
  try {
    return parseRows(fsApi.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The one rule for reading the ledger, used by boot and by installer/migration (so by the updater): the main
 * file answers when it is a JSON list; otherwise a .bak that is a JSON list answers. Truncated JSON, an empty
 * file, and valid JSON that is not a list ("{}", "null") all count as damaged.
 * Returns the rows and where they came from ("file", "backup", or "none" when there is no ledger yet), or null
 * when a ledger exists but neither it nor its backup can be read.
 */
function readLedger(root, { fsApi = fs } = {}) {
  const file = ledgerFile(root);
  const backup = `${file}.bak`;
  if (!fsApi.existsSync(file) && !fsApi.existsSync(backup)) return { rows: [], source: "none" };
  const main = rowsOf(file, fsApi);
  if (main) return { rows: main, source: "file" };
  const saved = rowsOf(backup, fsApi);
  return saved ? { rows: saved, source: "backup" } : null;
}

/**
 * Makes the ledger safe for a runner that reads only the main file: a damaged main file with a good backup is
 * rebuilt from that backup. False means "leave it alone and run nothing": the ledger exists but cannot be
 * read, or the backup could not be copied over a locked main file. Never throws.
 */
function settleLedger(root, { fsApi = fs } = {}) {
  const ledger = readLedger(root, { fsApi });
  if (!ledger) return false;
  if (ledger.source !== "backup") return true;
  try {
    const file = ledgerFile(root);
    fsApi.copyFileSync(`${file}.bak`, file);
    return true;
  } catch {
    return false;
  }
}

function appliedMigrations(root) {
  return readLedger(root)?.rows || [];
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
    const ledger = readLedger(root);
    if (!ledger)
      return { applied: [], error: "the migration ledger is damaged and was left as it is" };
    const rows = ledger.rows;
    const seen = new Set(rows.map((row) => row && row.id));
    const pending = migrations.filter((migration) => !seen.has(migration.id));
    if (!pending.length) return { applied: [] };

    const file = ledgerFile(root);
    // The ledger read from the main file is copied to .bak before anything runs. A ledger read from the backup
    // never overwrites it: the main file is the damaged one then.
    const backup = `${file}.bak`;
    let before = null;
    let copied = false;
    if (ledger.source === "file") {
      try {
        before = fs.existsSync(backup) ? fs.readFileSync(backup) : null;
        fs.copyFileSync(file, backup);
        copied = true;
      } catch {
        /* the write below keeps a backup of its own */
      }
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
    if (applied.length) {
      safeWrite.writeJsonSafe(file, rows, 2, { keepBackup: ledger.source === "file" });
    } else if (copied) {
      // Nothing was recorded, so the backup goes back to what it was.
      try {
        if (before) fs.writeFileSync(backup, before);
        else fs.rmSync(backup, { force: true });
      } catch {
        /* a copy of the unchanged ledger is as good as the old backup */
      }
    }
    return error ? { applied, error } : { applied };
  } catch (cause) {
    return { applied: [], error: String(cause && cause.message ? cause.message : cause) };
  }
}

module.exports = { MIGRATIONS, ledgerFile, readLedger, settleLedger, appliedMigrations, run };
