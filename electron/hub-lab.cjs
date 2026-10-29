// FRIDAY · Hub lab.
//
// The Hub stages anything the owner brings in (ZIP, folder, loose file, GitHub
// clone, another AI project, or a newer FRIDAY build) inside
// <workspace>/updates/import-* — never in the live tree. This module reads that
// staged copy and answers two questions FRIDAY needs before adopting anything:
//
//   1. what capabilities does this package actually contain?
//   2. which of them are new or newer than what FRIDAY already has?
//
// It then installs only the capabilities the owner selected, with the same
// backup/rollback contract the importer already uses. Nothing here re-implements
// extraction, classification or the sandbox — it reuses importer.cjs,
// import-classify.cjs and sandbox-lab.cjs.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const importer = require("./importer.cjs");
const { classify, inspectPackage } = require("./import-classify.cjs");
const transaction = require("./import-transaction.cjs");

const hashFile = (file) => {
  try {
    return crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
};

const KIND_BY_TREE = {
  skills: "skill",
  agents: "agent",
  tools: "tool",
  plugins: "plugin",
  modules: "module",
  workflows: "workflow",
  models: "model",
  "brain-data": "knowledge",
  memory: "memory",
  core: "core",
  electron: "desktop",
  src: "interface",
  kernel: "kernel",
  scripts: "build",
  config: "config",
  installer: "installer",
  updates: "unsorted",
  workspace: "project",
};

/** Group key for one destination path: the capability folder it belongs to. */
function groupOf(dest) {
  const parts = dest.split("/").filter(Boolean);
  if (parts.length <= 2) return parts.join("/") || dest;
  const tree = parts[0];
  // Registry trees keep <tree>/<segment>/<item>; everything else groups by
  // its first two folders so an app area stays one reviewable unit.
  if (KIND_BY_TREE[tree] && parts.length >= 3) return parts.slice(0, 3).join("/");
  return parts.slice(0, 2).join("/");
}

function readManifest(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    return typeof raw === "object" && raw ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Inspect a staged folder and describe every capability inside it.
 * Returns { ok, candidates:[…], summary }.
 */
function analyze({ root, dir }) {
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };
  if (!dir || !fs.existsSync(dir)) {
    return { ok: false, error: "That staged import is gone — bring it in again." };
  }
  const info = inspectPackage(dir, path.basename(dir));
  const files = importer.walk(dir);
  if (!files.length) return { ok: false, error: "There are no readable files in this import." };

  const groups = new Map();
  for (const file of files) {
    const verdict = classify(file.path, { ...info, full: file.full });
    const key = groupOf(verdict.dest);
    const current = path.join(root, verdict.dest);
    let state = "new";
    if (fs.existsSync(current)) {
      state = hashFile(current) === hashFile(file.full) ? "same" : "newer";
    }
    const bucket = groups.get(key) || {
      id: key,
      dest: key,
      tree: key.split("/")[0],
      kind: KIND_BY_TREE[key.split("/")[0]] || "unknown",
      name: key.split("/").pop(),
      files: 0,
      bytes: 0,
      new: 0,
      newer: 0,
      same: 0,
      hot: verdict.hot,
      reason: verdict.reason,
      manifest: null,
      samples: [],
    };
    bucket.files += 1;
    bucket.bytes += file.size;
    bucket[state] += 1;
    if (bucket.samples.length < 8) bucket.samples.push(file.path);
    if (!bucket.manifest && path.basename(file.path) === "manifest.json") {
      bucket.manifest = readManifest(path.dirname(file.full));
    }
    groups.set(key, bucket);
  }

  const candidates = [...groups.values()]
    .map((group) => ({
      ...group,
      status: group.new ? "new" : group.newer ? "updated" : "identical",
      name: group.manifest?.name || group.name,
      kind: group.manifest?.kind || group.kind,
      version: group.manifest?.version || null,
      description: group.manifest?.description || group.reason,
    }))
    .sort((a, b) => b.new + b.newer - (a.new + a.newer) || b.files - a.files);

  return {
    ok: true,
    dir,
    mode: info.mode,
    label: info.label,
    packageName: info.packageName,
    candidates,
    summary: {
      total: files.length,
      groups: candidates.length,
      new: candidates.filter((c) => c.status === "new").length,
      updated: candidates.filter((c) => c.status === "updated").length,
      identical: candidates.filter((c) => c.status === "identical").length,
    },
  };
}

/**
 * Install only the selected capability groups from a staged folder.
 * Everything touched is backed up first, exactly like a full import.
 */
function extract({ root, dir, groups = [], keepBackup = true }) {
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };
  if (!dir || !fs.existsSync(dir)) {
    return { ok: false, error: "That staged import is gone — bring it in again." };
  }
  const wanted = (groups || []).map(String).filter(Boolean);
  if (!wanted.length) return { ok: false, error: "Select at least one capability first." };

  const info = inspectPackage(dir, path.basename(dir));
  const selected = importer
    .walk(dir)
    .map((file) => ({ ...file, ...classify(file.path, { ...info, full: file.full }) }))
    .filter((file) => wanted.some((g) => file.dest === g || file.dest.startsWith(`${g}/`)))
    .filter((file) => {
      const current = path.join(root, file.dest);
      return !fs.existsSync(current) || hashFile(current) !== hashFile(file.full);
    });

  if (!selected.length) {
    return { ok: true, applied: 0, backup: null, placed: [], restartRequired: false };
  }

  const tops = new Set(selected.map((f) => f.dest.split("/")[0]));
  const { backup, stamp } = transaction.createBackup({
    root,
    prefix: "hub",
    tops: [...tops],
    details: { mode: "hub-extract", files: selected.map((f) => f.dest) },
  });

  const placed = new Map();
  let applied = 0;
  try {
    for (const file of selected) {
      const target = path.join(root, file.dest);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file.full, target);
      const home = file.dest.split("/").slice(0, 2).join("/");
      placed.set(home, (placed.get(home) || 0) + 1);
      applied += 1;
    }
  } catch (error) {
    transaction.restoreBackup({ root, backup });
    return { ok: false, error: `Extraction failed and was rolled back: ${error.message}` };
  }

  if (!keepBackup) {
    try {
      fs.rmSync(backup, { recursive: true, force: true });
    } catch {
      /* keep it when the OS still holds a handle */
    }
  }
  return {
    ok: true,
    applied,
    backup: keepBackup ? backup : null,
    placed: [...placed.entries()].map(([dir_, files]) => ({ dir: dir_, files })),
    restartRequired: selected.some((f) => !f.hot),
    at: stamp,
  };
}

/**
 * Real path containment. A string prefix test would accept a sibling folder
 * whose name merely starts with the base ("...\import-evil" inside "import"),
 * so the relative path is checked instead.
 */
function contains(base, target) {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Read one staged file for preview / editing (text only, capped). */
function readStaged({ dir, file, limit = 400_000 }) {
  const full = path.resolve(dir, String(file || ""));
  if (!contains(dir, full)) return { ok: false, error: "Path outside the import." };
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return { ok: false, error: "That file is not in this import." };
  }
  const size = fs.statSync(full).size;
  if (size > limit) return { ok: false, error: `File too large to preview (${size} bytes).` };
  const buffer = fs.readFileSync(full);
  if (buffer.includes(0)) return { ok: false, error: "Binary file — preview not available." };
  return { ok: true, file, size, content: buffer.toString("utf8") };
}

/** Save an edit back into the staged copy (never into the live tree). */
function writeStaged({ dir, file, content }) {
  const full = path.resolve(dir, String(file || ""));
  if (!contains(dir, full)) return { ok: false, error: "Path outside the import." };
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, String(content ?? ""), "utf8");
  return { ok: true, file, bytes: Buffer.byteLength(String(content ?? "")) };
}

/** Flat file listing of a staged import for the workbench tree. */
function listStaged({ dir, limit = 4000 }) {
  if (!dir || !fs.existsSync(dir)) return { ok: false, error: "Nothing staged.", files: [] };
  const info = inspectPackage(dir, path.basename(dir));
  const files = importer
    .walk(dir)
    .slice(0, limit)
    .map((file) => ({
      path: file.path,
      size: file.size,
      dest: classify(file.path, { ...info, full: file.full }).dest,
    }));
  return { ok: true, files, total: files.length };
}

module.exports = { analyze, extract, readStaged, writeStaged, listStaged };
