// FRIDAY · agents/core/duplicate-photo-finder
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const DEFAULT_FOLDER = path.join(os.homedir(), "Pictures");
const IMAGE = /\.(jpe?g|png|gif|webp|bmp|heic|tif?f)$/i;

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

function walk(folder, depth, maxDepth, files) {
  if (depth > maxDepth || files.length >= 2000) return;
  let entries;
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) walk(full, depth + 1, maxDepth, files);
    else if (entry.isFile() && IMAGE.test(entry.name)) {
      try {
        const stat = fs.statSync(full);
        files.push({ name: entry.name, path: full, size: stat.size });
      } catch {
        /* skip unreadable */
      }
    }
    if (files.length >= 2000) return;
  }
}

function plan({ folder = DEFAULT_FOLDER, maxDepth = 2 } = {}) {
  if (!fs.existsSync(folder)) return { ok: false, error: `Folder not found: ${folder}` };
  const files = [];
  walk(folder, 0, Number(maxDepth) || 2, files);
  const seen = new Map();
  const groups = [];
  const extras = [];
  for (const file of files) {
    let key;
    try {
      key = `${file.size}:${hashOf(file.path)}`;
    } catch {
      continue;
    }
    if (!seen.has(key)) {
      seen.set(key, [file]);
      continue;
    }
    seen.get(key).push(file);
  }
  for (const cluster of seen.values()) {
    if (cluster.length < 2) continue;
    groups.push(cluster.map((f) => f.name));
    extras.push(...cluster.slice(1));
  }
  const total = extras.reduce((sum, f) => sum + f.size, 0);
  return {
    ok: true,
    folder,
    scanned: files.length,
    groups: groups.length,
    candidates: extras.map((f) => ({
      name: f.name,
      path: f.path,
      size: humanSize(f.size),
      bytes: f.size,
      reason: "duplicate photo",
    })),
    reclaim: humanSize(total),
    reclaimBytes: total,
    actionable: extras.length > 0,
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
