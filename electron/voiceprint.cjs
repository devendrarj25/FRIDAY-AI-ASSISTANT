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
const secretBox = require("./secret-box.cjs");

let userData = "";

function userDataDir() {
  if (userData) return userData;
  try {
    const { app } = require("electron");
    // Electron 36+ can hang in getPath until ready, and ready waits on this
    // process. Leave the path empty until the app has finished starting.
    if (typeof app?.isReady === "function" && !app.isReady()) return "";
    userData = app?.getPath?.("userData") || "";
  } catch {
    userData = "";
  }
  return userData;
}

function storePath() {
  const root = process.env.FRIDAY_ROOT || userDataDir();
  return root ? path.join(root, "voiceprint.json") : "";
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

async function save(vector) {
  if (!Array.isArray(vector) || vector.length < 8 || vector.some((n) => typeof n !== "number")) {
    return { ok: false, reason: "voiceprint needs a numeric embedding" };
  }
  if (!(await secretBox.available())) {
    return { ok: false, reason: "voiceprint needs the desktop safe store" };
  }
  const file = storePath();
  if (!file) return { ok: false, reason: "no FRIDAY folder" };
  try {
    const enc = await secretBox.encryptText(JSON.stringify(vector));
    secretBox.writeAtomic(file, JSON.stringify({ enc }));
  } catch {
    // The old voiceprint file, if any, is untouched.
    return { ok: false, reason: "the voiceprint could not be saved" };
  }
  return { ok: true, enrolled: true };
}

/** The saved embedding, or null when none is saved or this PC cannot open it. */
async function load() {
  const file = storePath();
  if (!file || !(await secretBox.available())) return null;
  const raw = secretBox.readRaw(file);
  if (typeof raw.enc !== "string") return null;
  const opened = await secretBox.decryptText(raw.enc);
  if (!opened.ok) return null;
  try {
    const vector = JSON.parse(opened.text);
    return Array.isArray(vector) ? vector : null;
  } catch {
    return null;
  }
}

const OWNER_DIM_MIN = 64;
const OWNER_DIM_MAX = 1024;

/**
 * The owner's speaker-model centroid for the streaming ear's speaker tag (kernel/ear_scene.py), or null. Only
 * the main process reads it: it goes to the speech worker on stream-open and nowhere else (never the renderer,
 * a log or a cloud call). A saved vector of another size (an older voiceprint) or any error gives null, so the
 * speaker stays "unknown". A speaker tag never approves an action.
 */
async function loadOwnerEmbedding() {
  try {
    const vector = await load();
    if (
      !Array.isArray(vector) ||
      vector.length < OWNER_DIM_MIN ||
      vector.length > OWNER_DIM_MAX ||
      !vector.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      return null;
    }
    return vector;
  } catch {
    return null;
  }
}

function clear() {
  const file = storePath();
  if (file && fs.existsSync(file)) fs.unlinkSync(file);
  return { ok: true, enrolled: false };
}

function cosine(left, right) {
  if (
    !Array.isArray(left) ||
    !Array.isArray(right) ||
    left.length !== right.length ||
    !left.length
  ) {
    return null;
  }
  let dot = 0;
  let leftSq = 0;
  let rightSq = 0;
  for (let index = 0; index < left.length; index += 1) {
    const x = Number(left[index]);
    const y = Number(right[index]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    dot += x * y;
    leftSq += x * x;
    rightSq += y * y;
  }
  if (leftSq === 0 || rightSq === 0) return null;
  return dot / Math.sqrt(leftSq * rightSq);
}

function score(probe, enrolled, threshold) {
  const bar = Number(threshold);
  const limit = Number.isFinite(bar) ? bar : 0.75;
  const sim = cosine(probe, enrolled);
  if (sim == null) {
    return {
      ok: false,
      execute: false,
      match: false,
      score: null,
      reason: "voiceprint needs a numeric embedding",
    };
  }
  const match = sim >= limit;
  return {
    ok: true,
    execute: false,
    match,
    score: sim,
    reason: match ? "speaker-match" : "speaker-mismatch",
    license: "CC-BY-4.0",
  };
}

async function enrol(vector) {
  return save(vector);
}

function forget() {
  return clear();
}

module.exports = { status, save, load, loadOwnerEmbedding, clear, score, enrol, forget, cosine };
