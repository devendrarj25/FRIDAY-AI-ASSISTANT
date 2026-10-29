// FRIDAY · agents/core/config-backup-reminder
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

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

function defaultSources() {
  const folders = [];
  const envRoot = process.env.FRIDAY_ROOT;
  if (envRoot) folders.push(path.join(envRoot, "config"));
  folders.push(path.join(process.cwd(), "config"));
  return [...new Set(folders.filter((dir) => fs.existsSync(dir)))];
}

function listFiles(folder, relative, out) {
  let entries;
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(folder, entry.name);
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) listFiles(full, rel, out);
    else if (entry.isFile()) {
      try {
        const stat = fs.statSync(full);
        out.push({ name: entry.name, path: full, relative: rel, size: stat.size });
      } catch {
        /* skip */
      }
    }
    if (out.length >= 400) return;
  }
}

function plan(input = {}) {
  const folders =
    Array.isArray(input.folders) && input.folders.length
      ? input.folders.map(String)
      : defaultSources();
  const dest =
    input.dest || path.join(os.homedir(), "FRIDAY-backups", new Date().toISOString().slice(0, 10));
  const files = [];
  const missing = [];
  for (const folder of folders) {
    if (!fs.existsSync(folder)) {
      missing.push(folder);
      continue;
    }
    listFiles(folder, path.basename(folder), files);
  }
  const total = files.reduce((sum, f) => sum + f.size, 0);
  let destAgeDays = null;
  if (fs.existsSync(dest)) {
    try {
      destAgeDays = Math.round((Date.now() - fs.statSync(dest).mtimeMs) / 86400000);
    } catch {
      destAgeDays = null;
    }
  }
  return {
    ok: true,
    folders,
    folder: dest,
    dest,
    missing,
    scanned: files.length,
    candidates: files.map((f) => ({
      name: f.name,
      path: f.path,
      relative: f.relative,
      size: humanSize(f.size),
      bytes: f.size,
      dest: path.join(dest, f.relative),
    })),
    reclaim: humanSize(total),
    count: files.length,
    destAgeDays,
    actionable: files.length > 0 && (destAgeDays == null || destAgeDays >= 7),
  };
}

async function run(input = {}) {
  const preview = plan(input);
  if (!preview.ok) return preview;
  const dryRun = input.dryRun !== false;
  if (dryRun) return { ...preview, dryRun: true, copied: [] };
  if (!input.approved)
    return { ...preview, dryRun: true, error: "Copying requires an approved plan." };
  const copied = [];
  const failed = [];
  for (const file of preview.candidates) {
    try {
      fs.mkdirSync(path.dirname(file.dest), { recursive: true });
      fs.copyFileSync(file.path, file.dest);
      copied.push(file.relative);
    } catch (error) {
      failed.push({ name: file.relative, error: String(error.message || error) });
    }
  }
  return { ...preview, dryRun: false, copied, failed };
}

module.exports = { plan, run };
