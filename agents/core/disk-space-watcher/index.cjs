// FRIDAY · agents/core/disk-space-watcher
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const DEFAULT_FOLDER = process.cwd();

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

function plan({ folder = DEFAULT_FOLDER, warnPct = 90 } = {}) {
  const dir = folder || DEFAULT_FOLDER;
  if (!fs.existsSync(dir)) return { ok: false, error: `Folder not found: ${dir}` };
  if (typeof fs.statfsSync !== "function") {
    return { ok: false, error: "fs.statfsSync is not available in this Node build." };
  }
  try {
    const st = fs.statfsSync(dir);
    const bsize = Number(st.bsize) || 4096;
    const total = Number(st.blocks) * bsize;
    const free = Number(st.bavail != null ? st.bavail : st.bfree) * bsize;
    const usedPct = total ? Math.round((1 - free / total) * 100) : null;
    const threshold = Number(warnPct) || 90;
    return {
      ok: true,
      folder: path.resolve(dir),
      platform: process.platform,
      totalBytes: total,
      freeBytes: free,
      total: humanSize(total),
      free: humanSize(free),
      usedPct,
      warnPct: threshold,
      actionable: typeof usedPct === "number" && usedPct >= threshold,
    };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

async function run(input = {}) {
  const preview = plan(input);
  if (!preview.ok) return preview;
  const dryRun = input.dryRun !== false;
  if (dryRun) return { ...preview, dryRun: true };
  if (!input.approved)
    return {
      ...preview,
      dryRun: true,
      error: "Recording this snapshot requires an approved plan.",
    };
  return { ...preview, dryRun: false, applied: "report-only" };
}

module.exports = { plan, run, DEFAULT_FOLDER, homedir: os.homedir() };
