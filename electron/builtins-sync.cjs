// FRIDAY · built-in capability sync (boot step after an update).
//
// The build writes resources/builtins.json (scripts/builtins-manifest.cjs): the
// exact set of agents, skills, tools, modules, plugins and workflow templates
// this release ships. Built-ins stay pristine in the program folder and are read
// in place; the owner's layer is the workspace trees plus one record,
// config/capabilities.json (schema 2). This module reconciles that record with
// a new release. It reads user files and writes ONLY config/ files (the record
// and a snapshot of the shipped ids); it never writes into a user tree.
//
//   1. Same shipped manifest as last time: stop (fast path, no scan).
//   2. Statuses (builtin, custom, overridden, forked-stale, identical, removed)
//      come from capabilities.list(), the one place that applies precedence.
//   3. An id shipped last release and not now gets a removedBuiltins tombstone;
//      files are left alone. A tombstone is dropped when the id ships again.
//   4. A toggle for an id that exists neither as a built-in nor in the workspace
//      (an item that is missing from the scan this boot) moves to the
//      prunedToggles tombstone map and comes back with the item; a toggle is
//      never lost.
//   5. The record is written first; the shipped-ids snapshot only after the
//      record succeeded, and the fast path needs both to match, so an
//      interrupted sync simply runs again.
//
// FRIDAY_BUILTINS_SYNC=0 switches the whole step off (default on).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SNAPSHOT_FILE = path.join("config", "builtins-last.json");
const STATE_FILE = path.join("config", "capabilities.json");
const MANIFEST_NAME = "builtins.json";

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

/**
 * ONE ignore list for every hash of an item folder (this file, the build
 * generator scripts/builtins-manifest.cjs and the installer's extraResources
 * filters): runtime caches and OS droppings are never part of an item, so a
 * module that ran once does not turn "identical" into "overridden", and the
 * CMD build and CI write the same builtins.json bytes. Names compare lowercase.
 */
const IGNORED_NAMES = [
  "__pycache__",
  "node_modules",
  ".git",
  "thumbs.db",
  "desktop.ini",
  ".ds_store",
];
const IGNORED_SUFFIXES = [".pyc"];
const isIgnored = (name) => {
  const lower = String(name).toLowerCase();
  return IGNORED_NAMES.includes(lower) || IGNORED_SUFFIXES.some((end) => lower.endsWith(end));
};

/** Text hashes the same with CRLF or LF; the same rule as scripts/builtins-manifest.cjs. */
function fileHash(file) {
  const data = fs.readFileSync(file);
  if (data.subarray(0, 8000).includes(0)) return sha256(data);
  return sha256(Buffer.from(data.toString("latin1").replace(/\r\n/g, "\n"), "latin1"));
}

function collect(dir, rel, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (isIgnored(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const name = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) collect(full, name, out);
    else if (entry.isFile()) out.push([name, fileHash(full)]);
  }
}

/** SHA-256 of the sorted "relpath\0filehash\n" lines of an item folder (a flat manifest is one file). */
function itemHash(target) {
  const files = [];
  if (fs.statSync(target).isDirectory()) collect(target, "", files);
  else files.push([path.basename(target), fileHash(target)]);
  files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256(files.map(([rel, hash]) => `${rel}\0${hash}\n`).join(""));
}

/** Most bytes list() will read to compare one shadowing copy with the shipped item. */
const MAX_HASH_BYTES = 64 * 1024 * 1024;
const MAX_CACHED_ITEMS = 4000;
const hashCache = new Map();

/** `count:bytes:newest-mtime` of an item without reading it; `null` over the byte cap. */
function stampOf(target, maxBytes) {
  let count = 0;
  let bytes = 0;
  let newest = 0;
  const take = (file) => {
    const stat = fs.statSync(file);
    count += 1;
    bytes += stat.size;
    if (stat.mtimeMs > newest) newest = stat.mtimeMs;
    return bytes <= maxBytes;
  };
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (isIgnored(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!walk(full)) return false;
      } else if (entry.isFile() && !take(full)) return false;
    }
    return true;
  };
  const whole = fs.statSync(target).isDirectory() ? walk(target) : take(target);
  return whole ? `${count}:${bytes}:${newest}` : null;
}

/**
 * The hash capabilities.list() compares with the shipped item, or `null` when it cannot be
 * had (a locked or vanished file, an item over the byte cap). `null` always means "not
 * identical", so one bad file never breaks a listing. Cached by path, file count, size and
 * newest modified time, so an unchanged copy is read once.
 */
function shadowHash(target, { maxBytes = MAX_HASH_BYTES } = {}) {
  try {
    const stamp = stampOf(target, maxBytes);
    if (stamp === null) return null;
    const key = `${stamp}:${maxBytes}`;
    const hit = hashCache.get(target);
    if (hit && hit.key === key) return hit.hash;
    const hash = itemHash(target);
    if (hashCache.size >= MAX_CACHED_ITEMS) hashCache.clear();
    hashCache.set(target, { key, hash });
    return hash;
  } catch {
    hashCache.delete(target);
    return null;
  }
}

function parseManifest(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || parsed.schema !== 1 || typeof parsed.trees !== "object" || !parsed.trees)
    return null;
  const byId = new Map();
  for (const list of Object.values(parsed.trees))
    for (const entry of Array.isArray(list) ? list : [])
      if (entry && typeof entry.id === "string") byId.set(entry.id.toLowerCase(), entry);
  return { release: String(parsed.release || ""), byId };
}

const cache = new Map();

/**
 * The shipped manifest of one program folder: `{ ok, release, sha256, byId }` or `{ ok: false,
 * reason }`. Cached by size and modified time, so capabilities.list() stays cheap.
 */
function readBuiltins(appRoot) {
  if (!appRoot) return { ok: false, reason: "no-root" };
  const file = path.join(appRoot, MANIFEST_NAME);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    cache.delete(file);
    return { ok: false, reason: "no-manifest" };
  }
  const key = `${stat.size}:${stat.mtimeMs}`;
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit.value;
  let value;
  try {
    const bytes = fs.readFileSync(file);
    const parsed = parseManifest(bytes);
    value = parsed
      ? { ok: true, ...parsed, sha256: sha256(bytes) }
      : { ok: false, reason: "unreadable" };
  } catch {
    value = { ok: false, reason: "unreadable" };
  }
  cache.set(file, { key, value });
  return value;
}

function emptyReport(roots) {
  return {
    ...(roots ? { roots } : {}),
    ok: true,
    skipped: null,
    fast: false,
    release: "",
    counts: null,
    removed: [],
    pruned: [],
  };
}

function readSnapshot(workspaceRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(workspaceRoot, SNAPSHOT_FILE), "utf8"));
    return {
      ids: Array.isArray(parsed?.ids) ? parsed.ids.map(String) : [],
      sha256: typeof parsed?.sha256 === "string" ? parsed.sha256 : "",
    };
  } catch {
    return { ids: [], sha256: "" };
  }
}

/** Most tombstoned toggles kept; the oldest go first. */
const MAX_PRUNED_TOGGLES = 2000;

/** Counts shown in Doctor: shipped items, user copies that win, and copies behind a newer release. */
function countRows(items, shipped) {
  let overridden = 0;
  let stale = 0;
  for (const item of items) {
    if (item.status === "overridden" || item.status === "forked-stale") overridden += 1;
    if (item.status === "forked-stale" || item.staleOverride) stale += 1;
  }
  return { builtins: shipped, overridden, stale };
}

/**
 * Reconcile the owner's record with the shipped built-ins. Never throws; the
 * report says what happened. `capabilities` is injectable for tests.
 */
function run({ appRoot, workspaceRoot, env = process.env, now = Date.now, capabilities } = {}) {
  const report = emptyReport(appRoot && workspaceRoot ? { appRoot, workspaceRoot } : null);
  const skip = (reason) => ({ ...report, skipped: reason });
  if (String(env.FRIDAY_BUILTINS_SYNC ?? "1").trim() === "0") return skip("disabled");
  if (!appRoot || !workspaceRoot) return skip("no-root");
  const failed = (release, failedFile) => ({
    ...report,
    ok: false,
    skipped: "write-failed",
    release,
    failedFile,
    error: `could not write ${failedFile}`,
  });
  try {
    const built = readBuiltins(appRoot);
    if (!built.ok) return skip(built.reason);
    const caps = capabilities || require("./capabilities.cjs");
    const current = caps.readStateFile(workspaceRoot);
    if (current.exists && !current.readable) return skip("unreadable-state");
    if (Number(current.value.schema) > caps.STATE_SCHEMA) return skip("newer-schema");
    const snapshot = readSnapshot(workspaceRoot);
    const last = current.value.lastBuiltins;
    // Fast path: the record AND the snapshot both belong to this shipped manifest.
    if (last && last.sha256 === built.sha256 && snapshot.sha256 === built.sha256)
      return { ...report, fast: true, release: built.release, counts: last.counts || null };

    const state = caps.upgradeState(current.value);
    const removedBuiltins = { ...state.removedBuiltins };
    for (const id of snapshot.ids) {
      const key = id.toLowerCase();
      if (!built.byId.has(key) && !removedBuiltins[key]) {
        removedBuiltins[key] = { since: built.release };
        report.removed.push(key);
      }
    }
    for (const key of built.byId.keys()) delete removedBuiltins[key];
    state.removedBuiltins = removedBuiltins;

    // Statuses read the record, so list against the tombstones this run just wrote.
    const listing = caps.list({ appRoot, workspaceRoot, state });
    const present = new Set(listing.items.map((item) => item.id.toLowerCase()));
    const exists = (key) => present.has(key.toLowerCase()) || built.byId.has(key.toLowerCase());
    // A toggle is never lost: one for an item missing from this scan waits in prunedToggles
    // and is given back (unless the owner set a newer one) when the item returns.
    const parked = { ...(state.prunedToggles || {}) };
    for (const key of Object.keys(parked)) {
      if (typeof parked[key] !== "boolean" || !exists(key)) continue;
      if (typeof state[key] !== "boolean") state[key] = parked[key];
      delete parked[key];
    }
    for (const key of Object.keys(state)) {
      if (caps.RESERVED_KEYS.has(key) || typeof state[key] !== "boolean" || exists(key)) continue;
      parked[key] = state[key];
      delete state[key];
      report.pruned.push(key);
    }
    const parkedKeys = Object.keys(parked);
    for (const key of parkedKeys.slice(0, Math.max(0, parkedKeys.length - MAX_PRUNED_TOGGLES)))
      delete parked[key];
    if (Object.keys(parked).length) state.prunedToggles = parked;
    else delete state.prunedToggles;

    const counts = countRows(listing.items, built.byId.size);
    state.lastBuiltins = { release: built.release, sha256: built.sha256, counts };
    const ids = [...built.byId.keys()].sort();
    const next = { schema: 1, release: built.release, sha256: built.sha256, at: now(), ids };
    // The record first: only after it is safe does the snapshot move on. A failure on either
    // leaves the fast path closed, so the next boot runs the sync again.
    if (!caps.writeState(workspaceRoot, state)) return failed(built.release, STATE_FILE);
    if (!caps.writeAtomic(path.join(workspaceRoot, SNAPSHOT_FILE), next))
      return failed(built.release, SNAPSHOT_FILE);
    return { ...report, release: built.release, counts };
  } catch (error) {
    return { ...report, ok: false, skipped: "error", error: String(error?.message || error) };
  }
}

/** Counts from the live trees; `null` when the roots or the shipped manifest are not there. */
function liveCounts(roots) {
  if (!roots?.appRoot || !roots?.workspaceRoot) return null;
  try {
    const built = readBuiltins(roots.appRoot);
    if (!built.ok) return null;
    const listing = require("./capabilities.cjs").list(roots);
    return countRows(listing.items, built.byId.size);
  } catch {
    return null;
  }
}

/**
 * The Doctor row for the last sync: same shape as the other install rows. The counts come from a
 * live listing, so a copy the owner forked, reset or deleted since the boot shows at once; the
 * counts cached in the report are the fallback.
 */
function doctorRow(report) {
  const counts = liveCounts(report?.roots) || report?.counts;
  const row = {
    id: "builtins",
    label: "Built-in capabilities",
    ok: report?.ok !== false,
    optional: true,
    required: false,
    detail: "not checked",
  };
  if (counts) {
    row.detail = `Built-ins ${counts.builtins}, overridden ${counts.overridden}, stale ${counts.stale}`;
    row.ok = row.ok && counts.stale === 0;
  } else if (report?.skipped) row.detail = `skipped: ${report.skipped}`;
  return row;
}

module.exports = {
  MANIFEST_NAME,
  SNAPSHOT_FILE,
  IGNORED_NAMES,
  isIgnored,
  itemHash,
  shadowHash,
  readBuiltins,
  run,
  doctorRow,
};
