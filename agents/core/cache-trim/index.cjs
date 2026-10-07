// FRIDAY · agents/core/cache-trim
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const DEFAULT_FOLDER = path.join(os.tmpdir(), "friday-cache");
const CACHE_NAME = /cache|tmp|\.log$/i;

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

function plan({ folder = DEFAULT_FOLDER, olderThanDays = 14 } = {}) {
  if (!fs.existsSync(folder)) {
    return {
      ok: true,
      folder,
      scanned: 0,
      candidates: [],
      reclaim: "0 B",
      reclaimBytes: 0,
      actionable: false,
      note: `Folder not found: ${folder}`,
    };
  }
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
    if (stat.mtimeMs >= cutoff) continue;
    if (!CACHE_NAME.test(entry.name)) continue;
    candidates.push({
      name: entry.name,
      path: full,
      size: humanSize(stat.size),
      bytes: stat.size,
      age: `${Math.round((Date.now() - stat.mtimeMs) / 86400000)}d`,
      reason: "stale cache",
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
