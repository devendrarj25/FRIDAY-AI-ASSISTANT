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
//   4. Toggles for ids that exist neither as a built-in nor in the workspace are
//      dropped; the previous record stays in config/capabilities.json.bak.
//   5. lastBuiltins is written last, so an interrupted sync simply runs again.
//
// FRIDAY_BUILTINS_SYNC=0 switches the whole step off (default on).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SNAPSHOT_FILE = path.join("config", "builtins-last.json");
const MANIFEST_NAME = "builtins.json";

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

/** Text hashes the same with CRLF or LF; the same rule as scripts/builtins-manifest.cjs. */
function fileHash(file) {
  const data = fs.readFileSync(file);
  if (data.subarray(0, 8000).includes(0)) return sha256(data);
  return sha256(Buffer.from(data.toString("latin1").replace(/\r\n/g, "\n"), "latin1"));
}

function collect(dir, rel, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
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

function emptyReport() {
  return {
    ok: true,
    skipped: null,
    fast: false,
    release: "",
    counts: null,
    removed: [],
    pruned: [],
  };
}

function snapshotIds(workspaceRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(workspaceRoot, SNAPSHOT_FILE), "utf8"));
    return Array.isArray(parsed?.ids) ? parsed.ids.map(String) : [];
  } catch {
    return [];
  }
}

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
  const report = emptyReport();
  const skip = (reason) => ({ ...report, skipped: reason });
  if (String(env.FRIDAY_BUILTINS_SYNC ?? "1").trim() === "0") return skip("disabled");
  if (!appRoot || !workspaceRoot) return skip("no-root");
  try {
    const built = readBuiltins(appRoot);
    if (!built.ok) return skip(built.reason);
    const caps = capabilities || require("./capabilities.cjs");
    const current = caps.readStateFile(workspaceRoot);
    if (current.exists && !current.readable) return skip("unreadable-state");
    if (Number(current.value.schema) > caps.STATE_SCHEMA) return skip("newer-schema");
    const last = current.value.lastBuiltins;
    if (last && last.sha256 === built.sha256)
      return { ...report, fast: true, release: built.release, counts: last.counts || null };

    const state = caps.upgradeState(current.value);
    const previous = snapshotIds(workspaceRoot);
    const removedBuiltins = { ...state.removedBuiltins };
    for (const id of previous) {
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
    for (const key of Object.keys(state)) {
      if (caps.RESERVED_KEYS.has(key) || typeof state[key] !== "boolean") continue;
      if (present.has(key.toLowerCase()) || built.byId.has(key.toLowerCase())) continue;
      delete state[key];
      report.pruned.push(key);
    }

    const counts = countRows(listing.items, built.byId.size);
    state.lastBuiltins = { release: built.release, sha256: built.sha256, counts };
    const ids = [...built.byId.keys()].sort();
    const snapshot = { schema: 1, release: built.release, sha256: built.sha256, at: now(), ids };
    // The record goes last: an interrupted sync leaves lastBuiltins stale, so it simply runs again.
    if (
      !caps.writeAtomic(path.join(workspaceRoot, SNAPSHOT_FILE), snapshot) ||
      !caps.writeState(workspaceRoot, state)
    )
      return { ...report, ok: false, skipped: "write-failed", release: built.release };
    return { ...report, release: built.release, counts };
  } catch (error) {
    return { ...report, ok: false, skipped: "error", error: String(error?.message || error) };
  }
}

/** The Doctor row for the last sync: same shape as the other install rows. */
function doctorRow(report) {
  const counts = report?.counts;
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

module.exports = { MANIFEST_NAME, SNAPSHOT_FILE, itemHash, readBuiltins, run, doctorRow };
