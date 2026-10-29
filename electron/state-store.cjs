/**
 * FRIDAY · durable state files.
 *
 * A version change copies the previous JSON beside the file before the new
 * body is published. The new body is written to a temporary file and renamed
 * into place. A full disk, a denied write, or a cut-off write leaves the
 * previous file as it was.
 */
const fs = require("fs");

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

/**
 * Copy the previous body when its version differs, then publish the next body.
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
    fs.writeFileSync(bak, JSON.stringify({ at: now, body: previous.parsed }));
  }
  if (fail === "disk-full" || fail === "permission-denied") {
    return { ok: false, restored: false, reason: fail, backup: migrating ? bak : null };
  }
  const tmp = `${file}.tmp`;
  const nextText = JSON.stringify(value);
  if (fail === "interrupt") {
    fs.writeFileSync(tmp, nextText.slice(0, Math.max(1, Math.floor(nextText.length / 2))));
    fs.rmSync(tmp, { force: true });
    return {
      ok: false,
      restored: false,
      reason: "interrupted-write",
      backup: migrating ? bak : null,
    };
  }
  fs.writeFileSync(tmp, nextText);
  fs.renameSync(tmp, file);
  return { ok: true, restored: false, reason: null, backup: migrating ? bak : null };
}

/** Put the backup body back. A missing backup does not invent a file. */
function restoreState(file) {
  const bak = backupPath(file);
  const saved = parsedFile(readRaw(bak));
  if (saved.missing) return { ok: false, reason: "no-backup" };
  if (
    saved.corrupt ||
    !saved.parsed ||
    typeof saved.parsed !== "object" ||
    !("body" in saved.parsed)
  ) {
    return { ok: false, reason: "corrupt-state" };
  }
  fs.writeFileSync(file, JSON.stringify(saved.parsed.body));
  return { ok: true, body: saved.parsed.body };
}

/** Read the live file. A corrupt file is replaced from its backup when one exists. */
function readState(file) {
  const live = parsedFile(readRaw(file));
  if (live.missing) return null;
  if (!live.corrupt) return live.parsed;
  const restored = restoreState(file);
  return restored.ok ? restored.body : null;
}

module.exports = { commitState, restoreState, readState, backupPath };
