// FRIDAY · canonical secret store.
//
// ONE place for every secret FRIDAY holds that is not a model provider key:
//   <FRIDAY_ROOT>/security/credentials/secrets.json
//
// Values are encrypted with Electron safeStorage when the OS provides it
// (DPAPI on Windows), so the file is useless on another machine. Secrets are
// never written to config.json, never sent to the renderer, never logged and
// never leave the selected FRIDAY root — no AppData, no temp, no localStorage.
const fs = require("node:fs");
const path = require("node:path");
const lazy = require("./lazy-electron.cjs");

// Encryption goes through electron/secret-box.cjs, the one module that uses the asynchronous
// safeStorage API (never while main.cjs is still loading: on Windows that export waits for ready,
// and ready waits for the load to finish). Reads stay synchronous and use what `prime` opened after
// the app was ready; writes are asynchronous and queued per file.
const secretBox = require("./secret-box.cjs");

function electronApp() {
  try {
    return lazy.electron()?.app || null;
  } catch {
    return null;
  }
}

/** The last known answer. False until `prime` or a write has asked the OS once. */
const encryptionAvailable = () => secretBox.availableNow();
const encryptionAvailableAsync = () => secretBox.available();

/**
 * An installed (packaged) FRIDAY is production: a secret that cannot be
 * encrypted is REFUSED there, never written as plain text. Development and the
 * test suite run without Electron's safeStorage, so they keep working.
 */
const productionMode = () => {
  try {
    return Boolean(electronApp()?.isPackaged);
  } catch {
    return false;
  }
};

/** Why the store can or cannot hold a secret right now (last known answer; `prime` refreshes it). */
const storageStatus = () => ({
  encrypted: encryptionAvailable(),
  production: productionMode(),
  usable: encryptionAvailable() || !productionMode(),
});

/** Open every stored secret once, after the app is ready, so reads can stay synchronous. */
function prime(root) {
  const file = secretsFile(root);
  return file ? secretBox.prime(file) : Promise.resolve({ ok: false, opened: 0, failed: 0 });
}

/** Canonical credential folder; honours an existing capitalised alias. */
function credentialsDir(root) {
  if (!root) return null;
  for (const name of ["security", "Security"]) {
    const dir = path.join(root, name);
    if (fs.existsSync(dir)) return path.join(dir, "credentials");
  }
  return path.join(root, "security", "credentials");
}

const secretsFile = (root) => {
  const dir = credentialsDir(root);
  return dir ? path.join(dir, "secrets.json") : null;
};

function readAll(root) {
  return secretBox.readRaw(secretsFile(root));
}

/** Read one secret in clear text. Main-process only. Empty until `prime` has opened it. */
function getSecret(root, id) {
  const file = secretsFile(root);
  if (!file) return "";
  return secretBox.readEntries(file).values[id] || "";
}

const hasSecret = (root, id) => Boolean(getSecret(root, id));

function listSecretIds(root) {
  return Object.keys(readAll(root));
}

/** Settings → Security "refuse new secrets when OS encryption is unavailable". */
function ownerRefusesUnencrypted(root) {
  try {
    const file = path.join(root, "config", "friday-preferences.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return Boolean(raw && raw.toggles && raw.toggles.encryption === true);
  } catch {
    return false;
  }
}

/** Store (or, with an empty value, delete) one secret. Asynchronous. Never logged. */
async function setSecret(root, id, value) {
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };
  const encrypted = await secretBox.available();
  // Production always refuses plaintext. Unpackaged follows Settings → Security
  // once that toggle has been saved on this workspace (tests with a temp root
  // and no prefs file still write, so the suite keeps working).
  const refuse = productionMode() || ownerRefusesUnencrypted(root);
  if (value && !encrypted && refuse) {
    return {
      ok: false,
      error:
        "Windows secure storage is unavailable, so FRIDAY refuses to save this credential. " +
        "Sign in to your normal Windows account (not a temporary or sandboxed profile) and try again.",
    };
  }
  const saved = await secretBox.setEntry(secretsFile(root), id, value, { allowPlain: !refuse });
  if (!saved.ok) return { ok: false, error: saved.error };
  return { ok: true, stored: saved.stored, encrypted: saved.encrypted };
}

/**
 * Move a secret that historically lived in a config file into the canonical
 * store, then blank it in the config. Runs once; canonical always wins.
 */
async function adoptLegacySecret(root, id, legacyValue) {
  if (!legacyValue) return false;
  if (hasSecret(root, id)) return true;
  return (await setSecret(root, id, legacyValue)).ok;
}

module.exports = {
  credentialsDir,
  secretsFile,
  getSecret,
  hasSecret,
  listSecretIds,
  setSecret,
  adoptLegacySecret,
  encryptionAvailable,
  encryptionAvailableAsync,
  prime,
  productionMode,
  storageStatus,
};
