// FRIDAY · asynchronous secret box (Electron safeStorage, async API only).
//
// ONE module talks to safeStorage for every stored secret: provider keys
// (models.cjs), connector and speech tokens (credentials.cjs), the voiceprint
// and the voice profile. The synchronous methods (`isEncryptionAvailable`,
// `encryptString`, `decryptString`) are deprecated in Electron 45 and removed
// in 46, so nothing here calls them.
//
// Stored format is unchanged: `{ "<id>": { "enc": "<base64 ciphertext>" } }`
// (or a legacy plain string written before encryption existed). Ciphertext
// written by `encryptString` decrypts with `decryptStringAsync`, so nothing
// stored needs to be saved again.
//
// Reads stay synchronous for the many callers that already exist: every
// ciphertext the process has decrypted lives in an in-memory map
// (ciphertext -> clear text, never written anywhere, never sent to the
// renderer). `prime(file)` fills that map once after the app is ready.
// Writes are asynchronous, queued per file, and atomic (temp file, then
// rename), so two writes cannot overwrite each other and a failed write leaves
// the old file as it was.
const fs = require("node:fs");
const path = require("node:path");
const lazy = require("./lazy-electron.cjs");

/** The longest any one OS keystore call may take. A stuck keystore must not hold the write queue or an IPC reply. */
let callLimitMs = 10_000;

/** Test seam: shorten the limit so a hang can be tested without waiting. */
function setCallLimitForTests(ms) {
  callLimitMs = Number.isFinite(ms) && ms > 0 ? ms : 10_000;
}

/** Race one OS call against the limit. Rejects with a plain error; never leaves the caller waiting forever. */
function withLimit(promise, what) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), callLimitMs);
    if (typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

let injected = null;
/** Test seam: a fake with `isAsyncEncryptionAvailable`, `encryptStringAsync`, `decryptStringAsync`. */
function useForTests(fake) {
  injected = fake || null;
  clear();
}

function api() {
  return injected || lazy.afterReady("safeStorage");
}

// ciphertext (base64) -> clear text, for this process only.
const known = new Map();
// ciphertext the OS could not open (another machine or account). Not retried in a loop.
const unreadable = new Set();
// last answer of isAsyncEncryptionAvailable, for callers that cannot await.
let lastAvailable = false;
const primed = new Map(); // file -> Promise
const queues = new Map(); // file -> Promise (write queue)
let tmpCounter = 0;

function clear() {
  known.clear();
  unreadable.clear();
  primed.clear();
  queues.clear();
  lastAvailable = false;
}

/** Whether the OS can encrypt right now. False before the app is ready; never throws. */
async function available() {
  const store = api();
  if (!store || typeof store.isAsyncEncryptionAvailable !== "function") {
    lastAvailable = false;
    return false;
  }
  try {
    lastAvailable = Boolean(
      await withLimit(Promise.resolve(store.isAsyncEncryptionAvailable()), "availability check"),
    );
  } catch {
    lastAvailable = false;
  }
  return lastAvailable;
}

/** The last answer of `available()`. False until the first check has finished. */
const availableNow = () => lastAvailable;

/** Encrypt one string. Throws when the OS cannot, so a caller never stores plain text by accident. */
async function encryptText(text) {
  const store = api();
  if (!store || typeof store.encryptStringAsync !== "function") {
    throw new Error("secure storage is not ready");
  }
  const buffer = await withLimit(
    Promise.resolve(store.encryptStringAsync(String(text))),
    "encryption",
  );
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("secure storage returned no ciphertext");
  }
  const enc = buffer.toString("base64");
  known.set(enc, String(text));
  unreadable.delete(enc);
  return enc;
}

/**
 * Decrypt one base64 ciphertext.
 * `{ ok: true, text, reEncrypt }`; `reEncrypt` is true when the OS says the key rotated or a stronger
 * key exists. In that case the API contract is to call `decryptStringAsync` again for the current
 * string, which is done once; if that second call fails the first answer is kept.
 * `{ ok: false, reason }` never carries the ciphertext or any secret.
 */
async function decryptText(enc) {
  const store = api();
  if (!store || typeof store.decryptStringAsync !== "function") {
    return { ok: false, reason: "not-ready" };
  }
  let buffer;
  try {
    buffer = Buffer.from(String(enc), "base64");
  } catch {
    return { ok: false, reason: "undecryptable" };
  }
  try {
    const first = await withLimit(Promise.resolve(store.decryptStringAsync(buffer)), "decryption");
    if (!first || typeof first.result !== "string") return { ok: false, reason: "undecryptable" };
    let text = first.result;
    const reEncrypt = first.shouldReEncrypt === true;
    if (reEncrypt) {
      try {
        const second = await withLimit(
          Promise.resolve(store.decryptStringAsync(buffer)),
          "second decryption",
        );
        if (second && typeof second.result === "string" && second.result) text = second.result;
      } catch {
        /* the first answer stands */
      }
    }
    known.set(String(enc), text);
    unreadable.delete(String(enc));
    return { ok: true, text, reEncrypt };
  } catch (error) {
    // A call that hung is not a verdict on the ciphertext: it is tried again later, not remembered as unreadable.
    if (/timed out$/.test(String(error?.message))) return { ok: false, reason: "timeout" };
    return { ok: false, reason: "undecryptable" };
  }
}

/** Clear text for a ciphertext this process has already opened, or null. Synchronous. */
function opened(enc) {
  const value = known.get(String(enc));
  return value === undefined ? null : value;
}

// ------------------------------------------------------------------ files
function readRaw(file) {
  if (!file) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/** The file's entries, or `corrupt: true` when it exists but is not a JSON object (never overwritten then). */
function readRawStrict(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { raw: {}, corrupt: false };
  }
  try {
    const raw = JSON.parse(text);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return { raw, corrupt: false };
  } catch {
    /* falls through */
  }
  return { raw: {}, corrupt: true };
}

/** Atomic write: temp file in the same folder, then rename. The old file survives a failure. */
function writeAtomic(file, text, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  tmpCounter += 1;
  const temp = `${file}.${process.pid}.${tmpCounter}.tmp`;
  try {
    fs.writeFileSync(temp, text, mode ? { mode } : undefined);
    if (mode) {
      try {
        fs.chmodSync(temp, mode);
      } catch {
        /* filesystems without POSIX modes */
      }
    }
    fs.renameSync(temp, file);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* nothing to clean */
    }
    throw error;
  }
}

/** Run `job` after every earlier job on the same file has finished. */
function queued(file, job) {
  const previous = queues.get(file) || Promise.resolve();
  const next = previous.then(job, job);
  const tail = next.catch(() => {});
  queues.set(file, tail);
  tail.then(() => {
    if (queues.get(file) === tail) queues.delete(file);
  });
  return next;
}

/** Ciphertexts in this file that this process has not tried to open yet. */
function pendingEnc(raw) {
  const out = [];
  for (const value of Object.values(raw)) {
    const enc = value && typeof value === "object" ? value.enc : null;
    if (typeof enc === "string" && !known.has(enc) && !unreadable.has(enc)) out.push(enc);
  }
  return out;
}

/**
 * Open every ciphertext in `file` once, after the app is ready, so synchronous readers can use them.
 * A ciphertext the OS cannot open stays in the file untouched. A ciphertext flagged for re-encryption
 * is rewritten only when it is still unchanged in the file; if the rewrite fails the old one stays.
 */
function prime(file) {
  if (!file) return Promise.resolve({ ok: false, opened: 0, failed: 0 });
  const running = primed.get(file);
  if (running) return running;
  const job = (async () => {
    if (!(await available())) return { ok: false, opened: 0, failed: 0, reason: "unavailable" };
    const raw = readRaw(file);
    let openedCount = 0;
    let failed = 0;
    const rotate = [];
    for (const enc of pendingEnc(raw)) {
      const result = await decryptText(enc);
      if (result.ok) {
        openedCount += 1;
        if (result.reEncrypt) rotate.push(enc);
      } else {
        if (result.reason === "undecryptable") unreadable.add(enc);
        failed += 1;
      }
    }
    if (rotate.length) await reEncrypt(file, rotate).catch(() => {});
    return { ok: true, opened: openedCount, failed };
  })().finally(() => {
    primed.delete(file);
  });
  primed.set(file, job);
  return job;
}

async function reEncrypt(file, oldEncs) {
  return queued(file, async () => {
    const { raw, corrupt } = readRawStrict(file);
    if (corrupt) return false;
    let changed = false;
    for (const [id, value] of Object.entries(raw)) {
      const enc = value && typeof value === "object" ? value.enc : null;
      if (!enc || !oldEncs.includes(enc)) continue;
      const text = opened(enc);
      if (text == null) continue;
      try {
        raw[id] = { ...value, enc: await encryptText(text) };
        changed = true;
      } catch {
        /* keep the ciphertext that still opens */
      }
    }
    if (changed) writeAtomic(file, JSON.stringify(raw, null, 2), 0o600);
    return changed;
  });
}

/**
 * Read every entry of a `{ id: { enc } | "plain" }` file as clear text. Synchronous.
 * `missing` counts ciphertexts that are not open yet; when there are any, a background prime starts.
 */
function readEntries(file) {
  const raw = readRaw(file);
  const out = {};
  let missing = 0;
  for (const [id, value] of Object.entries(raw)) {
    if (typeof value === "string") {
      out[id] = value;
    } else if (value && typeof value === "object" && typeof value.enc === "string") {
      const text = opened(value.enc);
      if (text != null) out[id] = text;
      else if (!unreadable.has(value.enc)) missing += 1;
    }
  }
  if (missing && lastAvailable) void prime(file).catch(() => {});
  return { values: out, missing };
}

/**
 * Store, or with an empty value delete, one entry. Queued per file; re-reads the file inside the queue
 * so concurrent writers never overwrite each other. Returns
 * `{ ok, stored, encrypted }` or `{ ok: false, error, code }`.
 * `allowPlain` is the caller's decision (development and tests only); it is never assumed.
 */
function setEntry(file, id, value, { allowPlain = false, mode = 0o600 } = {}) {
  if (!file) return Promise.resolve({ ok: false, code: "no-file", error: "no credential file" });
  return queued(file, async () => {
    const text = value ? String(value) : "";
    const { raw, corrupt } = readRawStrict(file);
    if (corrupt) {
      return {
        ok: false,
        code: "corrupt",
        error: "The credential store is unreadable, so FRIDAY will not overwrite it.",
      };
    }
    let encrypted = false;
    if (!text) {
      delete raw[id];
    } else if (await available()) {
      try {
        raw[id] = { enc: await encryptText(text) };
        encrypted = true;
      } catch {
        return {
          ok: false,
          code: "encrypt-failed",
          error: "The credential could not be encrypted.",
        };
      }
    } else if (allowPlain) {
      raw[id] = text;
    } else {
      return { ok: false, code: "unavailable", error: "secure storage is unavailable" };
    }
    try {
      writeAtomic(file, JSON.stringify(raw, null, 2), mode);
    } catch {
      return {
        ok: false,
        code: "write-failed",
        error: "The credential store could not be written.",
      };
    }
    return { ok: true, stored: Boolean(text), encrypted };
  });
}

/** Wait for every queued write to this file (used by tests and by shutdown). */
const settled = (file) => queues.get(file) || Promise.resolve();

module.exports = {
  useForTests,
  setCallLimitForTests,
  available,
  availableNow,
  encryptText,
  decryptText,
  opened,
  readRaw,
  readRawStrict,
  writeAtomic,
  readEntries,
  setEntry,
  prime,
  settled,
  clear,
};
