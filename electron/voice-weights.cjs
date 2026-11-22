/**
 * Voice weights are fetched here, then the worker opens the folder.
 * The worker does not download. Every speech size and the neural voice are pinned by revision and
 * SHA-256 in `voice-pins.cjs`; the downloader enforces the pin and a repair removes only a bad file.
 */
const path = require("path");
const pins = require("./voice-pins.cjs");

const STT_REPOS = {
  tiny: "Systran/faster-whisper-tiny",
  base: "Systran/faster-whisper-base",
  small: "Systran/faster-whisper-small",
  medium: "Systran/faster-whisper-medium",
  "large-v3": "Systran/faster-whisper-large-v3",
  // The MIT conversion of openai/whisper-large-v3-turbo that faster-whisper itself names `large-v3-turbo`
  // (its model table, read 2026-11-08). Close to large-v3 in size of vocabulary with far less decoding work.
  "large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
};

/**
 * Where a size is fetched from if its first repository stops answering. The turbo repository was renamed
 * from `mobiuslabsgmbh` to `dropbox-dash` (Hugging Face redirects the old name today, checked 2026-11-09), so the
 * new name is the second source: the same files, the same MIT licence, used only when the first fails.
 */
const STT_FALLBACK_REPOS = {
  "large-v3-turbo": ["dropbox-dash/faster-whisper-large-v3-turbo"],
};

/** The neural voice repository; its folder is `<root>/models/supertonic-3`. */
const TTS_REPO = "Supertone/supertonic-3";

/** FRIDAY's Hindi ear: the Hindi IndicConformer int8 ONNX, in `<root>/models/hindi-ear` (see kernel/hindi_ear.py). */
const HINDI_EAR_REPO = "OpenVoiceOS/ai4bharat-indicconformer-hi-onnx";

/** The optional Hinglish ear (Roman letters, faster-whisper CT2) in `<root>/models/hinglish-ear` (see kernel/whisper_ears.py). */
const HINGLISH_EAR_REPO = "MSpider3/whisper-hindi2hinglish-swift-ct2";

/** The optional Hindi fallback (CC-BY-4.0, faster-whisper CT2) in `<root>/models/hindi-fallback-ear`. */
const HINDI_FALLBACK_REPO = "collabora/faster-whisper-small-hindi";

/**
 * The optional ears that live in `<root>/models/<catalogId>`. Each is installed only when every pinned file is on
 * disk, and each gets one Doctor pin row. The Hindi ear is run by onnx-asr; the other two are faster-whisper folders.
 */
const EAR_MODELS = [
  { catalogId: "hindi-ear", repo: HINDI_EAR_REPO, rowId: "hindi-ear-pin", label: "Hindi ear" },
  {
    catalogId: "hinglish-ear",
    repo: HINGLISH_EAR_REPO,
    rowId: "hinglish-ear-pin",
    label: "Hinglish ear",
  },
  {
    catalogId: "hindi-fallback-ear",
    repo: HINDI_FALLBACK_REPO,
    rowId: "hindi-fallback-ear-pin",
    label: "Hindi fallback ear",
  },
];

/** True when every file the pin lists is in the ear's folder. */
function earOnDisk(root, ear, exists) {
  const dir = path.join(root, "models", ear.catalogId);
  const pin = pins.pinForRepo(ear.repo);
  return Boolean(pin) && Object.keys(pin.files).every((name) => exists(path.join(dir, name)));
}

const STT_FILES = ["config.json", "model.bin", "tokenizer.json", "vocabulary.txt"];

const PINNED = [
  {
    id: "smart-turn",
    file: "smart-turn-v3.2-cpu.onnx",
    url: "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx",
    sha256: "2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f",
    bytes: 8679182,
    dir: ["models", "smart-turn"],
  },
  {
    id: "silero-vad",
    file: "silero_vad.onnx",
    url: "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx",
    sha256: "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
    bytes: 2327524,
    dir: ["models", "silero-vad"],
  },
];

function sttSize(model) {
  return STT_REPOS[model] ? model : "base";
}

function sttPlan(model, root) {
  const size = sttSize(model);
  const base = root || "";
  const dir = path.join(base, "cache", "stt", size);
  return {
    id: `stt-${size}`,
    size,
    repo: STT_REPOS[size],
    dir,
    files: STT_FILES,
    sha256: null,
    pin: pins.pinForRepo(STT_REPOS[size]),
    sources: [
      { kind: "hf-repo", repo: STT_REPOS[size], label: "Hugging Face" },
      ...(STT_FALLBACK_REPOS[size] || []).map((repo) => ({
        kind: "hf-repo",
        repo,
        label: "Hugging Face (renamed repository)",
      })),
    ],
  };
}

function weightsReady(dir, exists) {
  const check = exists || (() => false);
  return STT_FILES.filter((name) => name === "config.json" || name === "model.bin").every((name) =>
    check(path.join(dir, name)),
  );
}

/** Smallest to largest, the order a size is traded for another. */
const SIZE_ORDER = ["tiny", "base", "small", "medium", "large-v3-turbo", "large-v3"];

/** Speech sizes whose weights are really on disk, smallest first. */
function installedSizes(root, exists) {
  const check = exists || (() => false);
  if (!root) return [];
  return SIZE_ORDER.filter((size) => weightsReady(path.join(root, "cache", "stt", size), check));
}

/**
 * The size to listen with right now when `wanted` is not on disk: the nearest installed size at or
 * below it first (it is never slower than what was asked for), then the nearest larger one.
 * Returns "" when nothing is installed, and `wanted` itself when it is.
 */
function nearestInstalled(wanted, installed) {
  const have = SIZE_ORDER.filter((size) => (installed || []).includes(size));
  if (!have.length) return "";
  if (have.includes(wanted)) return wanted;
  const at = SIZE_ORDER.indexOf(wanted);
  const below = have.filter((size) => SIZE_ORDER.indexOf(size) < at);
  if (below.length) return below[below.length - 1];
  return have[0];
}

function pinnedJobs() {
  return PINNED.map((row) => ({ ...row, dir: [...row.dir] }));
}

/**
 * Voices that the speech worker does not download. Supertonic is fetched by the Install Manager at its
 * pinned revision (`voice-pins.cjs`), not by the worker, so `url` stays null. The speaker file is not
 * downloaded, and the wake audio ships with the app.
 */
function otherVoiceJobs() {
  const tts = pins.pinForRepo(TTS_REPO);
  return [
    {
      id: "supertonic-3",
      sha256: null,
      url: null,
      repo: TTS_REPO,
      revision: tts.revision,
      pinned: true,
      reason: "the Install Manager fetches it at a pinned revision; the worker does not download",
    },
    {
      id: "speaker",
      sha256: null,
      url: null,
      reason: "the speaker file is not downloaded",
    },
    {
      id: "wake",
      sha256: null,
      url: null,
      bundled: true,
      reason: "the wake model ships with the app",
    },
  ];
}

/** Models-page catalog id for each speech size FRIDAY can load. */
const STT_CATALOG = {
  tiny: "faster-whisper-tiny",
  base: "faster-whisper-base",
  small: "faster-whisper-small",
  medium: "faster-whisper-medium",
  "large-v3": "faster-whisper",
  "large-v3-turbo": "faster-whisper-large-v3-turbo",
};

/**
 * Voice models that are really on disk, by the same paths the speech worker
 * and the kernel open. The Models page marks exactly these as installed.
 */
function voiceModelsOnDisk(root, exists) {
  const check = exists || (() => false);
  if (!root) return [];
  const found = [];
  for (const [size, catalogId] of Object.entries(STT_CATALOG)) {
    const dir = path.join(root, "cache", "stt", size);
    if (weightsReady(dir, check)) found.push({ catalogId, path: dir, kind: "stt" });
  }
  for (const row of PINNED) {
    const file = path.join(root, ...row.dir, row.file);
    if (check(file)) found.push({ catalogId: row.id, path: file, kind: "voice" });
  }
  for (const dir of [
    path.join(root, "models", "supertonic-3"),
    path.join(root, "models", "voice", "supertonic-3"),
  ]) {
    if (check(path.join(dir, "onnx", "vocoder.onnx"))) {
      found.push({ catalogId: "supertonic-3", path: dir, kind: "tts" });
      break;
    }
  }
  for (const ear of EAR_MODELS) {
    if (earOnDisk(root, ear, check)) {
      found.push({
        catalogId: ear.catalogId,
        path: path.join(root, "models", ear.catalogId),
        kind: "stt",
      });
    }
  }
  return found;
}

/** Where the Models page should download a speech size so the worker finds it. */
function downloadTarget(catalogId, root) {
  if (!root) return null;
  const size = Object.keys(STT_CATALOG).find((key) => STT_CATALOG[key] === catalogId);
  return size ? { dir: path.join(root, "cache", "stt"), folderId: size } : null;
}

/** Audit a speech size against its pin. Size always; the SHA-256 too with `hash`. */
function auditStt(model, root, deps = {}) {
  const size = sttSize(model);
  const pin = pins.pinForRepo(STT_REPOS[size]);
  return pins.auditDir(path.join(root, "cache", "stt", size), pin, deps);
}

/** Audit the installed neural voice against its pin; null when it is not installed. */
async function auditTts(root, deps = {}) {
  const exists = deps.exists || (() => false);
  const pin = pins.pinForRepo(TTS_REPO);
  for (const dir of [
    path.join(root, "models", "supertonic-3"),
    path.join(root, "models", "voice", "supertonic-3"),
  ]) {
    if (exists(path.join(dir, "onnx", "vocoder.onnx"))) {
      return { dir, ...(await pins.auditDir(dir, pin, deps)) };
    }
  }
  return null;
}

/**
 * One row per installed voice model for the voice check: does it match its pin?
 * A speech size is listed only when it is on disk. `hash` also verifies every SHA-256.
 */
async function pinChecks(root, deps = {}) {
  const exists = deps.exists || (() => false);
  const rows = [];
  const describe = (audit) =>
    audit.ok
      ? `${audit.checked} files match the pinned revision${audit.hashed ? " and SHA-256" : " and size"}`
      : [
          ...audit.missing.map((name) => `${name} missing`),
          ...audit.wrongSize.map((name) => `${name} wrong size`),
          ...audit.wrongDigest.map((name) => `${name} fails SHA-256`),
        ].join(", ");
  for (const size of installedSizes(root, exists)) {
    const audit = await auditStt(size, root, deps);
    rows.push({
      id: `stt-pin-${size}`,
      label: `speech ${size} matches its pin`,
      ok: audit.ok,
      detail: describe(audit),
    });
  }
  for (const ear of EAR_MODELS) {
    // A row appears only when the ear is installed (every pinned file present). A short or tampered file is red.
    if (!earOnDisk(root, ear, exists)) continue;
    const audit = await pins.auditDir(
      path.join(root, "models", ear.catalogId),
      pins.pinForRepo(ear.repo),
      deps,
    );
    rows.push({
      id: ear.rowId,
      label: `${ear.label} matches its pin`,
      ok: audit.ok,
      detail: describe(audit),
    });
  }
  const tts = await auditTts(root, { ...deps, exists });
  if (tts) {
    rows.push({
      id: "tts-pin",
      label: "neural voice matches its pin",
      ok: tts.ok,
      detail: describe(tts),
    });
  }
  return rows;
}

async function ensureSttWeights(model, root, deps = {}) {
  const plan = sttPlan(model, root);
  plan.skipped = otherVoiceJobs().map((row) => row.id);
  plan.pinned = pinnedJobs().map((row) => row.id);
  const exists = deps.exists || (() => false);
  if (!root)
    return { ok: false, cause: "path", error: "no FRIDAY folder is selected", dir: plan.dir };
  // `verify: "size"` or `"hash"` checks the folder against its pin; a damaged or missing file is removed
  // (only that file) and fetched again, so a half-written or tampered weight never reaches the worker.
  const verify = deps.verify === "hash" ? "hash" : deps.verify === "size" ? "size" : "";
  let repaired = [];
  if (weightsReady(plan.dir, exists)) {
    if (!verify || !plan.pin) return { ok: true, dir: plan.dir, downloaded: false, plan };
    const audit = await pins.auditDir(plan.dir, plan.pin, { ...deps, hash: verify === "hash" });
    if (audit.ok) return { ok: true, dir: plan.dir, downloaded: false, plan, verified: verify };
    repaired = pins.removeBad(plan.dir, audit, deps.remove);
  }
  if (typeof deps.downloadModel !== "function") {
    return {
      ok: false,
      cause: repaired.length ? "checksum" : "downloading",
      error: repaired.length
        ? `speech weights failed their pin (${repaired.join(", ")}) and the downloader is unavailable`
        : "speech weights are not on disk and the downloader is unavailable",
      dir: plan.dir,
      plan,
    };
  }
  const result = await deps.downloadModel(
    {
      modelId: plan.size,
      sources: plan.sources,
      dir: path.join(root, "cache", "stt"),
    },
    deps.onEvent,
    deps.signal,
  );
  if (!result?.ok && !repaired.length && weightsReady(plan.dir, exists)) {
    // Nothing was damaged: a pinned file was only missing (a vocabulary or preprocessor file) and the
    // network is not there. The weights that opened before still open; this is not a reason to go silent.
    return { ok: true, dir: plan.dir, downloaded: false, plan, unverified: true };
  }
  if (!result?.ok) {
    return {
      ok: false,
      cause: result?.cause || "downloading",
      error: result?.error || "the speech weights did not download",
      dir: plan.dir,
      plan,
    };
  }
  if (!weightsReady(plan.dir, exists)) {
    return {
      ok: false,
      cause: "model-failed",
      error: "the speech weights download finished without a model file",
      dir: plan.dir,
      plan,
    };
  }
  if (verify && plan.pin) {
    const after = await pins.auditDir(plan.dir, plan.pin, { ...deps, hash: verify === "hash" });
    if (!after.ok) {
      return {
        ok: false,
        cause: "checksum",
        error: `the speech weights do not match their pin (${[...after.missing, ...after.wrongSize, ...after.wrongDigest].join(", ")})`,
        dir: plan.dir,
        plan,
      };
    }
  }
  return { ok: true, dir: plan.dir, downloaded: true, plan, repaired };
}

module.exports = {
  STT_REPOS,
  STT_FALLBACK_REPOS,
  STT_CATALOG,
  sttPlan,
  voiceModelsOnDisk,
  downloadTarget,
  weightsReady,
  installedSizes,
  nearestInstalled,
  SIZE_ORDER,
  pinnedJobs,
  otherVoiceJobs,
  ensureSttWeights,
  auditStt,
  auditTts,
  pinChecks,
  TTS_REPO,
  HINDI_EAR_REPO,
  HINGLISH_EAR_REPO,
  HINDI_FALLBACK_REPO,
  EAR_MODELS,
};
