// FRIDAY · agents/core/downloads-cleanup
//
// Real agent. Two phases:
//   plan()  — reads the folder and returns the exact file list it would remove
//   run()   — deletes ONLY the files in an approved plan (dryRun defaults true)
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const DEFAULT_FOLDER = path.join(os.homedir(), "Downloads");

function humanSize(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Math.round(value * 10) / 10} ${units[unit]}`;
}

function hashOf(file, bytes = 262144) {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, 0);
    return crypto.createHash("sha1").update(buffer.subarray(0, read)).digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

function plan({ folder = DEFAULT_FOLDER, olderThanDays = 60, largeMb = 512 } = {}) {
  if (!fs.existsSync(folder)) return { ok: false, error: `Folder not found: ${folder}` };
  const cutoff = Date.now() - Number(olderThanDays) * 86400000;
  const files = [];
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(folder, entry.name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    files.push({ name: entry.name, path: full, size: stat.size, mtime: stat.mtimeMs });
  }

  const seen = new Map();
  const duplicates = [];
  for (const file of files) {
    let key;
    try {
      key = `${file.size}:${hashOf(file.path)}`;
    } catch {
      continue;
    }
    if (seen.has(key)) duplicates.push({ ...file, duplicateOf: seen.get(key) });
    else seen.set(key, file.name);
  }

  const stale = files.filter((f) => f.mtime < cutoff);
  const large = files.filter((f) => f.size > Number(largeMb) * 1048576);
  const candidates = [...new Map([...stale, ...duplicates].map((f) => [f.path, f])).values()];
  const total = candidates.reduce((sum, f) => sum + f.size, 0);

  return {
    ok: true,
    folder,
    olderThanDays: Number(olderThanDays),
    scanned: files.length,
    stale: stale.length,
    duplicates: duplicates.length,
    large: large.map((f) => ({ name: f.name, size: humanSize(f.size) })),
    candidates: candidates.map((f) => ({
      name: f.name,
      path: f.path,
      size: humanSize(f.size),
      age: `${Math.round((Date.now() - f.mtime) / 86400000)}d`,
      reason: f.duplicateOf ? `duplicate of ${f.duplicateOf}` : "stale",
    })),
    reclaim: humanSize(total),
    reclaimBytes: total,
    actionable: candidates.length > 0,
  };
}

/**
 * dryRun defaults to true: nothing is ever deleted unless the caller has shown
 * the plan to the owner and explicitly passes dryRun:false with approved:true.
 */
async function run(input = {}) {
  const preview = plan(input);
  if (!preview.ok) return preview;
  const dryRun = input.dryRun !== false;
  if (dryRun) return { ...preview, dryRun: true, deleted: [] };
  if (!input.approved)
    return { ...preview, dryRun: true, error: "Deletion requires an approved plan." };

  const deleted = [];
  const failed = [];
  for (const file of preview.candidates) {
    try {
      fs.rmSync(file.path, { force: true });
      deleted.push(file.name);
    } catch (error) {
      failed.push({ name: file.name, error: String(error.message || error) });
    }
  }
  return { ...preview, dryRun: false, deleted, failed, freed: preview.reclaim };
}

module.exports = { plan, run, DEFAULT_FOLDER };
