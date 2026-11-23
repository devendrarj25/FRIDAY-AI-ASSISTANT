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

/** The optional Hindi punctuation model in `<root>/models/hindi-punct` (see kernel/hindi_punct.py). */
const HINDI_PUNCT_REPO = "1-800-BAD-CODE/punct_cap_seg_47_language";

/** The optional light Hindi voice (CC-BY-4.0, credit in the Models row) in `<root>/models/hindi-light-tts`. */
const HINDI_LIGHT_REPO = "sulabhkatiyar/indic-tiny-tts-hindi";

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

/**
 * The two optional ONNX models that are not ears: the Hindi punctuation model (text, run on the Hindi ear's output)
 * and the light Hindi voice (a speaker, never the default). Kept apart from EAR_MODELS, which lists the speech
 * recognisers. Same rules: installed only when every pinned file is on disk, one Doctor pin row each.
 */
const EXTRA_MODELS = [
  {
    catalogId: "hindi-punct",
    repo: HINDI_PUNCT_REPO,
    rowId: "hindi-punct-pin",
    label: "Hindi punctuation model",
    kind: "stt",
  },
  {
    catalogId: "hindi-light-tts",
    repo: HINDI_LIGHT_REPO,
    rowId: "hindi-light-tts-pin",
    label: "Light Hindi voice",
    kind: "tts",
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
  for (const ear of [...EAR_MODELS, ...EXTRA_MODELS]) {
    if (earOnDisk(root, ear, check)) {
      found.push({
        catalogId: ear.catalogId,
        path: path.join(root, "models", ear.catalogId),
        kind: ear.kind || "stt",
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
  for (const ear of [...EAR_MODELS, ...EXTRA_MODELS]) {
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

/**
 * The voice language packs: named bundles of models that are already pinned above. Each pack installs in one action
 * from the Models page (`src/lib/friday/model-catalog.ts` `voicePacks` holds the labels, sizes and credits; a test
 * keeps the two member lists equal). The English ear is the one swappable member: `faster-whisper-small` on Auto,
 * the owner's locked size otherwise. Members are listed in the order they install.
 */
const VOICE_PACKS = [
  {
    id: "voice-pack-english",
    label: "English pack",
    members: [
      { id: "silero-vad" },
      { id: "smart-turn" },
      { id: "faster-whisper-small", swap: "english-ear" },
      { id: "supertonic-3" },
    ],
  },
  {
    id: "voice-pack-hindi",
    label: "Hindi pack",
    members: [
      { id: "hindi-ear" },
      { id: "hindi-punct" },
      { id: "hindi-light-tts" },
      { id: "supertonic-3" },
      { id: "hindi-fallback-ear" },
    ],
  },
  {
    id: "voice-pack-hinglish",
    label: "Hinglish pack",
    members: [
      { id: "hinglish-ear" },
      { id: "hindi-ear" },
      { id: "hindi-punct" },
      { id: "silero-vad" },
      { id: "smart-turn" },
      { id: "faster-whisper-small", swap: "english-ear" },
      { id: "supertonic-3" },
    ],
  },
];

/** The catalog ids of a pack, with the English ear resolved to `sttSize` (Auto or an unknown size means small). */
function packMemberIds(pack, sttSize) {
  const size = Object.prototype.hasOwnProperty.call(STT_CATALOG, String(sttSize))
    ? String(sttSize)
    : "small";
  return pack.members.map((member) =>
    member.swap === "english-ear" ? STT_CATALOG[size] : member.id,
  );
}

/** The catalog id a failed pin row belongs to, or "" for a row that is not a pack member. */
function catalogIdOfPinRow(rowId) {
  if (rowId === "tts-pin") return "supertonic-3";
  const ear = [...EAR_MODELS, ...EXTRA_MODELS].find((row) => row.rowId === rowId);
  if (ear) return ear.catalogId;
  const size = String(rowId).startsWith("stt-pin-") ? String(rowId).slice("stt-pin-".length) : "";
  return STT_CATALOG[size] || "";
}

/**
 * One Doctor row per voice language pack. A pack is optional, so a row is never required: it is green when every member
 * is on disk and matches its pin, and otherwise offers the pack's install button (the Models page installs what is
 * missing and fetches only the damaged files again). `pinRows` are the rows of `pinChecks`, passed in so a large file
 * is not hashed twice; without them the pins are checked here.
 */
async function packChecks(root, deps = {}) {
  const exists = deps.exists || (() => false);
  const onDisk = new Set(voiceModelsOnDisk(root, exists).map((row) => row.catalogId));
  const pinRows = deps.pinRows || (await pinChecks(root, { ...deps, exists }));
  const damaged = new Set(pinRows.filter((row) => !row.ok).map((row) => catalogIdOfPinRow(row.id)));
  return VOICE_PACKS.map((pack) => {
    const members = packMemberIds(pack, deps.sttSize);
    const missing = members.filter((id) => !onDisk.has(id));
    const bad = members.filter((id) => onDisk.has(id) && damaged.has(id));
    const none = missing.length === members.length;
    const ok = !missing.length && !bad.length;
    let detail;
    if (ok) detail = `all ${members.length} models are on disk and match their pins`;
    else if (none) detail = "not installed; optional, voice works without it";
    else {
      detail = [
        missing.length ? `partly installed, missing ${missing.join(", ")}` : "",
        bad.length
          ? `damaged: ${bad.join(", ")} (installing again fetches only the files that fail)`
          : "",
      ]
        .filter(Boolean)
        .join("; ");
    }
    return {
      id: pack.id,
      label: ok ? `${pack.label} is complete` : `${pack.label} (optional, not complete)`,
      ok,
      optional: true,
      required: false,
      installId: ok ? "" : pack.id,
      detail,
    };
  });
}

/* ---------------------------------------------------------------- registry and manifest
 * One list of every pinned voice model with the folder it lives in, so the manifest, the Doctor rows, the rollback and
 * the install plan all read the same table. `kind` is the Models-page kind: stt, tts or voice (a helper).
 */
function modelRegistry() {
  const rows = [];
  for (const size of SIZE_ORDER) {
    rows.push({
      catalogId: STT_CATALOG[size],
      kind: "stt",
      repo: STT_REPOS[size],
      dir: ["cache", "stt", size],
      label: `Speech ${size}`,
    });
  }
  for (const ear of [...EAR_MODELS, ...EXTRA_MODELS]) {
    rows.push({
      catalogId: ear.catalogId,
      kind: ear.kind || "stt",
      repo: ear.repo,
      dir: ["models", ear.catalogId],
      label: ear.label,
    });
  }
  rows.push({
    catalogId: "supertonic-3",
    kind: "tts",
    repo: TTS_REPO,
    dir: ["models", "supertonic-3"],
    label: "Neural voice",
  });
  for (const row of PINNED) {
    rows.push({
      catalogId: row.id,
      kind: "voice",
      repo: null,
      file: row.file,
      bytes: row.bytes,
      dir: [...row.dir],
      label: row.id === "silero-vad" ? "Silero VAD" : "Smart Turn",
    });
  }
  return rows;
}

/** The manifest of one model by catalog id: the pinned facts with `diskBytes` from the pinned bytes; null if unknown. */
function manifestOf(catalogId) {
  const row = modelRegistry().find((item) => item.catalogId === catalogId);
  if (!row) return null;
  if (row.repo) {
    const facts = pins.manifestFor(row.repo);
    return facts ? { catalogId, kind: row.kind, ...facts } : null;
  }
  const facts = pins.FILE_FACTS[catalogId];
  return facts ? { catalogId, kind: row.kind, repo: null, diskBytes: row.bytes, ...facts } : null;
}

/** Where a model lives under a FRIDAY root (the folder, or the single file for a helper). */
function modelPath(root, catalogId) {
  const row = modelRegistry().find((item) => item.catalogId === catalogId);
  if (!row || !root) return "";
  const dir = path.join(root, ...row.dir);
  return row.file ? path.join(dir, row.file) : dir;
}

/** The pinned models that are folders (not the two single-file helpers), with their pin. */
function folderModels() {
  return modelRegistry().filter((row) => row.repo && pins.pinForRepo(row.repo));
}

/** Put the previous verified revision of a model back (the Doctor repair for a revision that fails to verify or load). */
function restoreModel(root, catalogId) {
  const row = modelRegistry().find((item) => item.catalogId === catalogId);
  if (!row) return { ok: false, revision: "", error: `unknown voice model: ${catalogId}` };
  if (!row.repo || !root) {
    return {
      ok: false,
      revision: "",
      error: "this model is a single file; there is no previous revision to restore",
    };
  }
  return pins.rollbackToPrevious(modelPath(root, catalogId));
}

/**
 * Doctor rows about the model folders themselves, from the same registry as the pin rows:
 *   · `extras-<id>`: the folder holds files the pin does not list; installing again moves them to quarantine;
 *   · `rollback-<id>`: a previous verified revision is kept as `<folder>.prev`. Green while the current revision is
 *     healthy, red (with `rollbackId`) when its pin row fails or the caller reports it did not load (`loadFailed`).
 * With `adopt`, a folder whose hashed pin row passed gets the verification marker, which is what lets the next pinned
 * revision keep this one as `.prev`. `pinRows` are the rows of `pinChecks`; a clean folder yields no row.
 */
async function folderChecks(root, deps = {}) {
  const exists = deps.exists || (() => false);
  if (!root) return [];
  const pinRows = deps.pinRows || (await pinChecks(root, { ...deps, exists }));
  const failing = new Set([
    ...pinRows.filter((row) => !row.ok).map((row) => catalogIdOfPinRow(row.id)),
    ...(deps.loadFailed || []),
  ]);
  const passing = new Set(pinRows.filter((row) => row.ok).map((row) => catalogIdOfPinRow(row.id)));
  const rows = [];
  for (const row of folderModels()) {
    const dir = path.join(root, ...row.dir);
    const pin = pins.pinForRepo(row.repo);
    if (!exists(dir)) continue;
    const onDisk = voiceModelsOnDisk(root, exists).some(
      (found) => found.catalogId === row.catalogId,
    );
    if (onDisk && deps.adopt && passing.has(row.catalogId) && !pins.readMarker(dir)) {
      pins.writeMarker(dir, row.repo, pin);
    }
    if (onDisk) {
      const extras = pins.unexpectedFiles(dir, pin, deps.list ? { list: deps.list } : {});
      if (extras.length) {
        rows.push({
          id: `extras-${row.catalogId}`,
          label: `${row.label} holds only its pinned files`,
          ok: false,
          optional: true,
          required: false,
          installId: row.catalogId,
          detail: `${extras.length} unexpected file(s): ${extras.slice(0, 5).join(", ")}${extras.length > 5 ? ", ..." : ""} (installing again moves them to quarantine)`,
        });
      }
    }
    const prev = pins.previousInfo(dir);
    if (prev.exists) {
      const bad = failing.has(row.catalogId);
      const at = prev.revision ? prev.revision.slice(0, 8) : "unknown";
      rows.push({
        id: `rollback-${row.catalogId}`,
        label: bad
          ? `${row.label}: restore the previous verified revision`
          : `${row.label} keeps its previous verified revision`,
        ok: !bad,
        optional: true,
        required: false,
        rollbackId: row.catalogId,
        detail: bad
          ? `the pinned revision fails verification or load; restore revision ${at} (${Math.round(prev.bytes / 1024 ** 2)} MB kept)`
          : `revision ${at} (${Math.round(prev.bytes / 1024 ** 2)} MB) is kept beside the current one; it can be discarded to free disk`,
      });
    }
  }
  return rows;
}

/* ---------------------------------------------------------------- the 16 GB budget
 * The owner's memory policy for a 16 GB PC: Windows, Electron and FRIDAY keep about 4 to 6 GB, active speech uses 2 to
 * 4 GB, and 1 to 2 GB stay free. The low end of each range applies to an 8 GB PC and the high end from 16 GB. Speech
 * never gets more than 4 GB of RAM, and only one recogniser and one voice are resident (`maxResidentModels`).
 * A GPU counts only when the kernel's own runtime check (kernel/stt.py cuda_runtime_ready: cuBLAS 12 and cuDNN 9 found)
 * has passed, and FRIDAY never downloads CUDA libraries from anyone else. `src/lib/friday/voice-engine/hardware-profile.ts`
 * `budgetFor` is the same table for the Models page; core/__tests__/voice-hardware-budget.test.ts keeps them equal.
 */
const SPEECH_CAP_GB = 4;
/** Video memory kept free beside speech (the screen, the desktop, the resident model's growth). */
const GPU_HEADROOM_GB = 1;
/** The resident memory a speech size needs with the voice and the two helpers loaded beside it (from the manifest). */
function residentNeedGb(size) {
  const gbOf = (id) => manifestOf(id)?.minRamGb || 0;
  return round1(
    gbOf(STT_CATALOG[size]) + gbOf("supertonic-3") + gbOf("silero-vad") + gbOf("smart-turn"),
  );
}
const LANGUAGE_PACKS = ["voice-pack-english", "voice-pack-hindi", "voice-pack-hinglish"];
const IDLE_UNLOAD_MS = { lite: 180_000, balanced: 600_000, quality: 900_000 };

const round1 = (value) => Math.round(value * 10) / 10;

function budgetFor(totalRamGb, freeRamGb, vramGb, gpuInfo = {}, options = {}) {
  const notes = [];
  let total = Number(totalRamGb);
  if (!(total > 0)) {
    total = 8;
    notes.push("the memory of this PC is unknown, so it is treated as an 8 GB PC");
  }
  const freeKnown = Number.isFinite(Number(freeRamGb)) && Number(freeRamGb) > 0;
  const free = freeKnown ? Math.min(Number(freeRamGb), total) : Infinity;
  if (!freeKnown) notes.push("free memory is unknown; only the total is used");
  const cpuThreads = Math.max(1, Math.floor(Number(options.cpuThreads) || 4));
  // 8 GB uses the low end of the owner's ranges, 16 GB and up the high end.
  const t = Math.min(1, Math.max(0, (total - 8) / 8));
  const baselineGb = 4 + 2 * t;
  const headroomGb = 1 + t;
  const byTotal = Math.max(0, total - baselineGb - headroomGb);
  const byFree = free === Infinity ? Infinity : Math.max(0, free - headroomGb);
  const speechBudgetGb = round1(Math.min(SPEECH_CAP_GB, byTotal, byFree));
  const need = residentNeedGb;
  notes.push(
    `memory policy: about ${round1(baselineGb)} GB for Windows, Electron and FRIDAY, up to ${SPEECH_CAP_GB} GB for speech (${speechBudgetGb} GB here), ${round1(headroomGb)} GB kept free`,
  );

  const vram =
    Number(vramGb) > 0 ? Number(vramGb) : Number(gpuInfo?.vramGb) > 0 ? Number(gpuInfo.vramGb) : 0;
  // `cudaRuntimeReady` is the KERNEL's verdict (cuBLAS 12 and cuDNN 9 found) and is the only thing that picks a GPU size.
  // `cudaDriverReady` (the NVIDIA driver can run CUDA 12) alone only offers an upgrade the installer and Doctor can show.
  const verified = gpuInfo?.cudaRuntimeReady === true;
  const driverOnly =
    !verified && gpuInfo?.cudaDriverReady === true && (vram > 0 || !!gpuInfo?.name);
  // Video memory speech may really use: the measured free amount when a probe gave one, otherwise the total less the
  // model the caller expects to keep resident (`llmResidentVramGb`), then a fixed headroom. No GPU-name matching.
  const freeVramKnown =
    gpuInfo?.vramFreeGb !== undefined &&
    gpuInfo?.vramFreeGb !== null &&
    Number.isFinite(Number(gpuInfo.vramFreeGb)) &&
    Number(gpuInfo.vramFreeGb) >= 0;
  const plannedLlmGb = Math.max(0, Number(options.llmResidentVramGb) || 0);
  const offeredVram = freeVramKnown
    ? Math.min(vram, Number(gpuInfo.vramFreeGb))
    : vram - plannedLlmGb;
  const usableVram = vram > 0 ? Math.max(0, round1(offeredVram - GPU_HEADROOM_GB)) : 0;
  const weakCpu = options.cpuClass === "low";
  let device = "cpu";
  let size;
  if (verified && usableVram >= 3 && total >= 16 && byFree >= 4) {
    device = "cuda";
    size = usableVram >= 7 ? "large-v3-turbo" : "medium";
  } else {
    if (speechBudgetGb >= need("small")) size = "small";
    else if (total >= 4 && !(freeKnown && byFree < 0.9)) size = "base";
    else size = "tiny";
    if (verified && usableVram >= 2) device = "cuda";
    if (device === "cpu" && weakCpu && size === "small") {
      size = "base";
      notes.push(
        "a low-end processor listens with base, which keeps the reply inside the latency budget",
      );
    }
  }
  if (!verified && (vram > 0 || gpuInfo?.name)) {
    notes.push(
      `${gpuInfo?.name || "a GPU"} was found but the CUDA 12 libraries (cuBLAS 12, cuDNN 9) are not verified, so speech stays on the CPU in int8; FRIDAY never downloads CUDA libraries from third parties`,
    );
    if (driverOnly) {
      notes.push(
        "the NVIDIA driver can run CUDA 12 programs, so installing the CUDA runtime libraries would let the GPU carry speech",
      );
    }
  } else if (device === "cuda") {
    notes.push(
      `GPU speech: the CUDA 12 libraries are verified and ${vram} GB of video memory is present`,
    );
  } else if (verified) {
    notes.push(
      `the GPU has ${vram} GB of video memory (${usableVram} GB usable beside what is already resident), too little for speech, so it stays on the CPU`,
    );
  }
  if (device === "cpu") {
    notes.push(
      `CPU only: ${size} int8 is the primary ear; medium, large-v3-turbo and large-v3 are never loaded automatically (they need a verified GPU and 16 GB); choose one in Settings to load it yourself`,
    );
  }
  if (freeKnown && byFree < byTotal && byFree < SPEECH_CAP_GB) {
    notes.push(
      `free memory is low (${round1(free)} GB free), so the speech budget was lowered to ${speechBudgetGb} GB`,
    );
  }

  const ladder = ["tiny", "base", "small", "medium", "large-v3-turbo"];
  const allowedSizes = ladder.slice(0, ladder.indexOf(size) + 1);
  const profile =
    device === "cuda" && size !== "small" ? "quality" : size === "small" ? "balanced" : "lite";
  const ear = STT_CATALOG[size];
  const hindiPunct = size !== "tiny" && profile !== "lite";
  // What a fresh setup fetches (the rest of each pack stays optional, on demand): the helpers, the primary ear, the
  // voice, and the Hindi ear (with its punctuation model when the budget is not the lite one).
  const wanted = [
    "silero-vad",
    "smart-turn",
    ear,
    "supertonic-3",
    "hindi-ear",
    ...(hindiPunct ? ["hindi-punct"] : []),
  ];
  const install = wanted.filter((id, at) => wanted.indexOf(id) === at);
  const packs = VOICE_PACKS.filter((pack) => LANGUAGE_PACKS.includes(pack.id)).map((pack) => {
    const members = packMemberIds(pack, size);
    return {
      id: pack.id,
      install: members.filter((id) => install.includes(id)),
      optional: members.filter((id) => !install.includes(id)),
      skipped: [],
    };
  });
  return {
    profile,
    sttSize: size,
    sttDevice: device,
    sttCompute: device === "cuda" ? "float16" : "int8",
    ttsEngine: "supertonic",
    packs,
    install,
    allowedSizes,
    maxResidentModels: 2,
    idleUnloadMs: IDLE_UNLOAD_MS[profile],
    threads: Math.min(cpuThreads, Math.max(4, Math.min(8, Math.floor(cpuThreads / 2)))),
    speechBudgetGb,
    notes,
    // The driver is ready but the runtime libraries are not verified: the CPU default above stays, and this is what the
    // installer and Doctor show. It never says CUDA works.
    ...(driverOnly
      ? {
          gpuUpgrade: {
            needs: "cuda-runtime",
            vramGb: round1(vram),
            detail: `${gpuInfo?.name || "GPU"} found; install the CUDA runtime libraries (cuBLAS 12, cuDNN 9) to use it for speech`,
          },
        }
      : {}),
  };
}

function defaultNvidiaSmi() {
  return require("child_process").execFileSync(
    "nvidia-smi",
    ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
    { timeout: 4000, windowsHide: true, encoding: "utf8" },
  );
}

/** The most video memory a card may claim when its reading came only from `AdapterRAM`: a 32-bit number that wraps or clips. */
const ADAPTER_RAM_CAP_GB = 4;

/**
 * What the shared hardware reader (`deps.hardwareFacts`, see electron/hardware.cjs) found, or null when it is absent,
 * throws or answers asynchronously: the probe then keeps today's nvidia-smi-only read, so nothing breaks.
 */
function readFacts(deps) {
  if (typeof deps.hardwareFacts !== "function") return null;
  try {
    const facts = deps.hardwareFacts();
    return facts && typeof facts === "object" && typeof facts.then !== "function" ? facts : null;
  } catch {
    return null;
  }
}

const positive = (value) => (Number(value) > 0 ? Number(value) : 0);

/**
 * What this PC has, from Node's own `os` (memory, processors), the answer Electron's `app.getGPUInfo("basic")` already
 * gave (pass it as `gpuInfo`), `nvidia-smi` for the video memory, and the shared detected facts (`deps.hardwareFacts`)
 * when given. Video memory is the largest trusted reading of the probes; when the chosen GPU row says its reading was
 * clipped (`gpus[].vramCapped === true`) it is never trusted above 4 GB. `cudaRuntimeReady` is true only when the caller
 * passes the kernel's own verdict (`deps.cudaRuntimeReady`: cuBLAS 12 and cuDNN 9 found). The facts' `cudaReady` is the
 * NVIDIA driver only and becomes `cudaDriverReady`, which never picks a GPU size. No GPU-name guess. No new package.
 */
function probeHardware(deps = {}) {
  const host = deps.os || require("os");
  const gb = (bytes) => round1(Number(bytes) / 1024 ** 3);
  const facts = readFacts(deps);
  const gpu = {
    name: "",
    vramGb: 0,
    vramFreeGb: undefined,
    source: "none",
    cudaRuntimeReady: deps.cudaRuntimeReady === true,
    cudaDriverReady: facts?.cudaReady === true,
  };
  const devices = Array.isArray(deps.gpuInfo?.gpuDevice) ? deps.gpuInfo.gpuDevice : [];
  const device = devices.find((row) => row?.active) || devices[0];
  if (device?.deviceString) {
    gpu.name = String(device.deviceString);
    gpu.source = "electron";
  }
  if (facts) {
    const sources = Array.isArray(facts.sources) ? facts.sources.map(String) : [];
    const rows = Array.isArray(facts.gpus)
      ? facts.gpus.filter((row) => row && typeof row === "object")
      : [];
    const chosen = rows.find((row) => facts.gpuName && row.name === facts.gpuName) || rows[0];
    let factsVram = positive(facts.vramGb);
    if (chosen?.vramCapped === true) factsVram = Math.min(factsVram, ADAPTER_RAM_CAP_GB);
    if (factsVram > 0) {
      gpu.vramGb = round1(factsVram);
      gpu.source = sources.length ? sources.join("+") : "facts";
    }
    if (
      facts.vramFreeGb !== undefined &&
      facts.vramFreeGb !== null &&
      Number(facts.vramFreeGb) >= 0
    ) {
      gpu.vramFreeGb = round1(Number(facts.vramFreeGb));
    }
    if (!gpu.name && facts.gpuName) gpu.name = String(facts.gpuName);
  }
  try {
    const first = String((deps.nvidiaSmi || defaultNvidiaSmi)() || "")
      .split(/\r?\n/)
      .find((line) => line.trim());
    if (first) {
      const at = first.lastIndexOf(",");
      const mib = Number(first.slice(at + 1));
      if (at > 0 && mib > 0) {
        gpu.name = first.slice(0, at).trim();
        const smiGb = Math.round(mib / 1024);
        if (smiGb >= gpu.vramGb) {
          gpu.vramGb = smiGb;
          gpu.source = "nvidia-smi";
        }
      }
    }
  } catch {
    /* no NVIDIA driver on this PC: the GPU stays unused */
  }
  if (gpu.vramFreeGb === undefined) delete gpu.vramFreeGb;
  else gpu.vramFreeGb = Math.min(gpu.vramFreeGb, gpu.vramGb || gpu.vramFreeGb);
  const totalRamGb = positive(gb(host.totalmem())) || positive(facts?.ramGb);
  const freeRamGb = positive(gb(host.freemem())) || positive(facts?.ramFreeGb);
  return {
    totalRamGb,
    freeRamGb,
    cpuThreads: host.cpus().length,
    platform: host.platform(),
    ...(typeof facts?.cpuClass === "string" && facts.cpuClass ? { cpuClass: facts.cpuClass } : {}),
    gpu,
  };
}

/** The budget of this PC, in one call for setup, Doctor and the Models page. */
function budgetForProbe(probe, options = {}) {
  return budgetFor(probe.totalRamGb, probe.freeRamGb, probe.gpu.vramGb, probe.gpu, {
    cpuThreads: probe.cpuThreads,
    ...(probe.cpuClass ? { cpuClass: probe.cpuClass } : {}),
    ...options,
  });
}

const mb = (bytes) => `${Math.round(bytes / 1024 ** 2)} MB`;

/**
 * What a fresh setup does about the voice on THIS PC, from the probe: which pinned models are fetched, which are already
 * on disk, which are skipped and why, and what stays optional on demand. Pure: `deps.exists` and `deps.statfs` stand in
 * for the disk, so a test needs no hardware. The essentials (the two helpers, the primary ear, the voice) are always
 * planned; the optional ones (the Hindi ear and punctuation) are skipped, with the reason, when the RAM budget or the
 * disk (1.3 times the bytes) cannot carry them. `lines` is the text setup and `--dry-run` print.
 */
function voiceInstallPlan(root, probe, deps = {}) {
  const exists = deps.exists || (() => false);
  const budget = budgetForProbe(
    probe,
    Number(deps.llmResidentVramGb) > 0 ? { llmResidentVramGb: Number(deps.llmResidentVramGb) } : {},
  );
  const onDisk = new Set(voiceModelsOnDisk(root, exists).map((row) => row.catalogId));
  const essential = new Set([
    "silero-vad",
    "smart-turn",
    STT_CATALOG[budget.sttSize],
    "supertonic-3",
  ]);
  const items = [];
  let planned = 0;
  for (const id of budget.install) {
    const facts = manifestOf(id);
    const item = { id, kind: facts.kind, bytes: facts.diskBytes, state: "download", reason: "" };
    if (onDisk.has(id)) item.state = "on-disk";
    else if (!essential.has(id) && facts.minRamGb > budget.speechBudgetGb) {
      item.state = "skipped";
      item.reason = `not enough RAM: needs ${facts.minRamGb} GB, the speech budget here is ${budget.speechBudgetGb} GB`;
    } else if (!essential.has(id)) {
      const room = pins.diskPreflight(
        root,
        planned + facts.diskBytes,
        deps.statfs ? { statfs: deps.statfs } : {},
      );
      if (!room.ok) {
        item.state = "skipped";
        item.reason = room.error;
      }
    }
    if (item.state === "download") planned += item.bytes;
    items.push(item);
  }
  const blocked = SIZE_ORDER.filter((size) => !budget.allowedSizes.includes(size)).map((size) => ({
    id: size,
    size,
    reason:
      size === "small" || size === "base"
        ? `needs about ${manifestOf(STT_CATALOG[size]).minRamGb} GB of RAM for the ear alone, the speech budget here is ${budget.speechBudgetGb} GB`
        : "not auto-loaded here: it needs a verified GPU (cuBLAS 12, cuDNN 9) and 16 GB of RAM; install it from the Models page",
  }));
  const packed = new Set(budget.install);
  const optional = [
    ...new Set(budget.packs.flatMap((pack) => pack.optional).filter((id) => !packed.has(id))),
  ];
  const gpu = probe.gpu?.name
    ? `${probe.gpu.name}${probe.gpu.vramGb ? `, ${probe.gpu.vramGb} GB` : ""}${budget.sttDevice === "cuda" ? "" : ", not used"}`
    : "no usable GPU";
  const lines = [
    `[friday] INFO     voice profile: ${budget.profile} (${probe.totalRamGb} GB RAM, ${probe.freeRamGb} GB free, ${gpu}): ${budget.sttSize} ${budget.sttCompute} on the ${budget.sttDevice === "cuda" ? "GPU" : "CPU"}, up to ${budget.speechBudgetGb} GB of RAM for speech`,
    ...budget.notes.map((note) => `[friday] INFO     ${note}`),
    ...(budget.gpuUpgrade ? [`[friday] INFO     ${budget.gpuUpgrade.detail}`] : []),
  ];
  for (const item of items) {
    if (item.state === "on-disk")
      lines.push(`[friday] ok       ${item.id} already on disk (${mb(item.bytes)})`);
    else if (item.state === "download")
      lines.push(`[friday] INFO     ${item.id} will be fetched (${mb(item.bytes)})`);
    else lines.push(`[friday] INFO     ${item.id} skipped: ${item.reason}`);
  }
  for (const row of blocked) {
    row.line = `[friday] INFO     ${row.id} skipped: ${row.reason}`;
    lines.push(row.line);
  }
  if (optional.length) {
    lines.push(
      `[friday] INFO     optional, on demand from the Models page: ${optional.join(", ")}`,
    );
  }
  return {
    probe,
    budget,
    items,
    blocked,
    optional,
    downloadBytes: planned,
    lines,
  };
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
  packChecks,
  VOICE_PACKS,
  modelRegistry,
  folderChecks,
  restoreModel,
  manifestOf,
  modelPath,
  budgetFor,
  budgetForProbe,
  voiceInstallPlan,
  probeHardware,
  TTS_REPO,
  HINDI_EAR_REPO,
  HINGLISH_EAR_REPO,
  HINDI_FALLBACK_REPO,
  HINDI_PUNCT_REPO,
  HINDI_LIGHT_REPO,
  EAR_MODELS,
  EXTRA_MODELS,
};
