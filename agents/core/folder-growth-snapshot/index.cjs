// FRIDAY · agents/core/folder-growth-snapshot
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

function plan(input = {}) {
  const folder = input.folder || DEFAULT_FOLDER;
  if (!fs.existsSync(folder)) return missing(folder);
  const snapshotPath = input.snapshot || path.join(folder, ".friday-folder-growth.json");
  let files = 0;
  let bytes = 0;
  walk(folder, 0, Number(input.maxDepth) || 2, (file) => {
    if (file.name === ".friday-folder-growth.json") return;
    files += 1;
    bytes += file.bytes;
  });
  let previous = null;
  if (fs.existsSync(snapshotPath)) {
    try {
      previous = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
    } catch (error) {
      previous = { error: String(error.message || error) };
    }
  }
  const deltaFiles = previous && typeof previous.files === "number" ? files - previous.files : null;
  const deltaBytes = previous && typeof previous.bytes === "number" ? bytes - previous.bytes : null;
  return {
    ok: true,
    folder,
    snapshotPath,
    scanned: files,
    bytes,
    size: humanSize(bytes),
    previous,
    deltaFiles,
    deltaBytes,
    candidates: [{ name: path.basename(snapshotPath), path: snapshotPath, files, bytes }],
    count: files,
    actionable: true,
  };
}

async function run(input = {}) {
  const preview = plan(input);
  if (!preview.ok) return preview;
  const dryRun = input.dryRun !== false;
  if (dryRun) return { ...preview, dryRun: true };
  if (!input.approved)
    return { ...preview, dryRun: true, error: "Writing the snapshot requires an approved plan." };
  const payload = {
    at: Date.now(),
    folder: preview.folder,
    files: preview.scanned,
    bytes: preview.bytes,
  };
  fs.writeFileSync(preview.snapshotPath, `${JSON.stringify(payload, null, 2)}\n`);
  return { ...preview, dryRun: false, wrote: preview.snapshotPath };
}

module.exports = { plan, run };
