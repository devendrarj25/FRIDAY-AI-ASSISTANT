// FRIDAY · agents/core/temp-file-cleanup
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const DEFAULT_FOLDER = os.tmpdir();
const TEMP_NAME = /\.(tmp|temp|bak|old)$/i;

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

function plan({ folder = DEFAULT_FOLDER, olderThanDays = 7 } = {}) {
  if (!fs.existsSync(folder)) return { ok: false, error: `Folder not found: ${folder}` };
  const cutoff = Date.now() - Number(olderThanDays) * 86400000;
  const candidates = [];
  let scanned = 0;
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    scanned += 1;
    const full = path.join(folder, entry.name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.mtimeMs >= cutoff && !TEMP_NAME.test(entry.name)) continue;
    if (stat.mtimeMs >= cutoff) continue;
    candidates.push({
      name: entry.name,
      path: full,
      size: humanSize(stat.size),
      bytes: stat.size,
      age: `${Math.round((Date.now() - stat.mtimeMs) / 86400000)}d`,
      reason: "stale temp",
    });
    if (candidates.length >= 200) break;
  }
  const total = candidates.reduce((sum, f) => sum + f.bytes, 0);
  return {
    ok: true,
    folder,
    olderThanDays: Number(olderThanDays),
    scanned,
    candidates,
    reclaim: humanSize(total),
    reclaimBytes: total,
    actionable: candidates.length > 0,
  };
}

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
