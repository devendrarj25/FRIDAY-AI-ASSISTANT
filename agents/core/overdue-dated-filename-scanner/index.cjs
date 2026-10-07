// FRIDAY · agents/core/overdue-dated-filename-scanner
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "release",
  ".venv",
  "__pycache__",
  ".next",
  "coverage",
  "win-unpacked",
]);

function humanSize(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Math.round(value * 10) / 10} ${units[unit]}`;
}

function missing(folder) {
  return {
    ok: true,
    folder,
    scanned: 0,
    candidates: [],
    count: 0,
    reclaim: "0 B",
    reclaimBytes: 0,
    actionable: false,
    note: `Folder not found: ${folder}`,
  };
}

function walk(folder, depth, maxDepth, onFile, onDir) {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      if (onDir) onDir(full, entry.name);
      if (SKIP.has(entry.name) || entry.name === "." || entry.name === "..") continue;
      walk(full, depth + 1, maxDepth, onFile, onDir);
    } else if (entry.isFile() && onFile) {
      try {
        const stat = fs.statSync(full);
        onFile({
          name: entry.name,
          path: full,
          bytes: stat.size,
          mtime: stat.mtimeMs,
          mode: stat.mode,
        });
      } catch {
        /* skip unreadable */
      }
    }
  }
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

function readText(file, limit = 200000) {
  try {
    const stat = fs.statSync(file);
    if (stat.size > limit)
      return fs.readFileSync(file, { encoding: "utf8", flag: "r" }).slice(0, limit);
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

const DEFAULT_FOLDER = process.cwd();
const MAX_DEPTH = 2;

function plan(input = {}) {
  const folder = input.folder || DEFAULT_FOLDER;
  const maxDepth = Number(input.maxDepth) || MAX_DEPTH;
  const olderThanDays = Number(input.olderThanDays != null ? input.olderThanDays : 30);
  const largeMb = Number(input.largeMb != null ? input.largeMb : 512);
  const cutoff = Date.now() - olderThanDays * 86400000;
  if (!fs.existsSync(folder)) return missing(folder);
  const scanned = [];
  const dirs = [];
  walk(
    folder,
    0,
    maxDepth,
    (file) => scanned.push(file),
    (full, name) => dirs.push({ name, path: full }),
  );
  const candidates = [];
  const ISO = /(20\d{2})[-_.](\d{2})[-_.](\d{2})/;
  const DMY = /(\d{2})[-_.](\d{2})[-_.](20\d{2})/;
  const now = Date.now();
  for (const file of scanned) {
    let ms = null;
    const iso = file.name.match(ISO);
    const dmy = file.name.match(DMY);
    if (iso) ms = Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    else if (dmy) ms = Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
    if (ms == null || ms >= now) continue;
    candidates.push({
      ...file,
      size: humanSize(file.bytes),
      date: new Date(ms).toISOString().slice(0, 10),
      overdueDays: Math.round((now - ms) / 86400000),
      reason: "past date in name",
    });
  }
  const reclaimBytes = candidates.reduce((sum, f) => sum + (Number(f.bytes) || 0), 0);
  return {
    ok: true,
    folder,
    scanned: scanned.length,
    dirs: dirs.length,
    olderThanDays,
    largeMb,
    candidates: candidates.slice(0, 400),
    count: candidates.length,
    reclaim: humanSize(reclaimBytes),
    reclaimBytes,
    actionable: candidates.length > 0,
  };
}

async function run(input = {}) {
  const preview = plan(input);
  if (!preview.ok) return preview;
  const dryRun = input.dryRun !== false;
  if (dryRun) return { ...preview, dryRun: true };
  if (!input.approved)
    return { ...preview, dryRun: true, error: "Recording this report requires an approved plan." };
  return { ...preview, dryRun: false, applied: "report-only" };
}

module.exports = { plan, run };
