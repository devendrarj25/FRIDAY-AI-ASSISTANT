/**
 * FRIDAY · canonical path service
 *
 * ONE authoritative resolver for every FRIDAY-owned location. The folder the
 * user selected is the home of the whole application; nothing FRIDAY owns may
 * be written anywhere else once that folder is known.
 *
 * Resolution order for the root (owned by main.cjs, applied here via setRoot):
 *   1. explicit selection this session (workspace:set / --workspace / env)
 *   2. persisted FRIDAY settings pointer
 *   3. installer-recorded folder (HKCU\Software\FRIDAY -> WorkspacePath)
 *   4. nothing — first run must ask; no invented C:\FRIDAY or home folder.
 *
 * Before a root exists the service falls back to Electron's userData so the
 * very first launch can still log and store its bootstrap pointer. Every
 * caller must go through this module instead of building AppData/home paths.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * Canonical folder names, each with the historical locations FRIDAY may
 * already have used. An existing folder always wins so no user data is
 * orphaned by the rename; otherwise the first (canonical) name is used.
 *
 * The names, aliases and required children all come from the ONE structure
 * contract (electron/friday-contract.cjs) that workspace verification and
 * capability discovery use as well — there is no second folder definition.
 */
const contract = require("./friday-contract.cjs");

const DIRS = Object.fromEntries(contract.NAMES.map((name) => [name, contract.candidates(name)]));

const NAMES = contract.NAMES;

let rootPath = null;
let fallbackPath = path.join(os.tmpdir(), "friday-bootstrap");

/** Electron's userData (or any bootstrap dir) used only before a root exists. */
function setFallbackRoot(dir) {
  if (dir) fallbackPath = dir;
  return fallbackPath;
}

function setRoot(next) {
  rootPath = next ? path.resolve(String(next)) : null;
  return rootPath;
}

const root = () => rootPath;
const hasRoot = () => Boolean(rootPath);
/** The base every path is resolved against right now. */
const base = () => rootPath || fallbackPath;

/**
 * Large, immutable/expensive resources are shared by every profile: models,
 * downloaded voices, the Python runtime, caches and static assets. Nothing in
 * this list is user state, so a test run reuses them instead of downloading a
 * second multi-gigabyte copy beside the production one.
 */
const SHARED_NAMES = new Set([
  "models",
  "voices",
  "runtime",
  "cache",
  "downloads",
  "assets",
  "docs",
  "installer",
]);

/**
 * Mutable data is profile-scoped. "production" is the default and resolves
 * exactly as before (directly under the root) so existing installs are
 * untouched; any other profile (FRIDAY_PROFILE=test, automated runs) keeps its
 * mutable data isolated in <root>/profiles/<name>/… while still sharing the
 * immutable resources above.
 */
let profileName = String(process.env.FRIDAY_PROFILE || "production").trim() || "production";

function setProfile(next) {
  profileName = String(next || "production").trim() || "production";
  return profileName;
}
const profile = () => profileName;
const isSharedName = (name) => SHARED_NAMES.has(name);

/** Where a canonical folder is rooted for the active profile. */
function profileBase(name) {
  const from = base();
  if (profileName === "production" || isSharedName(name)) return from;
  return path.join(from, "profiles", profileName);
}

/**
 * Resolve a canonical folder. With a selected root, an already existing legacy
 * variant is preferred so previous installs keep working in place.
 */
function dir(name) {
  const candidates = DIRS[name];
  if (!candidates) throw new Error(`Unknown FRIDAY path: ${name}`);
  const from = profileBase(name);
  for (const candidate of candidates) {
    const full = path.join(from, ...candidate.split("/"));
    if (fs.existsSync(full) && !isProtectedSourceDir(full, name)) return full;
  }
  return path.join(from, ...candidates[0].split("/"));
}

/** Resolve a folder and make sure it exists (used before a write). */
function ensureDir(name) {
  const full = dir(name);
  try {
    fs.mkdirSync(full, { recursive: true });
  } catch {
    /* a read-only or missing drive is reported by the caller's own write */
  }
  return full;
}

/** A file inside a canonical folder; the folder is not created by this call. */
function file(name, ...parts) {
  return path.join(dir(name), ...parts);
}

/**
 * Where a canonical folder is created for the active profile.
 * Production (and every shared resource) stays directly under the selected
 * root. A test profile's mutable folders live in <root>/profiles/<name>/ so
 * they match `dir()` and never occupy the production copies.
 */
function layoutBase(target, name) {
  if (profileName === "production" || isSharedName(name)) return target;
  return path.join(target, "profiles", profileName);
}

/**
 * Create the full canonical structure inside the selected root — the exact
 * same folder contract `workspace.verifyWorkspace()` checks, including the
 * required sub-folders. Existing folders (canonical or legacy) are mapped,
 * never re-created and never overwritten.
 */
function ensureStructure(target = rootPath) {
  if (!target) return { root: null, created: [], existing: [], migrated: [] };
  const restored = restoreCheckoutCollisions(target);
  const migrated = migrateLegacy(target);
  const created = [];
  const existing = [];
  const makeChildren = (parent, name) => {
    for (const child of contract.FOLDERS[name].children) {
      const full = path.join(parent, child);
      const relative = path.relative(target, full).replace(/\\/g, "/");
      if (fs.existsSync(full)) {
        existing.push(relative);
        continue;
      }
      try {
        fs.mkdirSync(full, { recursive: true });
        created.push(relative);
      } catch {
        /* reported by verifyRoot */
      }
    }
  };
  for (const name of NAMES) {
    const candidates = DIRS[name];
    const base = layoutBase(target, name);
    const found = candidates
      .map((candidate) => path.join(base, ...candidate.split("/")))
      .find((full) => fs.existsSync(full) && !isProtectedSourceDir(full, name));
    if (found) {
      existing.push(path.relative(target, found).replace(/\\/g, "/"));
      makeChildren(found, name);
      continue;
    }
    const full = path.join(base, ...candidates[0].split("/"));
    try {
      fs.mkdirSync(full, { recursive: true });
      created.push(path.relative(target, full).replace(/\\/g, "/"));
      makeChildren(full, name);
    } catch {
      /* reported by verifyRoot */
    }
  }
  // TREES segments (skills/core, tools/filesystem, …) live under the live
  // alias of that tree so a legacy `Tools` folder never grows a second `tools`.
  const seen = new Set(
    [...created, ...existing].map((relative) => relative.replace(/\\/g, "/").toLowerCase()),
  );
  for (const relative of contract.capabilityLayoutFolders()) {
    const slash = relative.indexOf("/");
    if (slash < 0) continue;
    const tree = relative.slice(0, slash);
    const rest = relative.slice(slash + 1);
    const candidates = DIRS[tree];
    if (!candidates) continue;
    const base = layoutBase(target, tree);
    const found = candidates
      .map((candidate) => path.join(base, ...candidate.split("/")))
      .find((full) => fs.existsSync(full) && !isProtectedSourceDir(full, tree));
    const parent = found || path.join(base, ...candidates[0].split("/"));
    const full = path.join(parent, ...rest.split("/"));
    const live = path.relative(target, full).replace(/\\/g, "/");
    if (seen.has(live.toLowerCase()) || fs.existsSync(full)) {
      if (fs.existsSync(full) && !created.includes(live) && !existing.includes(live)) {
        existing.push(live);
      }
      continue;
    }
    try {
      fs.mkdirSync(full, { recursive: true });
      created.push(live);
      seen.add(live.toLowerCase());
    } catch {
      /* reported by verifyRoot */
    }
  }
  return { root: target, created, existing, migrated, restored };
}

/**
 * Legacy folders are a migration concern only — never a second active store.
 *
 * When a historical name exists and the canonical one does not, the folder is
 * *moved* into its canonical place, so exactly one copy stays live. When both
 * exist, nothing is touched (no user data is ever overwritten or merged) and
 * the canonical folder simply stays authoritative for every read and write.
 */
/**
 * Does this relative path exist on disk with EXACTLY this spelling? Windows and
 * macOS are case-insensitive, so `fs.existsSync("models")` is also true when
 * only a legacy `Models` folder exists — which would silently skip the
 * migration and leave the legacy spelling as the live store.
 */
function existsExact(root, relative) {
  let current = path.resolve(root);
  for (const segment of String(relative).split("/")) {
    let entries;
    try {
      entries = fs.readdirSync(current);
    } catch {
      return false;
    }
    if (!entries.includes(segment)) return false;
    current = path.join(current, segment);
  }
  return true;
}

/** True when `dir` is the Python kernel source tree, not a data folder. */
function isSourceKernel(dir) {
  try {
    return (
      fs.existsSync(path.join(dir, "main.py")) && fs.existsSync(path.join(dir, "requirements.txt"))
    );
  } catch {
    return false;
  }
}

/** True when `dir` is the renderer source tree (`src/`), not a data folder. */
function isSourceFrontend(dir) {
  try {
    return (
      fs.existsSync(path.join(dir, "routes")) && fs.existsSync(path.join(dir, "lib", "friday"))
    );
  } catch {
    return false;
  }
}

/**
 * Data-folder aliases (`backend` ← `kernel`, `frontend` ← `src`) must never
 * steal the Git checkout. A selected FRIDAY folder that is also the clone
 * used to rename kernel/ → backend/ and src/ → frontend/.
 */
function isProtectedSourceDir(dir, canonicalName) {
  if (canonicalName === "backend") return isSourceKernel(dir);
  if (canonicalName === "frontend") return isSourceFrontend(dir);
  return false;
}

/**
 * Undo a checkout collision: FastAPI tree sitting in `backend/` or renderer
 * tree sitting in `frontend/` because migrateLegacy ran on the Git root.
 */
function restoreCheckoutCollisions(target) {
  const restored = [];
  if (!target) return restored;
  if (!existsExact(target, "kernel") && existsExact(target, "backend")) {
    const backend = path.join(target, "backend");
    if (isSourceKernel(backend)) {
      try {
        moveDir(backend, path.join(target, "kernel"));
        restored.push({ from: "backend", to: "kernel" });
      } catch {
        /* setup-python still resolves backend/ when it holds requirements.txt */
      }
    }
  }
  if (!existsExact(target, "src") && existsExact(target, "frontend")) {
    const frontend = path.join(target, "frontend");
    if (isSourceFrontend(frontend)) {
      try {
        moveDir(frontend, path.join(target, "src"));
        restored.push({ from: "frontend", to: "src" });
      } catch {
        /* pack still needs src/; the owner can rename by hand if this fails */
      }
    }
  }
  return restored;
}

/** Kernel source used by setup-python / Doctor, never the data `backend` folder. */
function resolveKernelSource(checkoutRoot) {
  if (!checkoutRoot) return null;
  const candidates = [
    path.join(checkoutRoot, "kernel"),
    path.join(checkoutRoot, "resources", "kernel"),
    path.join(checkoutRoot, "App", "resources", "kernel"),
    path.join(checkoutRoot, "backend"),
  ];
  return (
    candidates.find((dir) => {
      try {
        return fs.existsSync(path.join(dir, "requirements.txt")) && isSourceKernel(dir);
      } catch {
        return false;
      }
    }) ||
    candidates.find((dir) => {
      try {
        return fs.existsSync(path.join(dir, "requirements.txt"));
      } catch {
        return false;
      }
    }) ||
    null
  );
}
function moveDir(from, to) {
  const staging = path.join(path.dirname(to), `.friday-migrate-${Date.now().toString(36)}`);
  fs.renameSync(from, staging);
  try {
    fs.renameSync(staging, to);
  } catch (error) {
    fs.renameSync(staging, from);
    throw error;
  }
}

function migrateLegacy(target = rootPath) {
  const moved = [];
  if (!target) return moved;
  for (const name of NAMES) {
    const candidates = DIRS[name];
    const canonicalRel = candidates[0];
    const canonical = path.join(target, ...canonicalRel.split("/"));
    if (existsExact(target, canonicalRel)) continue;
    for (const alias of candidates.slice(1)) {
      if (!existsExact(target, alias)) continue;
      const legacy = path.join(target, ...alias.split("/"));
      if (isProtectedSourceDir(legacy, name)) continue;
      try {
        fs.mkdirSync(path.dirname(canonical), { recursive: true });
        moveDir(legacy, canonical);
        moved.push({ from: alias, to: canonicalRel });
      } catch {
        /* still readable in place; verifyRoot reports an unwritable root */
      }
      break;
    }
  }
  return moved;
}

/**
 * Is this folder usable as a FRIDAY home? Real checks only — existence,
 * directory-ness and a write probe.
 */
function verifyRoot(target) {
  const value = String(target || "").trim();
  if (!value) return { ok: false, error: "No folder selected." };
  const resolved = path.resolve(value);
  try {
    if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true });
    if (!fs.statSync(resolved).isDirectory())
      return { ok: false, error: `${resolved} is a file, not a folder.` };
    const probe = path.join(resolved, ".friday-write-test");
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe, { force: true });
  } catch (error) {
    return { ok: false, error: `${resolved} is not writable: ${error?.message || error}` };
  }
  return { ok: true, root: resolved, existing: describeExisting(resolved) };
}

/** What FRIDAY data already lives in a folder (drives migrate/reuse choices). */
function describeExisting(target) {
  const found = [];
  const dbFile = path.join(target, "database", "friday.sqlite3");
  const legacyDb = path.join(target, "database", "friday.db");
  if (fs.existsSync(dbFile) || fs.existsSync(legacyDb)) found.push("database");
  for (const name of ["memory", "models", "voices", "config", "state", "skills", "agents"]) {
    const candidates = DIRS[name] || [name];
    const hit = candidates
      .map((candidate) => path.join(target, ...candidate.split("/")))
      .find((full) => {
        try {
          return fs.readdirSync(full).length > 0;
        } catch {
          return false;
        }
      });
    if (hit) found.push(name);
  }
  return found;
}

/* ------------------------------------------------------------ known files */

const settingsFile = () => file("config", "friday-settings.json");
const preferencesFile = () => file("config", "friday-preferences.json");
const providerKeysFile = () => file("config", "provider-keys.json");
const screenVisionFile = () => file("config", "friday-screen-vision.json");
const cameraFile = () => file("config", "friday-camera.json");
/**
 * The installed program folder, `<root>/App`. One root holds both roles: the
 * application here, every data folder as its sibling. Returned even when it
 * does not exist yet (development checkouts run from the source tree), so
 * callers can decide whether to read it.
 */
const programDir = () => dir(contract.PROGRAM_FOLDER);

/** True when a path is the program folder or lives inside it. */
function isProgramPath(target) {
  const from = base();
  if (!from || !target) return false;
  const relative = path.relative(from, path.resolve(target)).replace(/\\/g, "/");
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  return contract.isProgramPath(relative);
}

const databaseFile = () => file("database", "friday.sqlite3");
const vectorsDir = () => file("memory", "vectors");
const logFile = () => file("logs", "main.log");
const discoveryCacheFile = () => file("cache", "model-discovery.json");
const stateFile = (namespace) => file("state", `${namespace}.json`);
const storageIdentityFile = () => file("config", "friday-storage.json");

/**
 * Identity of the store the renderer is allowed to cache.
 *
 * The renderer keeps a fast synchronous copy of every namespace in browser
 * storage, which lives with Chromium's profile — NOT inside the FRIDAY root.
 * Without a stamp, deleting the root (uninstall, fresh folder, restore) would
 * leave that copy behind and it would silently become a second store. The id
 * is created once per root and rewritten whenever the root changes, so the
 * renderer can detect "this cache belongs to a different/removed root" and
 * drop it before any engine hydrates.
 */
function storageIdentity({ create = false } = {}) {
  const current = rootPath;
  const target = storageIdentityFile();
  let record = null;
  try {
    record = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    record = null;
  }
  if (record && record.id && (!current || path.resolve(record.root || "") === current)) {
    return record;
  }
  const next = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    root: current,
    createdAt: new Date().toISOString(),
  };
  if (!create || !current) return record?.id ? { ...record, root: current } : next;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    /* unwritable root is reported by verifyRoot; the id stays in-memory */
  }
  return next;
}

/** Everything the UI/diagnostics may want to show, resolved in one call. */
function describe() {
  const out = { root: rootPath, fallback: fallbackPath, usingFallback: !rootPath };
  for (const name of NAMES) out[name] = dir(name);
  return out;
}

/**
 * Write a file ONLY when its content really differs.
 *
 * Several parts of FRIDAY republish the same derived data (the companion
 * feature registry above all) whenever anything upstream notifies. Rewriting
 * an identical file still changes its mtime, which wakes the workspace watcher
 * and shows the owner a "config reloaded" toast for a change that never
 * happened. Returns true only when a real write took place.
 */
function writeIfChanged(target, body) {
  let existing = null;
  try {
    existing = fs.readFileSync(target, "utf8");
  } catch {
    existing = null;
  }
  if (existing === body) return false;
  fs.writeFileSync(target, body, "utf8");
  return true;
}

module.exports = {
  DIRS,
  NAMES,
  setRoot,
  setFallbackRoot,
  root,
  hasRoot,
  base,
  setProfile,
  profile,
  SHARED_NAMES,
  isSharedName,
  dir,
  ensureDir,
  file,
  ensureStructure,
  writeIfChanged,
  programDir,
  isProgramPath,
  migrateLegacy,
  restoreCheckoutCollisions,
  resolveKernelSource,
  isProtectedSourceDir,
  isSourceKernel,
  isSourceFrontend,
  verifyRoot,
  describeExisting,
  describe,
  settingsFile,
  preferencesFile,
  providerKeysFile,
  screenVisionFile,
  cameraFile,
  databaseFile,
  vectorsDir,
  logFile,
  discoveryCacheFile,
  stateFile,
  storageIdentityFile,
  storageIdentity,
};
