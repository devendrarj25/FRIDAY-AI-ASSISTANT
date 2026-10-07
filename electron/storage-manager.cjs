/**
 * FRIDAY · storage ownership manager
 *
 * ONE place that answers "what already exists in this FRIDAY root, where does
 * a new resource belong, and what may be deleted?". It exists so installs,
 * updates and uninstalls can never scatter duplicate copies of models, voices,
 * runtimes, tools or character assets around the machine.
 *
 * Hard rules encoded here:
 *   * every resource kind has exactly ONE canonical folder inside FRIDAY_ROOT
 *     (plus known legacy locations that are only ever *reused*, never seeded);
 *   * an existing compatible resource is detected and reported so callers skip
 *     a re-download;
 *   * only genuinely temporary areas are cleanable — user data, memory,
 *     conversations, config, credentials, models and runtimes never are.
 *
 * Real filesystem reads only. Nothing here is estimated or invented.
 */

const fs = require("node:fs");
const path = require("node:path");

const paths = require("./friday-paths.cjs");

/**
 * Canonical home of each resource kind, with the historical folders a previous
 * FRIDAY version may have used. First entry is canonical; the rest are reuse
 * candidates so nothing is downloaded twice after an upgrade.
 */
const RESOURCES = {
  models: { canonical: "models", legacy: ["Models", "data/models", "cache/models"], shared: true },
  voices: { canonical: "voices", legacy: ["resources/voices", "assets/voices"], shared: true },
  runtime: { canonical: "runtime", legacy: ["app/runtime", ".venv"], shared: true },
  character: {
    canonical: "assets/character",
    legacy: ["character", "resources/character"],
    shared: true,
  },
  tools: { canonical: "tools", legacy: ["Tools"], shared: false },
  skills: { canonical: "skills", legacy: ["Skills"], shared: false },
  agents: { canonical: "agents", legacy: ["Agents"], shared: false },
  plugins: { canonical: "plugins", legacy: ["Plugins"], shared: false },
  modules: { canonical: "modules", legacy: ["Modules"], shared: false },
  workflows: { canonical: "workflows", legacy: ["Workflows"], shared: false },
};

/** Areas the janitor may empty. Everything else in the root is user-owned. */
const TEMPORARY_AREAS = [
  { rel: "temporary", maxAgeMs: 24 * 60 * 60 * 1000 },
  { rel: "cache/downloads", maxAgeMs: 24 * 60 * 60 * 1000 },
  { rel: "updates/pending", maxAgeMs: 7 * 24 * 60 * 60 * 1000 },
  { rel: "installer/logs", maxAgeMs: 30 * 24 * 60 * 60 * 1000 },
  { rel: "logs/installer", maxAgeMs: 30 * 24 * 60 * 60 * 1000 },
];

/** Never removable, whatever a caller asks for. */
const PROTECTED_AREAS = [
  "config",
  "security",
  "memory",
  "conversations",
  "brain-data",
  "database",
  "models",
  "voices",
  "runtime",
  "agents",
  "skills",
  "plugins",
  "modules",
  "workflows",
  "backups",
  "projects",
];

const resolveIn = (root, rel) => path.join(root, ...String(rel).split("/"));

/**
 * Windows and macOS volumes are case-insensitive: `models` and a legacy
 * `Models` are the SAME folder there. Compare locations by this key so a
 * canonical folder is never reported as a duplicate of itself.
 */
const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";
const locationKey = (target) => {
  const resolved = path.resolve(target);
  return CASE_INSENSITIVE ? resolved.toLowerCase() : resolved;
};

function isProtected(root, target) {
  const resolved = path.resolve(target);
  return PROTECTED_AREAS.some((area) => {
    const base = path.resolve(resolveIn(root, area));
    const rel = path.relative(base, resolved);
    return resolved === base || (rel && !rel.startsWith("..") && !path.isAbsolute(rel));
  });
}

function statSafe(target) {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

function listSafe(target) {
  try {
    return fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Recursive size/count of a folder, capped so a huge model store stays cheap. */
function measure(target, limit = 20000) {
  let files = 0;
  let bytes = 0;
  const stack = [target];
  while (stack.length && files < limit) {
    const current = stack.pop();
    for (const entry of listSafe(current)) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      const stat = statSafe(full);
      if (!stat) continue;
      files += 1;
      bytes += stat.size;
      if (files >= limit) break;
    }
  }
  return { files, bytes };
}

/**
 * The one location a resource kind may be written to. An existing legacy copy
 * wins so a reinstall keeps using what is already on disk instead of creating
 * a second folder beside it.
 */
function resourcePath(root, kind) {
  const spec = RESOURCES[kind];
  if (!spec) throw new Error(`Unknown FRIDAY resource: ${kind}`);
  for (const rel of [spec.canonical, ...spec.legacy]) {
    const full = resolveIn(root, rel);
    if (fs.existsSync(full)) return full;
  }
  return resolveIn(root, spec.canonical);
}

/**
 * What already exists in this root. Callers (installer, model downloader,
 * runtime repair, character runtime) use `reusable` to skip work.
 */
function inventory(root) {
  const at = new Date().toISOString();
  const resources = {};
  for (const [kind, spec] of Object.entries(RESOURCES)) {
    const target = resourcePath(root, kind);
    const exists = Boolean(statSafe(target)?.isDirectory());
    const measured = exists ? measure(target) : { files: 0, bytes: 0 };
    const seen = new Set([locationKey(target)]);
    const duplicates = [spec.canonical, ...spec.legacy]
      .map((rel) => resolveIn(root, rel))
      .filter((full) => {
        const key = locationKey(full);
        if (seen.has(key) || !fs.existsSync(full)) return false;
        seen.add(key);
        return true;
      });

    resources[kind] = {
      kind,
      path: target,
      canonical: resolveIn(root, spec.canonical),
      shared: spec.shared,
      exists,
      files: measured.files,
      bytes: measured.bytes,
      reusable: exists && measured.files > 0,
      duplicates,
    };
  }
  return {
    schemaVersion: 1,
    root,
    profile: paths.profile(),
    at,
    resources,
    reusable: Object.values(resources)
      .filter((r) => r.reusable)
      .map((r) => r.kind),
    duplicates: Object.values(resources).flatMap((r) => r.duplicates),
  };
}

/** Remove stale temporary/installer/update leftovers. Never touches user data. */
function cleanTemporary(root, { now = Date.now() } = {}) {
  const removed = [];
  const kept = [];
  if (!root) return { removed, kept, bytes: 0 };
  let bytes = 0;

  const remove = (full) => {
    if (isProtected(root, full)) {
      kept.push(full);
      return;
    }
    const stat = statSafe(full);
    if (!stat) return;
    const size = stat.isDirectory() ? measure(full).bytes : stat.size;
    try {
      fs.rmSync(full, { recursive: true, force: true });
      removed.push(path.relative(root, full).replace(/\\/g, "/"));
      bytes += size;
    } catch {
      kept.push(full);
    }
  };

  for (const area of TEMPORARY_AREAS) {
    const base = resolveIn(root, area.rel);
    if (!statSafe(base)?.isDirectory()) continue;
    for (const entry of listSafe(base)) {
      const full = path.join(base, entry.name);
      if (entry.name === ".gitkeep") continue;
      const stat = statSafe(full);
      if (!stat) continue;
      if (now - stat.mtimeMs < area.maxAgeMs) continue;
      remove(full);
    }
  }

  // Half-written atomic writes and aborted downloads at any depth of the
  // root's own descriptor level.
  for (const entry of listSafe(root)) {
    if (!entry.isFile()) continue;
    if (/\.(tmp|part|partial|download)$/i.test(entry.name)) remove(path.join(root, entry.name));
  }

  return { removed, kept, bytes };
}

/**
 * Startup pass: make sure the root is structurally sound, record what already
 * exists and clean leftovers. Returns the report written to <root>/storage.json.
 */
function prepare(root, { version = "0.0.0", clean = true, now = Date.now() } = {}) {
  if (!root) return null;
  const structure = paths.ensureStructure(root);
  const cleaned = clean ? cleanTemporary(root, { now }) : { removed: [], kept: [], bytes: 0 };
  const report = {
    ...inventory(root),
    version: String(version),
    structure: { created: structure.created.length, migrated: structure.migrated },
    cleaned: { removed: cleaned.removed, bytes: cleaned.bytes },
  };
  try {
    const file = path.join(root, "storage.json");
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch {
    /* an unwritable root is reported by paths.verifyRoot() */
  }
  return report;
}

module.exports = {
  RESOURCES,
  TEMPORARY_AREAS,
  PROTECTED_AREAS,
  isProtected,
  resourcePath,
  inventory,
  cleanTemporary,
  prepare,
};
