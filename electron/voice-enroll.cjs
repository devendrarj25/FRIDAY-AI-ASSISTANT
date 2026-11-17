/**
 * FRIDAY · the owner's voice enrollment (desktop side).
 *
 * Settings → Voice records short samples of the owner's own voice. They are kept as 16 kHz WAV files with a text
 * file of what was said, in `<FRIDAY folder>/preferences/voice-enrollment/samples` (the same recording + text layout
 * the speech model check reads). The kernel's wake worker turns them into a profile (kernel/voice_enroll.py):
 * a voiceprint and a personal "Friday" template. The profile is encrypted with the Windows safe store, kept beside
 * the samples, and handed to the worker when it starts, so it is never on disk in the clear.
 *
 * Nothing here leaves the PC. A voice match never approves an action (src/lib/friday/voice-session.ts), and
 * "Forget my voice" removes the samples, the profile and the older voiceprint file.
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const paths = require("./friday-paths.cjs");
const lazy = require("./lazy-electron.cjs");

const RATE = 16_000;
const MIN_MS = 400;
const MAX_MS = 15_000;
const MIN_RMS = 0.004; // about -48 dBFS: quieter than this is the room, not a voice
const CLIP_LEVEL = 0.985;
const MAX_CLIPPED = 0.01;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const KINDS = new Set(["wake", "speech"]);

/** The worker generation the profile was last loaded into. A restarted worker has none. */
let loadedGeneration = -1;

/** Tests replace the wake worker and the safe store; the app never does. */
let injected = {};
function useForTests(deps = {}) {
  injected = deps;
  loadedGeneration = -1;
}

function wake() {
  return injected.wake || require("./wake-engine.cjs");
}

function baseDir() {
  const folder = paths.file("preferences", "voice-enrollment");
  return folder;
}

function samplesDir() {
  return path.join(baseDir(), "samples");
}

const manifestFile = () => path.join(baseDir(), "manifest.json");
const profileFile = () => path.join(baseDir(), "profile.enc");

function safeStorage() {
  return injected.safeStorage || lazy.afterReady("safeStorage");
}

function encryptionReady() {
  try {
    return Boolean(safeStorage()?.isEncryptionAvailable());
  } catch {
    return false;
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function readManifest() {
  const raw = readJson(manifestFile(), { samples: [], changedAt: 0 });
  return {
    samples: Array.isArray(raw.samples)
      ? raw.samples.filter((row) => row && ID_PATTERN.test(row.id))
      : [],
    changedAt: Number(raw.changedAt) || 0,
  };
}

function writeManifest(manifest) {
  writeJson(manifestFile(), { samples: manifest.samples, changedAt: Date.now() });
}

/**
 * A 16 kHz mono PCM16 WAV and what it holds: length, loudness, clipping. Refuses anything else, so a sample on
 * disk is always one the kernel can use and the owner can play back.
 */
function inspectWav(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (
    buf.length < 44 ||
    buf.toString("ascii", 0, 4) !== "RIFF" ||
    buf.toString("ascii", 8, 12) !== "WAVE"
  ) {
    return { ok: false, reason: "not-a-wav", detail: "the recording is not a WAV file" };
  }
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= buf.length) {
      format = {
        tag: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      data = buf.subarray(body, Math.min(buf.length, body + size));
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!format || !data)
    return { ok: false, reason: "not-a-wav", detail: "the WAV header is incomplete" };
  if (format.tag !== 1 || format.channels !== 1 || format.rate !== RATE || format.bits !== 16) {
    return { ok: false, reason: "wrong-format", detail: "needs 16 kHz mono 16-bit PCM" };
  }
  const count = Math.floor(data.length / 2);
  const durationMs = Math.round((count / RATE) * 1000);
  if (durationMs < MIN_MS)
    return { ok: false, reason: "too-short", detail: "the recording is too short" };
  if (durationMs > MAX_MS)
    return { ok: false, reason: "too-long", detail: "the recording is too long" };
  let sum = 0;
  let peak = 0;
  let clipped = 0;
  for (let i = 0; i < count; i += 1) {
    const v = data.readInt16LE(i * 2) / 32768;
    const a = Math.abs(v);
    sum += v * v;
    if (a > peak) peak = a;
    if (a >= CLIP_LEVEL) clipped += 1;
  }
  const rms = Math.sqrt(sum / count);
  if (rms < MIN_RMS) {
    return {
      ok: false,
      reason: "too-quiet",
      detail: "too quiet: move closer to the microphone",
      rms,
      peak,
      durationMs,
    };
  }
  if (clipped / count > MAX_CLIPPED) {
    return {
      ok: false,
      reason: "clipped",
      detail: "too loud and distorted: speak a little softer",
      rms,
      peak,
      durationMs,
    };
  }
  return { ok: true, durationMs, rms: Number(rms.toFixed(5)), peak: Number(peak.toFixed(4)) };
}

function cleanText(value) {
  return String(value || "")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 240);
}

function saveSample({ id, kind, promptId, text, language, wavBytes } = {}) {
  if (!ID_PATTERN.test(String(id || "")))
    return { ok: false, reason: "bad-id", detail: "bad sample id" };
  if (!KINDS.has(kind)) return { ok: false, reason: "bad-kind", detail: "kind is wake or speech" };
  if (!paths.root())
    return { ok: false, reason: "no-root", detail: "choose a FRIDAY folder first" };
  const verdict = inspectWav(wavBytes);
  if (!verdict.ok) return verdict;
  fs.mkdirSync(samplesDir(), { recursive: true });
  const file = path.join(samplesDir(), `${id}.wav`);
  fs.writeFileSync(file, Buffer.from(wavBytes));
  const said = cleanText(text);
  fs.writeFileSync(path.join(samplesDir(), `${id}.txt`), `${said}\n`, "utf8");
  const manifest = readManifest();
  const row = {
    id,
    kind,
    promptId: String(promptId || "").slice(0, 60),
    text: said,
    language: String(language || "").slice(0, 12),
    durationMs: verdict.durationMs,
    rms: verdict.rms,
    peak: verdict.peak,
    createdAt: Date.now(),
  };
  manifest.samples = [...manifest.samples.filter((item) => item.id !== id), row];
  writeManifest(manifest);
  return { ok: true, sample: row, counts: counts(manifest) };
}

function removeFiles(id) {
  for (const ext of ["wav", "txt"]) {
    try {
      fs.rmSync(path.join(samplesDir(), `${id}.${ext}`), { force: true });
    } catch {
      /* a file that stays is removed with the folder */
    }
  }
}

function deleteSample(id) {
  if (!ID_PATTERN.test(String(id || ""))) return { ok: false, reason: "bad-id" };
  const manifest = readManifest();
  manifest.samples = manifest.samples.filter((row) => row.id !== id);
  removeFiles(id);
  writeManifest(manifest);
  return { ok: true, counts: counts(manifest) };
}

function readSample(id) {
  if (!ID_PATTERN.test(String(id || ""))) return { ok: false, reason: "bad-id" };
  try {
    return { ok: true, bytes: fs.readFileSync(path.join(samplesDir(), `${id}.wav`)) };
  } catch {
    return { ok: false, reason: "missing" };
  }
}

function counts(manifest = readManifest()) {
  const byPrompt = {};
  let wakeTakes = 0;
  let speechClips = 0;
  let seconds = 0;
  for (const row of manifest.samples) {
    byPrompt[row.promptId] = (byPrompt[row.promptId] || 0) + 1;
    if (row.kind === "wake") wakeTakes += 1;
    else {
      speechClips += 1;
      seconds += (row.durationMs || 0) / 1000;
    }
  }
  return {
    total: manifest.samples.length,
    wakeTakes,
    speechClips,
    speechSeconds: Math.round(seconds),
    byPrompt,
  };
}

// ----------------------------------------------------------------------------- profile (encrypted at rest)
function readProfileFile() {
  const raw = readJson(profileFile(), null);
  return raw && typeof raw.enc === "string" ? raw : null;
}

function decryptProfile() {
  const raw = readProfileFile();
  if (!raw || !encryptionReady()) return null;
  try {
    return JSON.parse(safeStorage().decryptString(Buffer.from(raw.enc, "base64")));
  } catch {
    return null;
  }
}

function saveProfile(profile, summary) {
  const enc = safeStorage().encryptString(JSON.stringify(profile)).toString("base64");
  writeJson(profileFile(), { v: 1, enc, builtAt: Date.now(), summary });
}

function status() {
  const manifest = readManifest();
  const file = readProfileFile();
  const built = Boolean(file);
  return {
    ok: true,
    folder: paths.root() ? samplesDir() : "",
    encryption: encryptionReady(),
    counts: counts(manifest),
    samples: manifest.samples.map((row) => ({
      id: row.id,
      kind: row.kind,
      promptId: row.promptId,
      durationMs: row.durationMs,
      createdAt: row.createdAt,
    })),
    profile: {
      built,
      builtAt: file?.builtAt || 0,
      stale: built && manifest.changedAt > (file?.builtAt || 0),
      summary: file?.summary || null,
    },
  };
}

// ----------------------------------------------------------------------------- the worker
async function ensureLoaded() {
  const { result, generation } = await wake().workerCall({ op: "enroll_summary" }, 30_000);
  if (generation === loadedGeneration && result?.summary?.built) return true;
  const profile = decryptProfile();
  if (!profile) return false;
  const loaded = await wake().workerCall({ op: "enroll_load", profile }, 30_000);
  loadedGeneration = loaded.generation;
  return Boolean(loaded.result?.ok);
}

async function build() {
  if (!paths.root()) return { ok: false, reason: "no-root", error: "choose a FRIDAY folder first" };
  if (!encryptionReady()) {
    return {
      ok: false,
      reason: "no-safe-store",
      error: "the Windows safe store is not available, so the voiceprint cannot be saved encrypted",
    };
  }
  const manifest = readManifest();
  if (!manifest.samples.length)
    return { ok: false, reason: "no-samples", error: "record some samples first" };
  const samples = manifest.samples.map((row) => ({
    id: row.id,
    kind: row.kind,
    path: path.join(samplesDir(), `${row.id}.wav`),
  }));
  let answer;
  try {
    answer = await wake().workerCall({ op: "enroll_build", samples }, 180_000);
  } catch (error) {
    return { ok: false, reason: "worker", error: String((error && error.message) || error) };
  }
  const result = answer.result;
  if (!result?.ok || !result.profile) {
    return {
      ok: false,
      reason: result?.reason || "build-failed",
      error: result?.error || "the profile was not built",
    };
  }
  saveProfile(result.profile, result.summary);
  loadedGeneration = answer.generation;
  return { ok: true, summary: result.summary, skipped: result.skipped || [] };
}

function tempAudio(mime) {
  const ext = /ogg/.test(mime || "") ? "ogg" : /wav/.test(mime || "") ? "wav" : "webm";
  const dir = path.join(paths.root() ? paths.ensureDir("cache") : os.tmpdir(), "voice-enroll-in");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${crypto.randomBytes(8).toString("hex")}.${ext}`);
}

/**
 * Score one utterance against the saved profile: speaker similarity and the personal wake match. With no profile
 * it answers `enrolled: false` at once, without starting the worker. Never throws.
 */
async function score({ audioBytes, mime } = {}) {
  if (!readProfileFile()) return { ok: true, enrolled: false, speaker: null, wake: null };
  const bytes =
    audioBytes && (audioBytes.length || audioBytes.byteLength) ? Buffer.from(audioBytes) : null;
  if (!bytes) return { ok: false, reason: "no-audio" };
  const file = tempAudio(mime);
  try {
    fs.writeFileSync(file, bytes);
    if (!(await ensureLoaded())) return { ok: false, reason: "profile-unreadable" };
    const { result } = await wake().workerCall({ op: "enroll_score", audio: file }, 30_000);
    if (!result?.ok) return { ok: false, reason: result?.reason || "score-failed" };
    return {
      ok: true,
      enrolled: Boolean(result.speaker?.enrolled),
      engine: result.engine,
      evidence: result.evidence,
      speaker: result.speaker,
      wake: result.wake,
    };
  } catch (error) {
    return { ok: false, reason: "worker", error: String((error && error.message) || error) };
  } finally {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* a temporary clip that stays is cleared with the cache */
    }
  }
}

function clearRecordings() {
  try {
    fs.rmSync(samplesDir(), { recursive: true, force: true });
  } catch {
    /* reported by the status that follows */
  }
  const manifest = { samples: [] };
  writeManifest(manifest);
  return { ok: true, counts: counts(manifest) };
}

/** Everything: the recordings, the profile, the older voiceprint file, and the worker's copy. */
async function forget() {
  try {
    fs.rmSync(baseDir(), { recursive: true, force: true });
  } catch {
    /* the status that follows says what is left */
  }
  try {
    require("./voiceprint.cjs").clear();
  } catch {
    /* no older voiceprint */
  }
  loadedGeneration = -1;
  try {
    await wake().workerCall({ op: "enroll_clear" }, 10_000);
  } catch {
    /* no worker running: nothing is held in memory */
  }
  return { ok: true, ...status() };
}

module.exports = {
  MIN_MS,
  MAX_MS,
  inspectWav,
  saveSample,
  deleteSample,
  readSample,
  clearRecordings,
  forget,
  build,
  score,
  status,
  counts,
  samplesDir,
  ensureLoaded,
  useForTests,
};
