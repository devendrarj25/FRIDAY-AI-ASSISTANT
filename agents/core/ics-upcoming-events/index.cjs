// FRIDAY · agents/core/ics-upcoming-events
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
  const withinDays = Number(input.withinDays) || 14;
  if (!fs.existsSync(folder)) return missing(folder);
  const now = Date.now();
  const until = now + withinDays * 86400000;
  const candidates = [];
  walk(folder, 0, Number(input.maxDepth) || 2, (file) => {
    if (!/\.ics$/i.test(file.name) || file.bytes > 2000000) return;
    const text = readText(file.path, 400000);
    const blocks = text.split(/BEGIN:VEVENT/i).slice(1);
    for (const block of blocks) {
      const start = block.match(/DTSTART[^:]*:([0-9]{8})(T[0-9]{6}Z?)?/);
      const summary = (block.match(/SUMMARY[^:]*:(.+)/) || [, ""])[1].trim();
      if (!start) continue;
      const y = start[1].slice(0, 4);
      const m = start[1].slice(4, 6);
      const d = start[1].slice(6, 8);
      const ms = Date.UTC(Number(y), Number(m) - 1, Number(d));
      if (ms < now || ms > until) continue;
      candidates.push({
        name: file.name,
        path: file.path,
        bytes: 0,
        summary: summary.slice(0, 160),
        date: `${y}-${m}-${d}`,
        reason: "ics upcoming",
      });
    }
  });
  return {
    ok: true,
    folder,
    withinDays,
    scanned: candidates.length,
    candidates,
    count: candidates.length,
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
