/**
 * Writing the files FRIDAY cannot lose: settings, the workspace record, the library index, durable state.
 *
 * A plain `writeFileSync` truncates the file first. A power cut, a crash or a full disk in the middle leaves half a
 * JSON file, and the next start reads it as "no settings" and quietly falls back to defaults. This writes the new
 * body to a temporary file in the same folder, flushes it to disk, keeps the previous good body as `<file>.bak`, and
 * renames the temporary file over the target in one step.
 *
 * On Windows the rename can fail with EPERM, EBUSY or EACCES while an antivirus scanner, the search indexer or a
 * cloud-sync client holds the target for a moment. That is transient, so the rename is retried with a short wait.
 * If it still fails, the body is copied over the target as a last resort rather than losing the save.
 */
const fs = require("node:fs");
const path = require("node:path");

const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);
const WAITS_MS = [15, 30, 60, 120, 240];

/** A short pause that does not spin the CPU. Only reached after a rename has already failed. */
function pause(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* a runtime without Atomics.wait: a short spin is still better than losing the save */
    }
  }
}

function renameWithRetry(from, to, { fsApi = fs, wait = pause } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= WAITS_MS.length; attempt += 1) {
    try {
      fsApi.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (!error || !TRANSIENT.has(error.code) || attempt === WAITS_MS.length) break;
      wait(WAITS_MS[attempt]);
    }
  }
  throw lastError;
}

function writeFileSafe(file, data, { fsApi = fs, wait = pause, keepBackup = true } = {}) {
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  let fd = null;
  try {
    fd = fsApi.openSync(tmp, "w");
    fsApi.writeSync(fd, data);
    try {
      fsApi.fsyncSync(fd);
    } catch {
      /* a file system without fsync still gets the atomic rename */
    }
    fsApi.closeSync(fd);
    fd = null;
    if (keepBackup) {
      try {
        if (fsApi.existsSync(file)) fsApi.copyFileSync(file, `${file}.bak`);
      } catch {
        /* the backup is a bonus; the save goes on without it */
      }
    }
    try {
      renameWithRetry(tmp, file, { fsApi, wait });
    } catch (error) {
      if (!error || !TRANSIENT.has(error.code)) throw error;
      // The target stays locked: copy the body over it instead of losing the save.
      fsApi.copyFileSync(tmp, file);
    }
  } finally {
    if (fd !== null) {
      try {
        fsApi.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    try {
      fsApi.rmSync(tmp, { force: true });
    } catch {
      /* a leftover temp file is removed by the next save with the same pid, or by storage cleanup */
    }
  }
}

function writeJsonSafe(file, value, space = 2, options) {
  writeFileSafe(file, `${JSON.stringify(value, null, space)}\n`, options);
}

/**
 * Read a JSON file; if it is missing or damaged, read its `.bak`; if that fails too, return `fallback`.
 * `source` says which one answered, so the caller can tell the owner a backup was used.
 */
function readJsonSafe(file, fallback = null, { fsApi = fs } = {}) {
  for (const [candidate, source] of [
    [file, "file"],
    [`${file}.bak`, "backup"],
  ]) {
    try {
      return { value: JSON.parse(fsApi.readFileSync(candidate, "utf8")), source };
    } catch {
      /* try the next one */
    }
  }
  return { value: fallback, source: "none" };
}

module.exports = {
  writeFileSafe,
  writeJsonSafe,
  readJsonSafe,
  renameWithRetry,
  TRANSIENT,
  WAITS_MS,
};
