// FRIDAY · agents/core/duplicate-pdf-finder
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
  const maxDepth = Number(input.maxDepth) || 3;
  if (!fs.existsSync(folder)) return missing(folder);
  const files = [];
  walk(folder, 0, maxDepth, (file) => {
    if (/\.pdf$/i.test(file.name)) files.push(file);
  });
  const seen = new Map();
  const extras = [];
  for (const file of files) {
    let key;
    try {
      key = `${file.bytes}:${hashOf(file.path)}`;
    } catch {
      continue;
    }
    if (!seen.has(key)) {
      seen.set(key, file.name);
      continue;
    }
    extras.push({
      ...file,
      size: humanSize(file.bytes),
      duplicateOf: seen.get(key),
      reason: "duplicate pdf",
    });
  }
  const reclaimBytes = extras.reduce((s, f) => s + f.bytes, 0);
  return {
    ok: true,
    folder,
    scanned: files.length,
    candidates: extras.slice(0, 400),
    count: extras.length,
    reclaim: humanSize(reclaimBytes),
    reclaimBytes,
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
  for (const file of preview.candidates || []) {
    try {
      fs.rmSync(file.path, { force: true, recursive: Boolean(file.recursive) });
      deleted.push(file.name);
    } catch (error) {
      failed.push({ name: file.name, error: String(error.message || error) });
    }
  }
  return { ...preview, dryRun: false, deleted, failed, freed: preview.reclaim };
}

module.exports = { plan, run };
