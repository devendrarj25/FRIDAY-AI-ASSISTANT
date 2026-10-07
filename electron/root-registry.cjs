/**
 * FRIDAY · root registry, integrity and boot record
 *
 * The selected FRIDAY root is the only authoritative store, so the root itself
 * must be self-describing: a machine-readable pointer (root.json), a live
 * component registry rebuilt from what is really on disk (registry.json), a
 * structural integrity report (integrity.json) and the outcome of the last
 * boot (boot.json).
 *
 * Hard rules implemented here:
 *   * a component is NOT installed merely because its folder exists — it must
 *     have a parsable manifest and, when it declares an entry, that entry file
 *     must exist on disk. Anything else is reported as `invalid`.
 *   * nothing is invented: every field comes from a real filesystem read.
 *   * writes are atomic (tmp + rename) so a crash can never leave a half file.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/** Root-level descriptors this module owns. */
const DESCRIPTOR_FILES = [
  "root.json",
  "permissions.json",
  "registry.json",
  "integrity.json",
  "boot.json",
];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Atomic JSON write — a crash mid-write can never truncate the real file. */
function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

function writeIfAbsent(file, value) {
  if (fs.existsSync(file)) return false;
  return writeJson(file, value);
}

/**
 * The stable pointer that makes a folder recognisable as a FRIDAY root, plus
 * the permission defaults every subsystem reads. Never overwritten: an existing
 * root keeps the owner's choices.
 */
function ensureRootDescriptors(root, options = {}) {
  if (!root) return { created: [] };
  const created = [];
  const version = String(options.version || "0.0.0");
  const now = new Date().toISOString();

  if (
    writeIfAbsent(path.join(root, "root.json"), {
      kind: "friday-root",
      schemaVersion: 1,
      root,
      createdAt: now,
      createdByVersion: version,
    })
  )
    created.push("root.json");

  if (
    writeIfAbsent(path.join(root, "permissions.json"), {
      schemaVersion: 1,
      paidModels: false,
      autoApproveExec: false,
      allowShell: false,
      allowNetwork: true,
      allowScreenCapture: false,
      allowRemoteControl: false,
    })
  )
    created.push("permissions.json");

  const changelog = path.join(root, "CHANGELOG.md");
  if (!fs.existsSync(changelog)) {
    try {
      fs.writeFileSync(
        changelog,
        `# FRIDAY workspace changelog\n\nEvery applied update is appended here by the updater.\n\n## ${version}\n- Workspace initialised on ${now}.\n`,
      );
      created.push("CHANGELOG.md");
    } catch {
      /* read-only root is reported by the integrity pass */
    }
  }

  return { created };
}

/** A declared entry file must actually exist before we call a component real. */
function entryPresent(item) {
  if (!item.entry) return true;
  const base = item.manifestFile ? path.dirname(item.manifestFile) : item.path;
  try {
    return fs.existsSync(path.isAbsolute(item.entry) ? item.entry : path.join(base, item.entry));
  } catch {
    return false;
  }
}

/**
 * Validate one discovered capability. Returns the registry record with a real
 * status and, when it is not usable, the concrete reason.
 */
function validateComponent(item) {
  const reasons = [];
  let exists = false;
  try {
    exists = fs.existsSync(item.path);
  } catch {
    exists = false;
  }
  if (!exists) reasons.push("path missing on disk");
  if (!item.configured || !item.manifestFile) reasons.push("no readable manifest");
  else if (!readJson(item.manifestFile)) reasons.push("manifest is not valid JSON");
  if (exists && item.configured && !entryPresent(item))
    reasons.push(`entry not found: ${item.entry}`);

  return {
    id: item.id,
    tree: item.tree,
    segment: item.segment,
    origin: item.origin,
    name: item.name,
    version: item.version,
    path: item.path,
    manifestFile: item.manifestFile || null,
    entry: item.entry || null,
    risk: item.risk,
    enabled: Boolean(item.enabled),
    status: reasons.length ? "invalid" : "registered",
    reasons,
    checkedAt: Date.now(),
  };
}

/**
 * Rebuild <root>/registry.json from a live capability scan. Callers pass the
 * result of capabilities.list() so there is exactly one discovery engine.
 */
function rebuildRegistry(root, scan = {}, options = {}) {
  const items = Array.isArray(scan.items) ? scan.items : [];
  const components = items.map(validateComponent);
  const counts = {};
  for (const record of components) {
    const bucket = (counts[record.tree] = counts[record.tree] || {
      total: 0,
      registered: 0,
      invalid: 0,
      enabled: 0,
    });
    bucket.total += 1;
    bucket[record.status === "registered" ? "registered" : "invalid"] += 1;
    if (record.enabled && record.status === "registered") bucket.enabled += 1;
  }
  const registry = {
    schemaVersion: 1,
    root,
    version: String(options.version || "0.0.0"),
    rebuiltAt: new Date().toISOString(),
    totals: {
      components: components.length,
      registered: components.filter((c) => c.status === "registered").length,
      invalid: components.filter((c) => c.status !== "registered").length,
    },
    counts,
    components,
  };
  if (root) writeJson(path.join(root, "registry.json"), registry);
  return registry;
}

const sha256 = (file) => {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
};

/**
 * Structural integrity of the root: which canonical folders are present, which
 * descriptors exist and their current digests. Consumed by diagnostics and by
 * the updater to detect a partially applied update.
 */
function writeIntegrity(root, folders = [], options = {}) {
  if (!root) return null;
  const present = [];
  const missing = [];
  for (const folder of folders) {
    const target = path.isAbsolute(folder) ? folder : path.join(root, folder);
    (fs.existsSync(target) ? present : missing).push(path.relative(root, target) || ".");
  }
  const files = {};
  for (const name of [...DESCRIPTOR_FILES, "version.json", "manifest.json", "workspace.json"]) {
    const file = path.join(root, name);
    files[name] = fs.existsSync(file)
      ? { sha256: sha256(file), bytes: fs.statSync(file).size }
      : null;
  }
  const report = {
    schemaVersion: 1,
    root,
    version: String(options.version || "0.0.0"),
    checkedAt: new Date().toISOString(),
    folders: { present: present.length, missing },
    files,
    ok: missing.length === 0,
  };
  writeJson(path.join(root, "integrity.json"), report);
  return report;
}

/** Record the outcome of this boot so the next start can see what happened. */
function writeBootRecord(root, record = {}) {
  if (!root) return null;
  const previous = readJson(path.join(root, "boot.json"));
  const entry = {
    at: new Date().toISOString(),
    version: String(record.version || "0.0.0"),
    ok: Boolean(record.ok),
    ms: Number(record.ms) || 0,
    components: Number(record.components) || 0,
    invalid: Number(record.invalid) || 0,
    notes: Array.isArray(record.notes) ? record.notes.map(String).slice(0, 20) : [],
  };
  const history = Array.isArray(previous?.history) ? previous.history : [];
  const value = { schemaVersion: 1, root, last: entry, history: [entry, ...history].slice(0, 20) };
  writeJson(path.join(root, "boot.json"), value);
  return value;
}

module.exports = {
  DESCRIPTOR_FILES,
  ensureRootDescriptors,
  validateComponent,
  rebuildRegistry,
  writeIntegrity,
  writeBootRecord,
};
