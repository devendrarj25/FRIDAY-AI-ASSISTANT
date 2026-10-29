// FRIDAY · canonical filesystem transaction for Import and Hub adoption.
// Records both existing and absent top-level destinations so failure/rollback
// restores the exact pre-operation tree instead of leaving newly-created files.
const fs = require("node:fs");
const path = require("node:path");

function contains(base, target) {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function createBackup({ root, prefix, tops, details = {} }) {
  const stamp = Date.now();
  const backupRoot = path.join(root, "backups");
  const backup = path.join(backupRoot, `${prefix}-${stamp}`);
  const entries = [...new Set(tops)].map((top) => ({
    top,
    existed: fs.existsSync(path.join(root, top)),
  }));
  fs.mkdirSync(backup, { recursive: true });
  for (const entry of entries) {
    if (!entry.existed) continue;
    fs.cpSync(path.join(root, entry.top), path.join(backup, entry.top), {
      recursive: true,
      force: true,
    });
  }
  fs.writeFileSync(
    path.join(backup, "import-manifest.json"),
    JSON.stringify(
      { at: stamp, root, entries, tops: entries.map((entry) => entry.top), ...details },
      null,
      2,
    ),
  );
  return { backup, stamp, entries };
}

function restoreBackup({ root, backup }) {
  const backupRoot = path.join(root, "backups");
  if (!backup || !contains(backupRoot, backup) || !fs.existsSync(backup)) {
    return { ok: false, error: "No valid backup is available for this import." };
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(backup, "import-manifest.json"), "utf8"));
    if (path.resolve(manifest.root || "") !== path.resolve(root)) {
      return { ok: false, error: "This backup belongs to a different FRIDAY workspace." };
    }
    const entries = Array.isArray(manifest.entries)
      ? manifest.entries
      : (manifest.tops || []).map((top) => ({
          top,
          existed: fs.existsSync(path.join(backup, top)),
        }));
    for (const entry of entries) {
      const top = String(entry.top || "");
      if (!top || top.includes("/") || top.includes("\\") || top === "." || top === "..") {
        throw new Error("Backup manifest contains an unsafe destination.");
      }
      const target = path.join(root, top);
      fs.rmSync(target, { recursive: true, force: true });
      if (entry.existed) {
        const saved = path.join(backup, top);
        if (!fs.existsSync(saved)) throw new Error(`Backup is incomplete: ${top}`);
        fs.cpSync(saved, target, { recursive: true });
      }
    }
    return { ok: true, restored: entries.map((entry) => entry.top) };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

module.exports = { contains, createBackup, restoreBackup };
