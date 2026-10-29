// FRIDAY · agents/core/build-artifact-scanner
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
const MAX_DEPTH = 3;

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
  const NAMES = new Set(["dist", ".next", "target", "build", "coverage", "out", "win-unpacked"]);
  for (const dir of dirs) {
    if (!NAMES.has(dir.name)) continue;
    let bytes = 0;
    let mtime = 0;
    walk(dir.path, 0, 2, (file) => {
      bytes += file.bytes;
      mtime = Math.max(mtime, file.mtime);
    });
    candidates.push({
      name: dir.name,
      path: dir.path,
      bytes,
      size: humanSize(bytes),
      ageDays: mtime ? Math.round((Date.now() - mtime) / 86400000) : null,
      reason: "build artifact",
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
