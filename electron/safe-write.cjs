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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let tempCounter = 0;

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

/** Largest JSON body read back to check it parses before it is backed up. */
const MAX_PARSE_CHECK = 8 * 1024 * 1024;
const parses = (body) => {
  try {
    JSON.parse(String(body).replace(/^\uFEFF/, ""));
    return true;
  } catch {
    return false;
  }
};

/**
 * A `.json` main file that does not parse while a `.bak` exists: copying it over the backup
 * would replace the last good body with the damaged one. Any trouble reading it means "not
 * known to be damaged", so the old behaviour (copy) stays.
 */
function isDamagedJson(file, fsApi) {
  if (!/\.json$/i.test(file)) return false;
  let body;
  try {
    if (!fsApi.existsSync(`${file}.bak`) || fsApi.statSync(file).size > MAX_PARSE_CHECK)
      return false;
    body = fsApi.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  return !parses(body);
}

async function isDamagedJsonAsync(file, fsApi) {
  if (!/\.json$/i.test(file)) return false;
  let body;
  try {
    await fsApi.stat(`${file}.bak`);
    if ((await fsApi.stat(file)).size > MAX_PARSE_CHECK) return false;
    body = await fsApi.readFile(file, "utf8");
  } catch {
    return false;
  }
  return !parses(body);
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
        if (fsApi.existsSync(file) && !isDamagedJson(file, fsApi))
          fsApi.copyFileSync(file, `${file}.bak`);
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

/** The same retry as `renameWithRetry`, waiting with a timer so the main process keeps answering its window. */
async function renameWithRetryAsync(from, to, { fsApi = fs.promises, wait = sleep } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= WAITS_MS.length; attempt += 1) {
    try {
      await fsApi.rename(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (!error || !TRANSIENT.has(error.code) || attempt === WAITS_MS.length) break;
      await wait(WAITS_MS[attempt]);
    }
  }
  throw lastError;
}

/**
 * `writeFileSafe` without blocking the main process. The synchronous version stops the thread that owns the window
 * for the whole write, flush and retry: on a busy disk (a model download, the AI service writing) that is long enough
 * for Windows to mark the window "Not Responding". Same steps and same guarantees: temporary file, flush, backup,
 * rename with retry, copy as the last resort. `shouldCommit` lets a newer synchronous save (the app is closing) cancel
 * a write that is still in flight, so an older body can never land after the newer one.
 */
async function writeFileSafeAsync(
  file,
  data,
  { fsApi = fs.promises, wait = sleep, keepBackup = true, shouldCommit = () => true } = {},
) {
  await fsApi.mkdir(path.dirname(file), { recursive: true });
  tempCounter += 1;
  const tmp = `${file}.${process.pid}.${tempCounter}.tmp`;
  let handle = null;
  try {
    handle = await fsApi.open(tmp, "w");
    await handle.writeFile(data);
    try {
      await handle.sync();
    } catch {
      /* a file system without fsync still gets the atomic rename */
    }
    await handle.close();
    handle = null;
    if (!shouldCommit()) return false;
    if (keepBackup) {
      try {
        if (!(await isDamagedJsonAsync(file, fsApi))) await fsApi.copyFile(file, `${file}.bak`);
      } catch {
        /* no earlier file, or the backup is a bonus: the save goes on without it */
      }
    }
    try {
      await renameWithRetryAsync(tmp, file, { fsApi, wait });
    } catch (error) {
      if (!error || !TRANSIENT.has(error.code)) throw error;
      await fsApi.copyFile(tmp, file);
    }
    return true;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        /* already closed */
      }
    }
    try {
      await fsApi.rm(tmp, { force: true });
    } catch {
      /* a leftover temp file is removed by storage cleanup */
    }
  }
}

function writeJsonSafeAsync(file, value, space = 2, options) {
  return writeFileSafeAsync(file, `${JSON.stringify(value, null, space)}\n`, options);
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
  writeFileSafeAsync,
  writeJsonSafe,
  writeJsonSafeAsync,
  renameWithRetryAsync,
  readJsonSafe,
  renameWithRetry,
  TRANSIENT,
  WAITS_MS,
};
