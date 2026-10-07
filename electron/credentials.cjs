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

let safeStorage = null;
let electronApp = null;
try {
  ({ safeStorage, app: electronApp } = require("electron"));
} catch {
  safeStorage = null;
}

const encryptionAvailable = () => {
  try {
    return Boolean(safeStorage?.isEncryptionAvailable());
  } catch {
    return false;
  }
};

/**
 * An installed (packaged) FRIDAY is production: a secret that cannot be
 * encrypted is REFUSED there, never written as plain text. Development and the
 * test suite run without Electron's safeStorage, so they keep working.
 */
const productionMode = () => {
  try {
    return Boolean(electronApp?.isPackaged);
  } catch {
    return false;
  }
};

/** Why the store can or cannot hold a secret right now. */
const storageStatus = () => ({
  encrypted: encryptionAvailable(),
  production: productionMode(),
  usable: encryptionAvailable() || !productionMode(),
});

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
  const file = secretsFile(root);
  if (!file) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function writeAll(root, raw) {
  const file = secretsFile(root);
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(raw, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best effort on filesystems without POSIX modes */
    }
    return true;
  } catch {
    return false;
  }
}

/** Read one secret in clear text. Main-process only. */
function getSecret(root, id) {
  const value = readAll(root)[id];
  if (!value) return "";
  if (typeof value === "string") return value; // written before encryption existed
  if (value.enc && encryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(value.enc, "base64"));
    } catch {
      return ""; // encrypted on another machine
    }
  }
  return "";
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

/** Store (or, with an empty value, delete) one secret. Never logged. */
function setSecret(root, id, value) {
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };
  // Production always refuses plaintext. Unpackaged follows Settings → Security
  // once that toggle has been saved on this workspace (tests with a temp root
  // and no prefs file still write, so the suite keeps working).
  if (value && !encryptionAvailable() && (productionMode() || ownerRefusesUnencrypted(root))) {
    return {
      ok: false,
      error:
        "Windows secure storage is unavailable, so FRIDAY refuses to save this credential. " +
        "Sign in to your normal Windows account (not a temporary or sandboxed profile) and try again.",
    };
  }
  const raw = readAll(root);
  if (!value) delete raw[id];
  else if (encryptionAvailable())
    raw[id] = { enc: safeStorage.encryptString(String(value)).toString("base64") };
  else raw[id] = String(value);
  if (!writeAll(root, raw))
    return { ok: false, error: "The credential store could not be written." };
  return { ok: true, stored: Boolean(value), encrypted: encryptionAvailable() };
}

/**
 * Move a secret that historically lived in a config file into the canonical
 * store, then blank it in the config. Runs once; canonical always wins.
 */
function adoptLegacySecret(root, id, legacyValue) {
  if (!legacyValue) return false;
  if (hasSecret(root, id)) return true;
  return setSecret(root, id, legacyValue).ok;
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
  productionMode,
  storageStatus,
};
