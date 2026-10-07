/**
 * FRIDAY · owner voiceprint.
 *
 * The embedding, when one exists, is encrypted with Electron safeStorage.
 * A missing safe store refuses the write. Nothing here is a real person's
 * cloned voice, and a match never approves an action. The speaker model
 * itself stays an on-demand file; this module does not download it.
 */
const fs = require("fs");
const path = require("path");

let safeStorage = null;
let userData = "";
try {
  const electron = require("electron");
  safeStorage = electron.safeStorage;
  try {
    userData = electron.app?.getPath?.("userData") || "";
  } catch {
    userData = "";
  }
} catch {
  safeStorage = null;
}

function storePath() {
  const root = process.env.FRIDAY_ROOT || userData;
  return root ? path.join(root, "voiceprint.json") : "";
}

function encryptionReady() {
  try {
    return Boolean(safeStorage?.isEncryptionAvailable());
  } catch {
    return false;
  }
}

function status() {
  const file = storePath();
  const enrolled = Boolean(file && fs.existsSync(file));
  return {
    ok: true,
    enrolled,
    model: "not-on-disk",
    reason: enrolled
      ? "A voiceprint is saved. The speaker model is not on disk, so it is not scored."
      : "No voiceprint is saved. A missing voiceprint does not block speech.",
  };
}

function save(vector) {
  if (!Array.isArray(vector) || vector.length < 8 || vector.some((n) => typeof n !== "number")) {
    return { ok: false, reason: "voiceprint needs a numeric embedding" };
  }
  if (!encryptionReady()) {
    return { ok: false, reason: "voiceprint needs the desktop safe store" };
  }
  const file = storePath();
  if (!file) return { ok: false, reason: "no FRIDAY folder" };
  const enc = safeStorage.encryptString(JSON.stringify(vector)).toString("base64");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ enc }));
  return { ok: true, enrolled: true };
}

function clear() {
  const file = storePath();
  if (file && fs.existsSync(file)) fs.unlinkSync(file);
  return { ok: true, enrolled: false };
}

module.exports = { status, save, clear };
