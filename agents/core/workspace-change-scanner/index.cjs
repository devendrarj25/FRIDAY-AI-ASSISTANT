// FRIDAY · agents/core/workspace-change-scanner
const fs = require("node:fs");
const path = require("node:path");

const SKIP = new Set(["node_modules", ".git", "dist", "release", ".venv", "__pycache__"]);

function walk(folder, depth, maxDepth, since, files) {
  if (depth > maxDepth || files.length >= 400) return;
  let entries;
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) walk(full, depth + 1, maxDepth, since, files);
    else if (entry.isFile()) {
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs >= since) {
          files.push({
            name: entry.name,
            path: full,
            mtime: stat.mtimeMs,
            ageHours: Math.round((Date.now() - stat.mtimeMs) / 3600000),
          });
        }
      } catch {
        /* skip */
      }
    }
    if (files.length >= 400) return;
  }
}

function plan({ folder = process.cwd(), sinceHours = 24, maxDepth = 2 } = {}) {
  if (!fs.existsSync(folder)) return { ok: false, error: `Folder not found: ${folder}` };
  const since = Date.now() - Number(sinceHours) * 3600000;
  const files = [];
  walk(folder, 0, Number(maxDepth) || 2, since, files);
  return {
    ok: true,
    folder,
    sinceHours: Number(sinceHours),
    count: files.length,
    files: files.slice(0, 100),
    actionable: false,
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
