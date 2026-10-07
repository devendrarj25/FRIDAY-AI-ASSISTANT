// FRIDAY · agents/core/env-example-gap-auditor
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

function keysOf(file) {
  const text = readText(file, 80000);
  const keys = [];
  for (const line of text.split(/\n/)) {
    const trim = line.trim();
    if (!trim || trim.startsWith("#")) continue;
    const key = trim.split("=")[0].trim();
    if (key) keys.push(key);
  }
  return keys;
}

function plan(input = {}) {
  const folder = input.folder || DEFAULT_FOLDER;
  if (!fs.existsSync(folder)) return missing(folder);
  const examples = [];
  const envs = [];
  walk(folder, 0, Number(input.maxDepth) || 3, (file) => {
    if (file.name === ".env.example" || file.name === ".env.sample") examples.push(file);
    if (file.name === ".env") envs.push(file);
  });
  const candidates = [];
  for (const example of examples) {
    const dir = path.dirname(example.path);
    const env = envs.find((e) => path.dirname(e.path) === dir);
    const want = keysOf(example.path);
    const have = new Set(env ? keysOf(env.path) : []);
    const missingKeys = want.filter((k) => !have.has(k));
    candidates.push({
      name: example.name,
      path: example.path,
      bytes: example.bytes,
      envPresent: Boolean(env),
      missingKeys,
      reason: env ? "env key gap" : "no .env beside example",
    });
  }
  return {
    ok: true,
    folder,
    scanned: examples.length,
    candidates,
    count: candidates.reduce((s, r) => s + r.missingKeys.length, 0),
    actionable: candidates.some((r) => r.missingKeys.length > 0 || !r.envPresent),
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
