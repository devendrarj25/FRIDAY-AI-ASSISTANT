/**
 * FRIDAY · the owner's voice privacy (desktop side).
 *
 * No raw audio is kept by default. Three things hold voice data on this PC, and this file is the one place that
 * knows all three:
 *   1. the enrolment samples, the encrypted voiceprint and the older voiceprint file (electron/voice-enroll.cjs);
 *   2. the utterance WAVs the speech worker keeps only when the owner turns the retention setting on
 *      (`<FRIDAY folder>/debug/reports/utterances`, written by kernel/stt.py);
 *   3. the consent record: the time the owner agreed that FRIDAY may store a voice sample. It holds that time and a
 *      notice number, nothing else (no name, no address, no device id).
 *
 *   4. the audio caches the speech paths leave in the cache folder: the spoken replies (`cache/tts`), raw clips a
 *      crash left behind (`cache/stt-in`), wake-word temp clips (`cache/wake-in`, and the temp folder when no
 *      folder was chosen) and the system-voice clips in the temp folder (`friday-sapi`). Only FRIDAY's own
 *      folders and, in the shared temp folder, only files FRIDAY names that way are touched.
 *
 * Saving an enrolment sample or building a voiceprint needs the consent record. "Delete my voice data" removes all
 * of them and says what it removed and what is left. Nothing here leaves the PC.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const paths = require("./friday-paths.cjs");

/** Bumped when the wording the owner agrees to changes, so an old record is not mistaken for a new agreement. */
const NOTICE_VERSION = 1;
const DAY_MS = 86_400_000;
const MIN_DAYS = 1;
const MAX_DAYS = 90;
const DEFAULT_DAYS = 7;

/** Tests replace the enrolment module and the clock; the app never does. */
let injected = {};
function useForTests(deps = {}) {
  injected = deps;
}

const now = () => (injected.now ? injected.now() : Date.now());
const enroll = () => injected.enroll || require("./voice-enroll.cjs");
const tmpRoot = () => (injected.tmpdir ? injected.tmpdir() : require("node:os").tmpdir());

function privacyDir() {
  return paths.file("preferences", "voice-privacy");
}

const consentFile = () => path.join(privacyDir(), "consent.json");
const retentionFile = () => path.join(privacyDir(), "retention.json");

/** Where the speech worker keeps utterance WAVs (kernel/stt.py `_record_hearing`), under the same data root. */
function wavsDir() {
  return path.join(paths.root() || "", "debug", "reports", "utterances");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function cleanDays(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, n));
}

// ----------------------------------------------------------------------------- consent
/** The consent on record, or null. A record from an older notice does not count. */
function readConsent() {
  if (!paths.root()) return null;
  const raw = readJson(consentFile());
  if (!raw || raw.notice !== NOTICE_VERSION || !Number.isFinite(raw.givenAt) || raw.givenAt <= 0)
    return null;
  return { givenAt: raw.givenAt, notice: raw.notice };
}

function hasConsent() {
  return readConsent() !== null;
}

/** Record the owner's agreement. Only the time and the notice number are written. */
function grantConsent() {
  if (!paths.root())
    return { ok: false, reason: "no-root", detail: "choose a FRIDAY folder first" };
  const existing = readConsent();
  if (existing) return { ok: true, consent: existing };
  const record = { v: 1, notice: NOTICE_VERSION, givenAt: now() };
  writeJson(consentFile(), record);
  return { ok: true, consent: { givenAt: record.givenAt, notice: record.notice } };
}

// ----------------------------------------------------------------------------- kept utterance WAVs
function listWavs() {
  const dir = wavsDir();
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => /\.wav$/i.test(name))
      .map((name) => {
        const file = path.join(dir, name);
        const stat = fs.statSync(file);
        return { file, bytes: stat.size, modifiedAt: stat.mtimeMs };
      });
  } catch {
    return [];
  }
}

function wavSummary() {
  const rows = listWavs();
  return {
    folder: paths.root() ? wavsDir() : "",
    count: rows.length,
    bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
  };
}

/** The retention the renderer last told us about (it is copied here so the app can clean up at start). */
function readRetention() {
  const raw = (paths.root() && readJson(retentionFile())) || {};
  return { keep: raw.keep === true, days: cleanDays(raw.days) };
}

/**
 * Remove kept WAVs older than the retention, or all of them when retention is off. Never touches a file that is
 * not a `.wav` inside the utterances folder.
 */
function pruneWavs({ keep, days } = readRetention()) {
  const limit = keep === true ? now() - cleanDays(days) * DAY_MS : Infinity;
  let removed = 0;
  for (const row of listWavs()) {
    if (row.modifiedAt >= limit) continue;
    try {
      fs.rmSync(row.file, { force: true });
      removed += 1;
    } catch {
      /* a clip that stays is reported by the next status */
    }
  }
  return { ok: true, removed, ...wavSummary() };
}

/** Remember the owner's retention choice and apply it at once. Off removes every kept clip. */
function setRetention({ keep, days } = {}) {
  if (!paths.root())
    return { ok: false, reason: "no-root", detail: "choose a FRIDAY folder first" };
  const next = { keep: keep === true, days: cleanDays(days) };
  writeJson(retentionFile(), { v: 1, ...next });
  return { ...pruneWavs(next), retention: next };
}

// ----------------------------------------------------------------------------- audio caches
/** Files FRIDAY writes into the shared temp folder: a random hex name, an audio extension (wake-engine.cjs). */
const TEMP_CLIP = /^[0-9a-f]{16}\.(?:webm|ogg|wav)$/;

/** Every audio cache location with the group it is counted under. A `names` filter limits a shared folder. */
function cacheTargets() {
  const targets = [];
  if (paths.root()) {
    const cache = paths.dir("cache");
    targets.push(
      { group: "replies", dir: path.join(cache, "tts"), own: true },
      { group: "rawClips", dir: path.join(cache, "stt-in"), own: true },
      { group: "wakeClips", dir: path.join(cache, "wake-in"), own: true },
    );
  }
  const tmp = tmpRoot();
  targets.push(
    { group: "wakeClips", dir: path.join(tmp, "wake-in"), own: false },
    { group: "systemClips", dir: path.join(tmp, "friday-sapi"), own: true },
  );
  return targets;
}

function cacheFiles(target) {
  try {
    return fs
      .readdirSync(target.dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && (target.own || TEMP_CLIP.test(entry.name)))
      .map((entry) => path.join(target.dir, entry.name));
  } catch {
    return [];
  }
}

function cacheSummary() {
  let count = 0;
  let bytes = 0;
  for (const target of cacheTargets()) {
    for (const file of cacheFiles(target)) {
      count += 1;
      try {
        bytes += fs.statSync(file).size;
      } catch {
        /* a file that vanished is not counted */
      }
    }
  }
  return { count, bytes };
}

/** Remove the spoken-reply, raw-clip, wake and system-voice audio. Returns how many files went, per group. */
function clearCaches() {
  const cleared = { replies: 0, rawClips: 0, wakeClips: 0, systemClips: 0 };
  for (const target of cacheTargets()) {
    for (const file of cacheFiles(target)) {
      try {
        fs.rmSync(file, { force: true });
        cleared[target.group] += 1;
      } catch {
        /* named by the check that follows */
      }
    }
  }
  return cleared;
}

// ----------------------------------------------------------------------------- status and delete
function status() {
  const consent = readConsent();
  let enrolment = { samples: 0, profile: false };
  try {
    const row = enroll().status();
    enrolment = { samples: row.counts.total, profile: row.profile.built };
  } catch {
    /* the enrolment module is not loaded: nothing is held through it */
  }
  return {
    ok: true,
    consent: { given: consent !== null, givenAt: consent ? consent.givenAt : 0 },
    enrolment,
    wavs: wavSummary(),
    caches: cacheSummary(),
    retention: readRetention(),
    limits: { minDays: MIN_DAYS, maxDays: MAX_DAYS, defaultDays: DEFAULT_DAYS },
  };
}

/** What `deleteAll` finds still on disk, so a failure is named instead of hidden. */
function leftovers() {
  const left = [];
  if (!paths.root()) return left;
  const enrolment = paths.file("preferences", "voice-enrollment");
  if (fs.existsSync(enrolment)) left.push("voice enrolment");
  if (listWavs().length) left.push("kept utterance clips");
  if (cacheSummary().count) left.push("spoken-reply and clip caches");
  if (fs.existsSync(consentFile())) left.push("consent record");
  return left;
}

/**
 * Delete every piece of voice data FRIDAY holds: enrolment samples and voiceprint, kept utterance WAVs, the audio caches
 * and the consent record. The answer says how much went and whether anything is left.
 */
async function deleteAll() {
  if (!paths.root())
    return { ok: false, reason: "no-root", detail: "choose a FRIDAY folder first", left: [] };
  const before = status();
  try {
    await enroll().forget();
  } catch {
    /* the check below names anything that stayed */
  }
  try {
    // Only the utterances folder is ours; the reports folder beside it stays.
    fs.rmSync(wavsDir(), { recursive: true, force: true });
  } catch {
    /* named by the check below */
  }
  const cleared = clearCaches();
  try {
    fs.rmSync(consentFile(), { force: true });
  } catch {
    /* named by the check below */
  }
  const left = leftovers();
  return {
    ok: left.length === 0,
    removed: {
      samples: before.enrolment.samples,
      profile: before.enrolment.profile,
      wavs: before.wavs.count,
      consent: before.consent.given,
    },
    cleared,
    left,
    status: status(),
  };
}

module.exports = {
  NOTICE_VERSION,
  MIN_DAYS,
  MAX_DAYS,
  DEFAULT_DAYS,
  hasConsent,
  readConsent,
  grantConsent,
  wavsDir,
  pruneWavs,
  setRetention,
  readRetention,
  status,
  deleteAll,
  useForTests,
};
