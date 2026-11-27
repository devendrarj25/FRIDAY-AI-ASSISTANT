/**
 * FRIDAY · durable state files.
 *
 * Every body is written through the safe writer (electron/safe-write.cjs): a temporary file in the same folder,
 * flushed to disk, then renamed into place, so a power cut or a crash leaves the previous file whole. The previous
 * good body is kept beside the file as `<file>.bak`, a copy that is never taken from an empty or damaged file. A
 * version change keeps the older body there as `{ at, body }` until the next save. A full disk, a denied write, or a
 * cut-off write leaves the previous file as it was.
 *
 * Reading a file that is empty or does not parse sets it aside as `<file>.corrupt-<stamp>` (the newest few are kept
 * for inspection, nothing is deleted at once) and puts the last good body back from the `.bak`.
 */
const fs = require("fs");
const path = require("path");
const safeWrite = require("./safe-write.cjs");

/** How many set-aside damaged copies of one file are kept. */
const KEEP_CORRUPT = 3;

function backupPath(file) {
  return `${file}.bak`;
}

function readRaw(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function versionOf(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const version = value.version;
  return typeof version === "number" && Number.isFinite(version) ? version : null;
}

function parsedFile(raw) {
  if (raw === null) return { parsed: null, corrupt: false, missing: true };
  try {
    return { parsed: JSON.parse(raw), corrupt: false, missing: false };
  } catch {
    return { parsed: null, corrupt: true, missing: false };
  }
}

/** The body inside a `.bak`: the `{ at, body }` kept at a version change, or a plain copy of the previous file. */
function bodyOfBackup(parsed) {
  if (!parsed || typeof parsed !== "object") return { ok: false };
  const keys = Object.keys(parsed);
  const wrapped =
    keys.length === 2 &&
    keys.includes("at") &&
    keys.includes("body") &&
    typeof parsed.at === "number";
  return { ok: true, body: wrapped ? parsed.body : parsed };
}

function safeOptions(opts, keepBackup) {
  return { keepBackup, ...(opts.fsApi ? { fsApi: opts.fsApi } : {}) };
}

/**
 * Copy the previous body aside when its version differs, then publish the next body through the safe writer.
 * `fail` is only for tests: disk-full and permission-denied skip the publish,
 * and interrupt drops the temporary file without renaming it.
 */
function commitState(file, value, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : 0;
  const fail = opts.fail || null;
  const previous = parsedFile(readRaw(file));
  const nextVersion = versionOf(value);
  const prevVersion = versionOf(previous.parsed);
  const migrating =
    !previous.missing &&
    !previous.corrupt &&
    prevVersion !== null &&
    nextVersion !== null &&
    prevVersion !== nextVersion;
  const bak = backupPath(file);
  if (migrating) {
    safeWrite.writeFileSafe(
      bak,
      JSON.stringify({ at: now, body: previous.parsed }),
      safeOptions(opts, false),
    );
  }
  if (fail === "disk-full" || fail === "permission-denied") {
    return { ok: false, restored: false, reason: fail, backup: migrating ? bak : null };
  }
  const nextText = JSON.stringify(value);
  if (fail === "interrupt") {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, nextText.slice(0, Math.max(1, Math.floor(nextText.length / 2))));
    fs.rmSync(tmp, { force: true });
    return {
      ok: false,
      restored: false,
      reason: "interrupted-write",
      backup: migrating ? bak : null,
    };
  }
  // The rolling copy is of a file that was read back whole; an empty or damaged one never replaces a good `.bak`.
  const keepBackup = !migrating && !previous.missing && !previous.corrupt;
  safeWrite.writeFileSafe(file, nextText, safeOptions(opts, keepBackup));
  return { ok: true, restored: false, reason: null, backup: migrating ? bak : null };
}

/** True when the file starts like a JSON object or array and ends like one: a cheap check that reads a few bytes. */
async function looksWhole(file) {
  let handle = null;
  try {
    handle = await fs.promises.open(file, "r");
    const { size } = await handle.stat();
    if (size < 2) return false;
    const head = Buffer.alloc(1);
    await handle.read(head, 0, 1, 0);
    const tailLength = Math.min(size, 32);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    return /^[{[]/.test(head.toString("utf8")) && /[}\]]\s*$/.test(tail.toString("utf8"));
  } catch {
    return false;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

/**
 * `commitState` without blocking the main process. The earlier file is read and parsed only when the new body carries a
 * version (that is the only time its version matters), so an ordinary save no longer parses the whole old file first.
 * `shouldCommit` lets a newer synchronous save cancel a write that is still in flight.
 */
async function commitStateAsync(file, value, opts = {}) {
  const api = opts.fsApi || fs.promises;
  const now = Number.isFinite(opts.now) ? opts.now : 0;
  const shouldCommit = typeof opts.shouldCommit === "function" ? opts.shouldCommit : () => true;
  const nextVersion = versionOf(value);
  const bak = backupPath(file);
  let migrating = false;
  if (nextVersion !== null) {
    let raw = null;
    try {
      raw = await api.readFile(file, "utf8");
    } catch {
      raw = null;
    }
    const previous = parsedFile(raw);
    const prevVersion = versionOf(previous.parsed);
    migrating =
      !previous.missing && !previous.corrupt && prevVersion !== null && prevVersion !== nextVersion;
    if (migrating) {
      await safeWrite.writeFileSafeAsync(bak, JSON.stringify({ at: now, body: previous.parsed }), {
        ...safeOptions(opts, false),
      });
    }
  }
  // An empty or cut-off file (what an interrupted write used to leave) is never copied over a good `.bak`. Only the
  // first and last bytes are looked at, so an ordinary save still does not read or parse the old body.
  const hadBody = migrating ? false : await looksWhole(file);
  const published = await safeWrite.writeFileSafeAsync(file, JSON.stringify(value), {
    ...safeOptions(opts, hadBody),
    shouldCommit,
  });
  if (!published) {
    return { ok: false, restored: false, reason: "superseded", backup: migrating ? bak : null };
  }
  return { ok: true, restored: false, reason: null, backup: migrating ? bak : null };
}

/** Put the backup body back. A missing backup does not invent a file. */
function restoreState(file) {
  const bak = backupPath(file);
  const saved = parsedFile(readRaw(bak));
  if (saved.missing) return { ok: false, reason: "no-backup" };
  const found = saved.corrupt ? { ok: false } : bodyOfBackup(saved.parsed);
  if (!found.ok) return { ok: false, reason: "corrupt-state" };
  try {
    safeWrite.writeFileSafe(file, JSON.stringify(found.body), { keepBackup: false });
  } catch {
    /* the body is still returned: a failed write-back must not turn a recovered state into no state */
  }
  return { ok: true, body: found.body };
}

/** Move a damaged file out of the way (never delete it) and keep only the newest few such copies. */
function setAside(file, now) {
  const stamp = Number.isFinite(now) ? now : Date.now();
  try {
    safeWrite.renameWithRetry(file, `${file}.corrupt-${stamp}`);
  } catch {
    try {
      fs.copyFileSync(file, `${file}.corrupt-${stamp}`);
      fs.rmSync(file, { force: true });
    } catch {
      return;
    }
  }
  try {
    const prefix = `${path.basename(file)}.corrupt-`;
    const copies = fs
      .readdirSync(path.dirname(file))
      .filter((name) => name.startsWith(prefix))
      .map((name) => ({ name, at: Number(name.slice(prefix.length)) || 0 }))
      .sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
    for (const old of copies.slice(0, Math.max(0, copies.length - KEEP_CORRUPT))) {
      fs.rmSync(path.join(path.dirname(file), old.name), { force: true });
    }
  } catch {
    /* an old copy that stays is harmless */
  }
}

/**
 * Read the live file. A file that is empty or does not parse is set aside as `<file>.corrupt-<stamp>` and replaced
 * from its backup when one exists; without one the answer is null and the next save starts the file again.
 */
function readState(file, opts = {}) {
  const live = parsedFile(readRaw(file));
  if (live.missing) return null;
  if (!live.corrupt) return live.parsed;
  setAside(file, opts.now);
  const restored = restoreState(file);
  return restored.ok ? restored.body : null;
}

module.exports = { commitState, commitStateAsync, restoreState, readState, backupPath };
