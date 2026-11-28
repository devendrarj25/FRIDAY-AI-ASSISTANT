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
  const live = liveEntry(from, candidates, name, { spelled: false });
  return live || path.join(from, ...candidates[0].split("/"));
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
  if (!target) return { root: null, created: [], existing: [], migrated: [], skipped: [] };
  const restored = restoreCheckoutCollisions(target);
  const migrated = migrateLegacy(target);
  const checkout = isCheckoutShaped(target);
  const dataOnly = isFridayCheckout(target);
  const created = [];
  const existing = [];
  const skipped = [];
  const list = scanner();
  /** Create a folder unless a link sits on the way: a write never lands outside the root through a junction. */
  const make = (full) => {
    if (throughLink(target, full)) return false;
    try {
      fs.mkdirSync(full, { recursive: true });
      return true;
    } catch {
      return false; /* reported by verifyRoot */
    }
  };
  const makeChildren = (parent, name) => {
    for (const child of contract.FOLDERS[name].children) {
      const live = findEntry(parent, child, { list: scanner() });
      if (live) {
        existing.push(path.relative(target, live).replace(/\\/g, "/"));
        continue;
      }
      const full = path.join(parent, child);
      if (make(full)) created.push(path.relative(target, full).replace(/\\/g, "/"));
    }
  };
  for (const name of NAMES) {
    if (dataOnly ? !CHECKOUT_DATA_NAMES.has(name) : checkout && CHECKOUT_SOURCE_NAMES.has(name)) {
      skipped.push(name);
      continue;
    }
    const candidates = DIRS[name];
    const base = layoutBase(target, name);
    const found = liveEntry(base, candidates, name, { list });
    if (found) {
      existing.push(path.relative(target, found).replace(/\\/g, "/"));
      makeChildren(found, name);
      continue;
    }
    const full = path.join(base, ...candidates[0].split("/"));
    if (make(full)) {
      created.push(path.relative(target, full).replace(/\\/g, "/"));
      makeChildren(full, name);
    }
  }
  // TREES segments (skills/core, tools/filesystem, …) live under the live
  // alias of that tree so a legacy `Tools` folder never grows a second `tools`.
  // A checkout keeps its own source trees: it gets none of them.
  const seen = new Set(
    [...created, ...existing].map((relative) => relative.replace(/\\/g, "/").toLowerCase()),
  );
  for (const relative of dataOnly ? [] : contract.capabilityLayoutFolders()) {
    const slash = relative.indexOf("/");
    if (slash < 0) continue;
    const tree = relative.slice(0, slash);
    const rest = relative.slice(slash + 1);
    const candidates = DIRS[tree];
    if (!candidates) continue;
    const base = layoutBase(target, tree);
    const found = liveEntry(base, candidates, tree, { list });
    const parent = found || path.join(base, ...candidates[0].split("/"));
    const present = findEntry(parent, rest, { list: scanner() });
    const full = present || path.join(parent, ...rest.split("/"));
    const live = path.relative(target, full).replace(/\\/g, "/");
    if (seen.has(live.toLowerCase()) || present) {
      if (present && !created.includes(live) && !existing.includes(live)) {
        existing.push(live);
      }
      continue;
    }
    if (make(full)) {
      created.push(live);
      seen.add(live.toLowerCase());
    }
  }
  return { root: target, created, existing, migrated, restored, skipped };
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
 * The one lookup shared by ensureStructure and migrateLegacy: resolve a
 * relative path (`skills/core`) to the path that really exists on disk.
 * Every segment is read with readdir, so a symlink, a junction or a dangling
 * link counts as present, and `Models` is the same folder as `models` on a
 * case-insensitive disk (no second copy is ever created next to it).
 * `exact` demands the literal spelling instead, which migration needs to tell
 * a legacy name from the canonical one. Returns null when nothing matches.
 */
function findEntry(root, relative, { exact = false, list = readNames } = {}) {
  let current = path.resolve(root);
  for (const segment of String(relative).split("/")) {
    const entries = list(current);
    if (!entries) return null;
    let match = entries.includes(segment) ? segment : null;
    if (!match && !exact) {
      const lower = segment.toLowerCase();
      match = entries.filter((name) => name.toLowerCase() === lower).sort()[0] || null;
    }
    if (!match) return null;
    current = path.join(current, match);
  }
  return current;
}

/** The names in a folder, or null when it cannot be read. */
function readNames(folder) {
  try {
    return fs.readdirSync(folder);
  } catch {
    return null;
  }
}

/** A reader that remembers each folder it has listed, so one lookup pass reads a folder once. */
function scanner() {
  const memo = new Map();
  return (folder) => {
    if (!memo.has(folder)) memo.set(folder, readNames(folder));
    return memo.get(folder);
  };
}

/**
 * The folder that is live for a canonical name: the first candidate (canonical name, then the historical
 * aliases, in contract order) that exists with that spelling, and only then a differently cased copy of one
 * (`Models`), so a real second store (`data/models`) outranks a case-only spelling on a disk that tells them
 * apart. A link or a dangling link counts as present. `spelled: false` skips the directory read when the
 * candidate exists exactly as typed.
 */
function liveEntry(base, candidates, name, { list = scanner(), spelled = true } = {}) {
  for (const candidate of candidates) {
    const typed = path.join(base, ...candidate.split("/"));
    if (!fs.existsSync(typed)) continue;
    const full = spelled ? findEntry(base, candidate, { list }) || typed : typed;
    if (!isProtectedSourceDir(full, name)) return full;
  }
  for (const candidate of candidates) {
    const alias = findEntry(base, candidate, { list });
    if (alias && !isProtectedSourceDir(alias, name)) return alias;
  }
  return null;
}

/** Is there a link (symlink or junction) on the way from `root` to `full`? Nothing is created through one. */
function throughLink(root, full) {
  const relative = path.relative(path.resolve(root), path.resolve(full));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  let current = path.resolve(root);
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Does this relative path exist on disk with EXACTLY this spelling? */
const existsExact = (root, relative) => findEntry(root, relative, { exact: true }) !== null;

/**
 * A Git checkout used as the FRIDAY folder: package.json next to src/ and
 * kernel/. Its source trees are never data folders, so backend/ and frontend/
 * are neither created nor migrated there.
 */
function isCheckoutShaped(target) {
  if (!target) return false;
  const isDir = (name) => {
    try {
      return fs.statSync(path.join(target, name)).isDirectory();
    } catch {
      return false;
    }
  };
  try {
    return (
      fs.statSync(path.join(target, "package.json")).isFile() && isDir("src") && isDir("kernel")
    );
  } catch {
    return false;
  }
}

const CHECKOUT_SOURCE_NAMES = new Set(["backend", "frontend"]);

/**
 * In FRIDAY's own source checkout used as the folder (package.json named `friday`, next to `src/` and
 * `kernel/`), only the folders the running app writes into are created. Every other name is either a source
 * tree of the checkout (agents, skills, tools, docs, installer, ...) or an empty folder nothing needs yet; the
 * rest appear when something is first written there. `ensureStructure` returns what it skipped.
 */
const CHECKOUT_DATA_NAMES = new Set([
  "config",
  "database",
  "memory",
  "models",
  "voices",
  "logs",
  "cache",
  "runtime",
  "downloads",
  "state",
  "backups",
  "updates",
  "security",
]);

function isFridayCheckout(target) {
  if (!isCheckoutShaped(target)) return false;
  try {
    // An editor may save package.json with a UTF-8 byte-order mark; JSON.parse refuses it.
    const text = fs.readFileSync(path.join(target, "package.json"), "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(text).name === "friday";
  } catch {
    return false;
  }
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
  const checkout = isCheckoutShaped(target);
  const dataOnly = isFridayCheckout(target);
  for (const name of NAMES) {
    if (checkout && CHECKOUT_SOURCE_NAMES.has(name)) continue;
    // A source checkout never has a folder renamed into a data name.
    if (dataOnly && !CHECKOUT_DATA_NAMES.has(name)) continue;
    const candidates = DIRS[name];
    const canonicalRel = candidates[0];
    const canonical = path.join(target, ...canonicalRel.split("/"));
    // The canonical folder is live when it exists with that exact spelling, or when the disk folds case and a
    // differently cased copy (`Models`) answers to the canonical name: used in place, never renamed or duplicated.
    // On a disk that tells them apart `Models` is another folder, and a real legacy store still migrates.
    if (existsExact(target, canonicalRel) || fs.existsSync(canonical)) continue;
    for (const alias of candidates.slice(1)) {
      if (alias.toLowerCase() === canonicalRel.toLowerCase()) continue;
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
  return {
    ok: true,
    root: resolved,
    existing: describeExisting(resolved),
    outside: foldersOutside(resolved),
  };
}

/**
 * Folders in the root (and the required children of the canonical ones) that are links whose real path is not
 * inside the root, or is gone. They are used as they are, but FRIDAY never creates anything through them, and
 * the owner is told where his data really lives. Never throws.
 */
function foldersOutside(resolved) {
  const found = [];
  try {
    const realRoot = fs.realpathSync(resolved);
    const stray = (full) => {
      try {
        if (!fs.lstatSync(full).isSymbolicLink()) return false;
        const rel = path.relative(realRoot, fs.realpathSync(full));
        return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
      } catch {
        return true;
      }
    };
    for (const entry of fs.readdirSync(resolved)) {
      if (stray(path.join(resolved, entry))) found.push(entry);
    }
    for (const name of NAMES) {
      const live = findEntry(resolved, name);
      if (!live || stray(live)) continue;
      for (const child of contract.FOLDERS[name].children) {
        const inner = findEntry(live, child);
        if (inner && stray(inner)) found.push(path.relative(resolved, inner).replace(/\\/g, "/"));
      }
    }
  } catch {
    /* an unreadable root is reported by the write probe */
  }
  return found.sort();
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
function checkoutGuard(dir) {
  if (!dir) return { checkout: false, message: "" };
  const resolved = path.resolve(String(dir));
  const git = path.join(resolved, ".git");
  const manifest = path.join(resolved, "package.json");
  if (!fs.existsSync(git) || !fs.existsSync(manifest)) return { checkout: false, message: "" };
  try {
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
    if (parsed.name !== "friday") return { checkout: false, message: "" };
  } catch {
    return { checkout: false, message: "" };
  }
  return {
    checkout: true,
    message:
      "This FRIDAY folder is the source checkout. Choose a separate folder such as D:\\FRIDAY or %USERPROFILE%\\FRIDAY. Copy my data copies, checks, and switches. The checkout is not deleted.",
  };
}

async function copyVerified(source, target) {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.cp(source, target, { recursive: true, force: false, errorOnExist: false });
  const sourceCount = countFiles(source);
  const targetCount = countFiles(target);
  return {
    ok: targetCount >= sourceCount,
    sourceCount,
    targetCount,
  };
}

function countFiles(dir) {
  let count = 0;
  const walk = (current) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(path.join(current, entry.name));
      else count += 1;
    }
  };
  walk(dir);
  return count;
}

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
  findEntry,
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
  checkoutGuard,
  countFiles,
  copyVerified,
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
