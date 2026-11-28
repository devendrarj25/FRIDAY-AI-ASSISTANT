/**
 * Voice weights are fetched here, then the worker opens the folder.
 * The worker does not download. Every speech size and the neural voice are pinned by revision and
 * SHA-256 in `voice-pins.cjs`; the downloader enforces the pin and a repair removes only a bad file.
 */
const fs = require("fs");
const path = require("path");
const pins = require("./voice-pins.cjs");
const localSources = require("./local-sources.cjs");

const STT_REPOS = {
  tiny: "Systran/faster-whisper-tiny",
  base: "Systran/faster-whisper-base",
  small: "Systran/faster-whisper-small",
  medium: "Systran/faster-whisper-medium",
  "large-v3": "Systran/faster-whisper-large-v3",
  // The turbo size, named `large-v3-turbo` by the speech engine. Close to large-v3 in size of vocabulary with far less decoding work.
  "large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
};

/**
 * Where a size is fetched from if its first repository stops answering. The turbo repository was renamed
 * from `mobiuslabsgmbh` to `dropbox-dash` (Hugging Face redirects the old name today, checked 2026-11-09), so the
 * new name is the second source: the same files, used only when the first fails.
 */
const STT_FALLBACK_REPOS = {
  "large-v3-turbo": ["dropbox-dash/faster-whisper-large-v3-turbo"],
};

/** The neural voice repository; its folder is `<root>/models/supertonic-3`. */
const TTS_REPO = "Supertone/supertonic-3";

/**
 * The publisher's own archive of the same model (a one-commit duplicate on Hugging Face, linked from the voice
 * code repository): the second source for the neural voice. Same files, same SHA-256 (`voice-pins.cjs` MIRROR_REPOS).
 */
const TTS_ARCHIVE_REPO = "supertone-oss-archive/supertonic-3";

/** FRIDAY's Hindi ear: the Hindi int8 ONNX, in `<root>/models/hindi-ear` (see kernel/hindi_ear.py). */
const HINDI_EAR_REPO = "OpenVoiceOS/ai4bharat-indicconformer-hi-onnx";

/** The optional Hinglish ear (Roman letters, faster-whisper CT2) in `<root>/models/hinglish-ear` (see kernel/whisper_ears.py). */
const HINGLISH_EAR_REPO = "MSpider3/whisper-hindi2hinglish-swift-ct2";

/** The optional Hindi fallback (CT2) in `<root>/models/hindi-fallback-ear`. */
const HINDI_FALLBACK_REPO = "collabora/faster-whisper-small-hindi";

/** The optional Hindi punctuation model in `<root>/models/hindi-punct` (see kernel/hindi_punct.py). */
const HINDI_PUNCT_REPO = "1-800-BAD-CODE/punct_cap_seg_47_language";

/** The optional light Hindi voice in `<root>/models/hindi-light-tts`. */
const HINDI_LIGHT_REPO = "sulabhkatiyar/indic-tiny-tts-hindi";

/** The optional streaming denoiser (FRIDAY Denoise) in `<root>/models/denoise-dpdfnet`; off by default, never fetched on its own. */
const DENOISE_REPO = "Ceva-IP/DPDFNet";

/** The optional tiny streaming denoiser (FRIDAY Denoise Lite) in `<root>/models/denoise-gtcrn`; off by default, never fetched on its own. */
const GTCRN_REPO = "TigreGotico/audiosronnx-gtcrn";

/** The optional speaker-verification candidate in `<root>/models/speaker-wespeaker`. */
const SPEAKER_REPO = "onnx-community/wespeaker-voxceleb-resnet34-LM";

/** The optional Hindi large-v3 fine-tune (a candidate, never a default) in `<root>/models/hindi-vaani-ear`. */
const HINDI_VAANI_REPO = "bjollans/whisper-large-v3-vaani-hindi-ct2";

/**
 * The optional Hinglish mixed-script ear (a large-v3 fine-tune, int8; a candidate, never a default, on demand only) in `<root>/models/hinglish-ear-trelis`. The model folder
 * is its `int8/` subfolder; it writes Hindi in Devanagari and English words in Latin letters, unlike `hinglish-ear`
 * (Roman letters only), which stays as it is.
 */
const HINGLISH_TRELIS_REPO = "nikh360pro/capsbro-hinglish-ct2";

/**
 * The optional streaming ear (FRIDAY Ear Live, ONNX int8, a candidate, never a default) in
 * `<root>/models/stream-ear-nemotron`. Setup and prefetch fetch it only when this PC's voice plan says so
 * (`streamEarDecision`: not the lite profile, not a low-end processor, its RAM inside the speech budget, the disk with
 * headroom, and never on a metered line, on battery or under heavy load); an installed verified copy is reused. The
 * Models page and the Install Manager fetch it on demand on any PC. FRIDAY's own onnxruntime loop
 * (kernel/transducer_loop.py) runs it.
 */
const STREAM_EAR_REPO = "soniqo/Nemotron-3.5-ASR-Streaming-Multilingual-0.6B-ONNX-INT8";

/**
 * The three optional final-pass ears (candidates, never defaults, on demand only; setup never fetches them) in
 * `<root>/models/<catalogId>`. FRIDAY Ear English (`parakeet-ear`, int8 ONNX, English) is run by `kernel/nemo_ear.py`;
 * FRIDAY Ear Swift (`shruti-ear`, ONNX, Hindi, Hinglish and Indian English; the model folder is its pinned `hi/onnx`
 * or `hi/onnx-int8` subfolder) by `kernel/shruti_ear.py`; FRIDAY Ear Quick (`moonshine-ear`, int8 ONNX, English) by
 * `kernel/ear_quick.py`. The Quick vocabulary is a second repository, so it is a second row (`moonshine-ear-vocab`)
 * that the Quick ear reads beside its graphs. Each falls back to the ear that works today when it is absent.
 */
const ENGLISH_EAR_REPO = "istupakov/parakeet-tdt-0.6b-v2-onnx";
const SWIFT_EAR_REPO = "udgamlabs/Shruti-ONNX";
const QUICK_EAR_REPO = "moonshine-ai/moonshine";
const QUICK_VOCAB_REPO = "moonshine-ai/moonshine-tiny";
/** The catalog id of the streaming ear (FRIDAY Ears' own streaming recogniser). */
const STREAM_EAR_ID = "stream-ear-nemotron";

/** What FRIDAY listens with while the streaming ear is absent: the ears it already has, turn by turn. */
const STREAM_EAR_FALLBACK = "the turn-by-turn ears (the speech model and the Hindi ear)";

/**
 * The language and sound models a fresh setup plans besides the essentials and the Hindi ear (`budgetFor` decides which
 * ones this PC gets, `voiceInstallPlan` the disk): each one is optional, so a failed fetch is a note that names what
 * stays in use, and the Doctor shows an absent one as missing but not required. Script policy stays as it is:
 *   · hinglish-ear writes Roman letters and is used only for the explicit Hindi-in-Roman mode (`hi-Latn`) today, never
 *     for Devanagari Hindi or English; it is small (78 MB) and goes on every profile, the lite one too;
 *   · hindi-fallback-ear is the Hindi Whisper copy kernel/whisper_ears.py falls back to when the Hindi ear is absent;
 *   · hindi-light-tts is the light Hindi voice (a second speaker, never the default);
 *   · denoise-gtcrn and denoise-dpdfnet are small streaming denoisers; they download and verify, and they are NOT wired
 *     to the live stream yet (kernel/denoise_onnx.py is an A/B tool only), so planning them claims no noise cleanup.
 */
const OPTIONAL_PLAN_FALLBACKS = {
  "hinglish-ear": "the Hindi ear and the speech model of today (Roman Hinglish is read by them)",
  "hindi-fallback-ear": "the Hindi ear and the speech model of today",
  "hindi-light-tts": "FRIDAY Voice (Supertonic) in Hindi",
  "denoise-gtcrn":
    "the noise handling that is built in (this denoiser is not wired to the live stream)",
  "denoise-dpdfnet":
    "the noise handling that is built in (this denoiser is not wired to the live stream)",
};

/**
 * Catalog ids a setup plan carries that stay optional: a failed fetch is a NOTE that names the fallback, never a FAIL,
 * and the Doctor shows the absent model as missing but not required: the streaming ear (off by default) and the models of OPTIONAL_PLAN_FALLBACKS.
 */
function isPlanOptional(catalogId) {
  return catalogId === STREAM_EAR_ID || Object.hasOwn(OPTIONAL_PLAN_FALLBACKS, String(catalogId));
}

/** The fallback named for an optional plan model, or "". */
function planFallback(catalogId) {
  if (catalogId === STREAM_EAR_ID) return STREAM_EAR_FALLBACK;
  return Object.hasOwn(OPTIONAL_PLAN_FALLBACKS, String(catalogId))
    ? OPTIONAL_PLAN_FALLBACKS[catalogId]
    : "";
}

/**
 * The optional ears that live in `<root>/models/<catalogId>`. Each is installed only when every pinned file is on
 * disk, and each gets one Doctor pin row. The Hindi ear is run by onnx-asr; the other two are faster-whisper folders.
 */
const EAR_MODELS = [
  {
    catalogId: "hindi-ear",
    repo: HINDI_EAR_REPO,
    rowId: "hindi-ear-pin",
    label: "FRIDAY Ear Hindi",
  },
  {
    catalogId: "hinglish-ear",
    repo: HINGLISH_EAR_REPO,
    rowId: "hinglish-ear-pin",
    label: "FRIDAY Ear Hinglish",
  },
  {
    catalogId: "hindi-fallback-ear",
    repo: HINDI_FALLBACK_REPO,
    rowId: "hindi-fallback-ear-pin",
    label: "FRIDAY Ear Hindi Backup",
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
    label: "FRIDAY Punctuate Hindi",
    kind: "stt",
  },
  {
    catalogId: "hindi-light-tts",
    repo: HINDI_LIGHT_REPO,
    rowId: "hindi-light-tts-pin",
    label: "FRIDAY Voice Lite",
    kind: "tts",
  },
  // The optional pins below with no live wrapper yet download and verify, and each has a self-test (`voice-pins.cjs`
  // SELF_TESTS), but the registry (`voice-engine-registry.ts`) keeps them "not usable" until a wrapper lands.
  {
    catalogId: "denoise-dpdfnet",
    repo: DENOISE_REPO,
    rowId: "denoise-dpdfnet-pin",
    label: "FRIDAY Denoise",
    kind: "voice",
  },
  {
    catalogId: "denoise-gtcrn",
    repo: GTCRN_REPO,
    rowId: "denoise-gtcrn-pin",
    label: "FRIDAY Denoise Lite",
    kind: "voice",
  },
  {
    catalogId: "speaker-wespeaker",
    repo: SPEAKER_REPO,
    rowId: "speaker-wespeaker-pin",
    label: "FRIDAY Speaker",
    kind: "voice",
  },
  {
    catalogId: "hindi-vaani-ear",
    repo: HINDI_VAANI_REPO,
    rowId: "hindi-vaani-ear-pin",
    label: "FRIDAY Ear Hindi Large (candidate)",
    kind: "stt",
  },
  {
    catalogId: "stream-ear-nemotron",
    repo: STREAM_EAR_REPO,
    rowId: "stream-ear-nemotron-pin",
    label: "FRIDAY Ear Live (candidate)",
    kind: "stt",
  },
  {
    catalogId: "hinglish-ear-trelis",
    repo: HINGLISH_TRELIS_REPO,
    rowId: "hinglish-ear-trelis-pin",
    label: "FRIDAY Ear Hinglish Large (candidate)",
    kind: "stt",
  },
  {
    catalogId: "parakeet-ear",
    repo: ENGLISH_EAR_REPO,
    rowId: "parakeet-ear-pin",
    label: "FRIDAY Ear English",
    kind: "stt",
  },
  {
    catalogId: "shruti-ear",
    repo: SWIFT_EAR_REPO,
    rowId: "shruti-ear-pin",
    label: "FRIDAY Ear Swift",
    kind: "stt",
  },
  {
    catalogId: "moonshine-ear",
    repo: QUICK_EAR_REPO,
    rowId: "moonshine-ear-pin",
    label: "FRIDAY Ear Quick",
    kind: "stt",
  },
  {
    catalogId: "moonshine-ear-vocab",
    repo: QUICK_VOCAB_REPO,
    rowId: "moonshine-ear-vocab-pin",
    label: "FRIDAY Ear Quick Vocabulary",
    kind: "stt",
  },
];

/**
 * FRIDAY Ear Hinglish Pro (`hinglish-ear-pro`): the pin is Oriserve's BF16 SOURCE checkpoint (1.6 GB), not a runnable
 * folder. The folder that runs (`<root>/models/hinglish-ear-pro`) is FRIDAY's own CTranslate2 int8 conversion of it
 * (820 MB; `scripts/build-friday-models.cjs`, recipe `ct2-int8`), held in the FRIDAY release as the assets of
 * `config/friday-models.json` with their hashes pinned. So this ear is NOT in EXTRA_MODELS (every row there is installed
 * from its pinned Hugging Face files): its registry row has `repo: null`, nothing in the setup, the prefetch or the
 * Install Manager can fetch the source, and its install state, plan and pin check below all read the release assets.
 * `needs` is what faster-whisper opens; `kernel/stt.py` HINGLISH_PRO routes it for Roman Hinglish turns.
 */
const HINGLISH_PRO_REPO = "Oriserve/Whisper-Hindi2Hinglish-Apex";
const DERIVED_EARS = [
  {
    catalogId: "hinglish-ear-pro",
    fridayId: "friday-ear-hinglish-pro",
    repo: HINGLISH_PRO_REPO,
    rowId: "hinglish-ear-pro-pin",
    label: "FRIDAY Ear Hinglish Pro",
    kind: "stt",
    needs: [
      "model.bin",
      "config.json",
      "tokenizer.json",
      "vocabulary.json",
      "preprocessor_config.json",
    ],
    fallback: "the Hinglish ear and the speech model of today",
  },
];
const NEEDS_RELEASE = "needs the FRIDAY release (not published yet)";

/** True when every file the pin lists is in the ear's folder. */
function earOnDisk(root, ear, exists) {
  const dir = path.join(root, "models", ear.catalogId);
  const pin = pins.pinForRepo(ear.repo);
  return Boolean(pin) && Object.keys(pin.files).every((name) => exists(path.join(dir, name)));
}

const STT_FILES = ["config.json", "model.bin", "tokenizer.json", "vocabulary.txt"];

/**
 * The two single-file helpers. Every URL names an immutable revision (a Hugging Face commit, or a release tag as the
 * secondary), never a branch: a `master`, `main` or `latest` URL moves, and a moved file fails its SHA-256 (setup
 * once stopped on `silero-vad source failed (official release): checksum mismatch` for exactly that reason). `sources`
 * is the ordered list the downloader walks: a source whose bytes differ from `sha256` is refused and the next one is
 * tried. `url` is the first source. Both helpers are `optional`: FRIDAY listens and ends a turn without them (`fallback`).
 * Hashes and sizes were read from the Hugging Face API (`?blobs=true`, lfs.sha256) and by hashing the downloaded files, 2026-11-24.
 */
const SILERO_SHA256 = "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3";
const SILERO_BYTES = 2327524;
const SMART_TURN_SHA256 = "2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f";
const SMART_TURN_BYTES = 8679182;

const WAKE_EMBED_FILE = "wake-embed.onnx";
const WAKE_EMBED_SHA256 = "70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f";
const WAKE_EMBED_BYTES = 1326578;

const PINNED = [
  {
    id: "smart-turn",
    file: "smart-turn-v3.2-cpu.onnx",
    sha256: SMART_TURN_SHA256,
    bytes: SMART_TURN_BYTES,
    dir: ["models", "smart-turn"],
    license: "BSD-2-Clause",
    firewallClass: "local",
    optional: true,
    fallback: "the pause timer alone (Smart Turn can only lengthen a pause)",
    sources: [
      {
        kind: "url",
        // pipecat-ai/smart-turn-v3 commit "Smart Turn v3.2" (BSD-2-Clause).
        url: "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/f766f81d3cfdf7737ac64aad813d91bbfd56bf93/smart-turn-v3.2-cpu.onnx",
        sha256: SMART_TURN_SHA256,
        bytes: SMART_TURN_BYTES,
        label: "Hugging Face (pipecat-ai, pinned commit)",
      },
      {
        // The same file on ModelScope (hashed 2026-11-28, equal to the pin); `Revision=master` moves, the SHA-256 decides.
        kind: "url",
        url: "https://modelscope.cn/api/v1/models/pipecat-ai/smart-turn-v3/repo?Revision=master&FilePath=smart-turn-v3.2-cpu.onnx",
        sha256: SMART_TURN_SHA256,
        bytes: SMART_TURN_BYTES,
        label: "ModelScope (same SHA-256)",
      },
    ],
  },
  {
    id: "silero-vad",
    file: "silero_vad.onnx",
    sha256: SILERO_SHA256,
    bytes: SILERO_BYTES,
    dir: ["models", "silero-vad"],
    license: "MIT",
    firewallClass: "local",
    optional: true,
    fallback: "the energy VAD",
    sources: [
      {
        kind: "url",
        // istupakov/silero-vad-onnx (MIT) at a fixed commit; the same bytes as snakers4/silero-vad v6.2.1.
        url: "https://huggingface.co/istupakov/silero-vad-onnx/resolve/b3e3ee3cce4c11ceb63b1a0b229d916069c1ddf6/silero_vad.onnx",
        sha256: SILERO_SHA256,
        bytes: SILERO_BYTES,
        label: "Hugging Face (istupakov, pinned commit)",
      },
      {
        kind: "url",
        // Secondary only: the upstream release tag. Its file is checked against the same SHA-256, so a moved tag is refused.
        url: "https://raw.githubusercontent.com/snakers4/silero-vad/v6.2.1/src/silero_vad/data/silero_vad.onnx",
        sha256: SILERO_SHA256,
        bytes: SILERO_BYTES,
        label: "GitHub snakers4/silero-vad v6.2.1 (secondary)",
      },
    ],
  },
  {
    id: "wake-embed",
    file: WAKE_EMBED_FILE,
    sha256: WAKE_EMBED_SHA256,
    bytes: WAKE_EMBED_BYTES,
    dir: ["models", "wake"],
    license: "Apache-2.0",
    firewallClass: "local",
    optional: true,
    fallback: "the bundled wake scorer",
    sources: [
      {
        kind: "url",
        // The speech embedding model of the wake head, from the v0.5.1 release assets; `fileName` is the
        // name FRIDAY's wake engine opens it by (`kernel/wake_word.py` EMBED_MODEL_NAME), not the release's own.
        url: "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/embedding_model.onnx",
        fileName: WAKE_EMBED_FILE,
        sha256: WAKE_EMBED_SHA256,
        bytes: WAKE_EMBED_BYTES,
        label: "GitHub release v0.5.1 (fixed tag)",
      },
    ],
  },
].map((row) => ({ ...row, url: row.sources[0].url }));

/** Models-page label of each single-file helper. */
const HELPER_LABELS = {
  "silero-vad": "FRIDAY Listen Gate",
  "smart-turn": "FRIDAY Turn",
  "wake-embed": "Wake word embedding",
};

/**
 * Internal catalog metadata on every registered voice model (`modelRegistry`, `manifestOf`, the installer catalog):
 * `license` is the pinned source's licence id and `firewallClass` says where the weights run. "local" means the model
 * runs inside the kernel on this PC, so microphone audio never leaves it. The manifest test fails on an empty value.
 */
const FIREWALL_CLASSES = ["local"];

/**
 * What the Smart Turn helper must do before the Doctor may call it loaded: the same onnx-signature self-test the other
 * optional pins use (`kernel/voice_pin_selftest.py`). Read from the pinned file with onnxruntime 1.29 on 2026-11-26: one
 * float input `input_features` [B, 80, 800] (eight seconds of 80 mel bins) and one output `logits` [B, 1].
 */
const SMART_TURN_SELF_TEST = {
  kind: "onnx-signature",
  file: "smart-turn-v3.2-cpu.onnx",
  inputs: [{ name: "input_features", shape: ["B", 80, 800], type: "float32", run: [1, 80, 800] }],
  outputs: [{ name: "logits", shape: ["B", 1] }],
};

/** True for a helper FRIDAY can run without (its `fallback` engine takes over); a failed fetch is then a note, not a failure. */
function isOptionalHelper(id) {
  return PINNED.some((row) => row.id === String(id || "") && row.optional === true);
}

function helperFallback(id) {
  return PINNED.find((row) => row.id === String(id || ""))?.fallback || "";
}

/**
 * The opt-in mirror (`config/download-hosts.json` `optInHosts`). It is only another road to the same bytes: the file
 * is checked against the same SHA-256 and size, so a wrong mirror is refused and the next source is tried. The
 * downloader refuses the host unless `FRIDAY_HF_MIRROR=1`, so it is added to a plan only when the owner allows it.
 */
const HF_MIRROR_HOST = "hf-mirror.com";
const HF_RESOLVE = /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/([0-9a-f]{40})\/(.+)$/;

/**
 * `sources` plus, last, the mirror copy of every immutable Hugging Face url (a commit in the path, never a branch)
 * when `env.FRIDAY_HF_MIRROR` is "1". Any other source, and every source without the switch, is returned as it was.
 */
function withOptInMirrors(sources, env) {
  const list = Array.isArray(sources) ? sources : [];
  if (String(env?.FRIDAY_HF_MIRROR || "") !== "1") return list;
  const mirrors = [];
  for (const source of list) {
    const found = source?.kind === "url" ? HF_RESOLVE.exec(String(source.url || "")) : null;
    if (!found) continue;
    mirrors.push({
      ...source,
      url: `https://${HF_MIRROR_HOST}/${found[1]}/resolve/${found[2]}/${found[3]}`,
      label: `${HF_MIRROR_HOST} (opt-in mirror, same SHA-256)`,
    });
  }
  return [...list, ...mirrors];
}

/**
 * The FRIDAY Models release (`config/friday-models.json`, built by `scripts/build-friday-models.cjs`): the same pinned
 * files, hosted as release assets of the official repository. A pinned model that the manifest holds in full is fetched
 * from there FIRST (a file over `partBytes` as several parts that are joined), every file is checked against the
 * manifest SHA-256 and size, and the official upstream pin source is the fallback on a 404, a network error or a wrong
 * hash. A model with no complete manifest entry has no release source, so its chain is exactly what it was.
 */
const RELEASE_LABEL = "FRIDAY release";
/** A model copied from a build this PC made (a `friday-bundle.json` folder), tried before the release. */
const LOCAL_LABEL = localSources.LOCAL_LABEL;
const OFFICIAL_LABEL = "official source";
const RELEASE_REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const RELEASE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RELEASE_TAG = /^friday-(?:voice-weights|models)-\d{4}\.\d{1,2}\.\d{1,3}$/;
const DEFAULT_PART_BYTES = 1_900_000_000;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SOURCE_NOTE = ".source.json";

/** The parsed pack manifest, or null when it is missing or not a friday-models pack. `deps.fridayModels` is injected by tests. */
function readFridayModels(deps = {}) {
  let pack = deps.fridayModels;
  if (pack === undefined) {
    try {
      pack = require("./resource-paths.cjs").readConfigJson("friday-models.json", null).value;
    } catch {
      pack = null;
    }
  }
  const sound =
    pack &&
    pack.pack === "friday-models" &&
    RELEASE_REPOSITORY.test(String(pack.repository || "")) &&
    Array.isArray(pack.assets);
  if (!sound) return null;
  // The voice pack (`packs[]` id voice-weights) names the tag and revision this reader uses; the top-level fields
  // (the old friday-models-<rev> tag) are the fallback, so an older manifest keeps working.
  const voice = (Array.isArray(pack.packs) ? pack.packs : []).find(
    (item) => item?.id === "voice-weights",
  );
  const own = voice && RELEASE_TAG.test(String(voice.tag || ""));
  const tag = own ? voice.tag : pack.tag;
  if (!RELEASE_TAG.test(String(tag || ""))) return null;
  return own ? { ...pack, tag, revision: voice.revision || pack.revision } : pack;
}

/** `<file>.part001` when a file is split, the plain name when it is not (the same names the builder writes). */
function releasePartName(file, index, count) {
  return count <= 1 ? file : `${file}.part${String(index + 1).padStart(3, "0")}`;
}

/**
 * The release plan of one pinned repository, or null. It exists only when the manifest holds EVERY pinned file of the
 * repository as a `copy` asset with the pin's own SHA-256 and size and a part count that follows from its bytes; one
 * missing or different file means no release source at all. `FRIDAY_MODELS_RELEASE=0` switches the release road off.
 * Returns `{ repo, tag, revision, files: [{ name, file, sha256, bytes, parts: [{ file, url, bytes }] }] }`.
 */
function fridayReleasePlan(repo, deps = {}) {
  const env = deps.env || process.env;
  if (String(env?.FRIDAY_MODELS_RELEASE || "") === "0") return null;
  const pack = readFridayModels(deps);
  const pin = (deps.pinForRepo || pins.pinForRepo)(repo);
  if (!pack || !pin) return null;
  const partBytes =
    Number.isInteger(pack.partBytes) && pack.partBytes > 0 ? pack.partBytes : DEFAULT_PART_BYTES;
  const base = `https://github.com/${pack.repository}/releases/download/${pack.tag}/`;
  const sameModel = (asset) =>
    asset?.from?.pin === repo || (deps.pinForRepo || pins.pinForRepo)(asset?.from?.pin) === pin;
  const files = [];
  for (const [name, row] of Object.entries(pin.files)) {
    const asset = (pack.assets || []).find(
      (item) => sameModel(item) && item.path === name && item.from?.recipe === "copy",
    );
    if (
      !asset ||
      !RELEASE_FILE.test(String(asset.file || "")) ||
      !SHA256_HEX.test(String(asset.sha256 || "")) ||
      asset.sha256 !== String(row.sha256 || "").toLowerCase() ||
      asset.bytes !== row.bytes ||
      !Number.isInteger(asset.bytes) ||
      asset.bytes < 0
    ) {
      return null;
    }
    const count = Math.max(1, Math.ceil(asset.bytes / partBytes));
    if (asset.parts !== count) return null;
    const parts = [];
    for (let index = 0; index < count; index += 1) {
      const file = releasePartName(asset.file, index, count);
      parts.push({
        file,
        url: base + encodeURIComponent(file),
        bytes: Math.min(partBytes, asset.bytes - index * partBytes),
      });
    }
    files.push({ name, file: asset.file, sha256: asset.sha256, bytes: asset.bytes, parts });
  }
  return files.length ? { repo, tag: pack.tag, revision: pack.revision, files } : null;
}

/** The derived ear of a catalog id, or undefined. */
function derivedEar(catalogId) {
  return DERIVED_EARS.find((row) => row.catalogId === catalogId);
}

/**
 * The release plan of a derived ear (see DERIVED_EARS): every asset of the pack that FRIDAY built from the ear's source
 * pin, under the file name the folder holds, with the hash and size the manifest pins. A copied file must equal the
 * source pin's own SHA-256 and size; a converted file must carry its derived hash as its own. One missing, malformed or
 * different file, or a folder without a file the runtime opens, means no plan at all (the source is never the road).
 * Returns `{ catalogId, repo, tag, revision, bytes, files: [{ name, file, sha256, bytes, parts: [...] }] }` or null.
 */
function derivedEarPlan(catalogId, deps = {}) {
  const ear = derivedEar(catalogId);
  if (!ear) return null;
  const env = deps.env || process.env;
  if (String(env?.FRIDAY_MODELS_RELEASE || "") === "0") return null;
  const pack = readFridayModels(deps);
  const pin = (deps.pinForRepo || pins.pinForRepo)(ear.repo);
  if (!pack || !pin) return null;
  const partBytes =
    Number.isInteger(pack.partBytes) && pack.partBytes > 0 ? pack.partBytes : DEFAULT_PART_BYTES;
  const base = `https://github.com/${pack.repository}/releases/download/${pack.tag}/`;
  const files = [];
  const seen = new Set();
  for (const asset of pack.assets) {
    if (asset?.fridayId !== ear.fridayId || asset?.from?.pin !== ear.repo) continue;
    const name = String(asset.path || "");
    const source = Object.prototype.hasOwnProperty.call(pin.files, String(asset.from.file || ""))
      ? pin.files[asset.from.file]
      : null;
    const sound =
      RELEASE_FILE.test(name) &&
      !seen.has(name) &&
      RELEASE_FILE.test(String(asset.file || "")) &&
      SHA256_HEX.test(String(asset.sha256 || "")) &&
      Number.isInteger(asset.bytes) &&
      asset.bytes > 0 &&
      Boolean(source) &&
      (asset.from.recipe === "copy"
        ? asset.sha256 === String(source.sha256 || "").toLowerCase() && asset.bytes === source.bytes
        : asset.from.recipe === "ct2-int8" && asset.from.derivedSha256 === asset.sha256);
    if (!sound) return null;
    const count = Math.max(1, Math.ceil(asset.bytes / partBytes));
    if (asset.parts !== count) return null;
    seen.add(name);
    const parts = [];
    for (let index = 0; index < count; index += 1) {
      const file = releasePartName(asset.file, index, count);
      parts.push({
        file,
        url: base + encodeURIComponent(file),
        bytes: Math.min(partBytes, asset.bytes - index * partBytes),
      });
    }
    files.push({ name, file: asset.file, sha256: asset.sha256, bytes: asset.bytes, parts });
  }
  if (!ear.needs.every((name) => seen.has(name))) return null;
  const bytes = files.reduce((total, file) => total + file.bytes, 0);
  return { catalogId, repo: ear.repo, tag: pack.tag, revision: pin.revision, bytes, files };
}

/** A pin-shaped record of the folder a derived ear installs (its files, not the source's): what the audit and the marker read. */
function derivedEarPin(catalogId, deps = {}) {
  const plan = derivedEarPlan(catalogId, deps);
  if (!plan) return null;
  const source = (deps.pinForRepo || pins.pinForRepo)(plan.repo);
  return {
    revision: plan.revision,
    license: source?.license || "",
    files: Object.fromEntries(
      plan.files.map((file) => [file.name, { sha256: file.sha256, bytes: file.bytes }]),
    ),
  };
}

/** True when every file of the derived ear's plan is in its folder (a cheap look; the audit checks sizes and hashes). */
function derivedOnDisk(root, ear, exists, deps = {}) {
  const plan = derivedEarPlan(ear.catalogId, deps);
  const dir = path.join(root, "models", ear.catalogId);
  return Boolean(plan) && plan.files.every((file) => exists(path.join(dir, file.name)));
}

/**
 * The install state of a derived ear, for the Install Manager and the Doctor: `installed` (every file on disk),
 * `release` (not on disk; the FRIDAY release holds the converted files, so that is the only source) or `needs-release`
 * (the pack does not hold them yet: nothing is fetched, and the text says so instead of reaching for the source).
 */
function derivedEarState(root, catalogId, deps = {}) {
  const ear = derivedEar(catalogId);
  if (!ear) return null;
  const plan = derivedEarPlan(catalogId, deps);
  if (!plan)
    return { catalogId, state: "needs-release", plan: null, sources: [], text: NEEDS_RELEASE };
  const installed = Boolean(root) && derivedOnDisk(root, ear, deps.exists || (() => false), deps);
  return {
    catalogId,
    state: installed ? "installed" : "release",
    plan,
    sources: installed ? [] : derivedEarSources(catalogId, deps),
    text: installed
      ? "installed from the FRIDAY release files"
      : "installs from the FRIDAY release only; the 1.6 GB source checkpoint is never fetched",
  };
}

/** The ordered download sources of a derived ear: the FRIDAY release alone, or none while the release has no files. */
function derivedEarSources(catalogId, deps = {}) {
  const plan = derivedEarPlan(catalogId, deps);
  if (!plan) return [];
  return [
    {
      kind: "friday-release",
      repo: plan.repo,
      label: RELEASE_LABEL,
      derived: true,
      catalogId,
      plan,
    },
  ];
}

/**
 * The local-bundle source of one pinned repository, or null. It exists only when `deps.localBundles` (from
 * `local-sources.discoverLocalBundles`) holds a bundle that serves `deps.modelId` with exactly the pinned files
 * (`planLocalModel`: the config pin wins, so a bundle hash that differs means no source). `plan` is the release plan of
 * the same repository when there is one, so a local pack can serve its part files too.
 */
function localBundleSource(repo, plan, deps = {}) {
  if (!Array.isArray(deps.localBundles) || !deps.localBundles.length || !deps.modelId) return null;
  const pin = (deps.pinForRepo || pins.pinForRepo)(repo);
  if (!pin?.files) return null;
  const local = localSources.planLocalModel({
    bundles: deps.localBundles,
    installRoot: deps.installRoot,
    modelId: deps.modelId,
    pinFiles: Object.entries(pin.files).map(([name, row]) => ({
      path: name,
      bytes: row.bytes,
      sha256: row.sha256,
    })),
    releasePlan: plan,
    // The copy holds every file to the pinned SHA-256 while it streams (model-download), so no multi-GB hash blocks here.
    deep: deps.localDeep === true,
    ...(deps.localFs ? { fs: deps.localFs } : {}),
  });
  return local ? { kind: "local-bundle", repo, label: LOCAL_LABEL, plan: local } : null;
}

/**
 * `sources` with, before every pinned Hugging Face repository the pack holds in full, the FRIDAY release source, and
 * before that the local-bundle source when a build on this PC holds the same pinned files. Any other source, and a
 * repository neither holds, is returned as it was, in the same order.
 */
function withFridayRelease(sources, deps = {}) {
  const list = Array.isArray(sources) ? sources : [];
  const out = [];
  for (const source of list) {
    // The source checkpoint of a derived ear is 1.6 GB of BF16 weights FRIDAY never installs: its release files are the road.
    if (source?.kind === "hf-repo" && DERIVED_EARS.some((ear) => ear.repo === source.repo))
      continue;
    if (
      source?.kind === "hf-repo" &&
      source.repo &&
      !list.some((s) => s?.kind === "friday-release" && s.repo === source.repo)
    ) {
      const plan = fridayReleasePlan(source.repo, deps);
      if (!list.some((s) => s?.kind === "local-bundle" && s.repo === source.repo)) {
        const local = localBundleSource(source.repo, plan, deps);
        if (local) out.push(local);
      }
      if (plan) out.push({ kind: "friday-release", repo: source.repo, label: RELEASE_LABEL, plan });
    }
    out.push(source);
  }
  return out;
}

/**
 * `sources` with, last, the ModelScope copy (`modelscopeSource`) of every pinned Hugging Face repository it holds, once
 * per repository and never when the list already carries that url-set. The copy is checked against the same pinned
 * SHA-256 and size, so it is only another road to the same bytes. Any other source and any other repository is
 * returned as it was. It is separate from `withFridayRelease` on purpose: that chain ends with the official source.
 */
function withModelscopeRoad(sources) {
  const list = Array.isArray(sources) ? sources : [];
  const mirrors = [];
  for (const source of list) {
    if (source?.kind !== "hf-repo" || !source.repo) continue;
    if (list.some((s) => s?.kind === "url-set" && s.repo === source.repo)) continue;
    if (mirrors.some((s) => s.repo === source.repo)) continue;
    const held = modelscopeSource(source.repo);
    if (held) mirrors.push(held);
  }
  return mirrors.length ? [...list, ...mirrors] : list;
}

/** The file that says which source served a model folder (`<folder>.source.json`, beside the folder, so the pin never sees it). */
function sourceNotePath(dir) {
  return `${dir}${SOURCE_NOTE}`;
}

/** "local build", "FRIDAY release" or "official source" for the pinned revision on disk; "" when unknown (an older install, another revision). */
function servedSource(dir, pin) {
  try {
    const note = JSON.parse(fs.readFileSync(sourceNotePath(dir), "utf8"));
    const known =
      note?.source === RELEASE_LABEL ||
      note?.source === OFFICIAL_LABEL ||
      note?.source === LOCAL_LABEL;
    return known && (!pin || note.pinRevision === pin.revision) ? note.source : "";
  } catch {
    return "";
  }
}

/** ", installed from <source>" for a Doctor detail, or "" when the source is not known. */
function servedNote(dir, pin) {
  const source = servedSource(dir, pin);
  return source ? `; installed from ${source}` : "";
}

/**
 * One line for a failed helper download: every source that was tried and why it failed, so a moved file on the first
 * source and a second failure are both visible. `result` is what `model-download.cjs` `downloadModel` returned.
 */
function pinnedFailureLine(id, result = {}) {
  const attempts = Array.isArray(result?.attempts) ? result.attempts : [];
  const tried = attempts.map((a) => `${a.source}: ${a.error}`).join("; ");
  const why = tried || String(result?.error || "no source answered");
  const tail = isOptionalHelper(id)
    ? `; optional, ${helperFallback(id) || "a built-in engine"} stays in use`
    : isPlanOptional(id)
      ? `; optional, setup goes on and ${planFallback(id)} stay in use`
      : "";
  return `${id} did not download (${why})${tail}`;
}

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

/**
 * A second road to the same pinned weights: ModelScope holds copies of the five Systran faster-whisper repositories under
 * the same names (tiny, base, small, medium, large-v3). All 21 pinned files were compared on 2026-11-28 against the
 * pins: the SHA-256 and byte count ModelScope lists for each equal the pin, and a download of three files was hashed
 * here and matched. The same day every file of Supertone/supertonic-3 (17), onnx-community/wespeaker-voxceleb-resnet34-LM
 * (3) and the turbo speech model (5, under its old publisher name) was downloaded from ModelScope and hashed: all equal the pin. The mirror is NOT part of `sttPlan().sources` (the first road stays Hugging Face, exactly as it
 * was); `sttSourcesWithMirror` is the one place that adds it, behind Hugging Face, and moves it first only when the
 * Doctor reach probe says Hugging Face is down. A file is accepted only when it matches the pinned SHA-256 and size,
 * so a wrong or moved mirror file is refused like any other source. `Revision=master` is a moving name on purpose:
 * the pin, not the name, decides.
 */
const MODELSCOPE_HOST = "modelscope.cn";
const MODELSCOPE_FAMILY = "modelscope";
const MODELSCOPE_LABEL = "ModelScope (same SHA-256)";
const HUGGING_FACE_HOST = "huggingface.co";
const MODELSCOPE_REPOS = new Set([
  ...["tiny", "base", "small", "medium", "large-v3"].map((size) => STT_REPOS[size]),
  "Supertone/supertonic-3",
  "onnx-community/wespeaker-voxceleb-resnet34-LM",
  // The turbo pin is the renamed repository; ModelScope still holds it under the first publisher name.
  "dropbox-dash/faster-whisper-large-v3-turbo",
]);
/**
 * A pinned repository whose ModelScope copy has another name. Only the url is built from the mapped name: the files,
 * hashes and sizes are always the pin's own. The turbo plan's first repository is the old name itself, which is not
 * in `MODELSCOPE_REPOS`, so the speech plan keeps its two Hugging Face sources and only a source that carries the
 * renamed repository (the Install Manager's turbo row) gets this road. Silero VAD has no entry on purpose: the file
 * ModelScope holds has the pinned size and other bytes.
 */
const MODELSCOPE_REPO_MAP = {
  "dropbox-dash/faster-whisper-large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
};

/**
 * The ModelScope copy of a pinned repository as one source: `{ kind: "url-set", host, family, label, repo, files }`,
 * each file a `kind: "url"` source (`url`, `sha256`, `bytes`, `relPath`) taken from the pin. Null for a repository
 * ModelScope does not hold in a verified copy.
 */
function modelscopeSource(repo) {
  const pin = pins.pinForRepo(repo);
  if (!pin || !MODELSCOPE_REPOS.has(repo)) return null;
  return {
    kind: "url-set",
    host: MODELSCOPE_HOST,
    family: MODELSCOPE_FAMILY,
    label: MODELSCOPE_LABEL,
    repo,
    files: Object.entries(pin.files).map(([file, row]) => ({
      kind: "url",
      url: `https://${MODELSCOPE_HOST}/api/v1/models/${MODELSCOPE_REPO_MAP[repo] || repo}/repo?Revision=master&FilePath=${encodeURIComponent(file)}`,
      sha256: row.sha256,
      bytes: row.bytes,
      relPath: file,
      label: MODELSCOPE_LABEL,
    })),
  };
}

/**
 * The ordered sources of one speech size with the mirror: Hugging Face (`sttPlan().sources`) first, ModelScope behind it.
 * `reach` is the Doctor reach map (`{ "<host>": { state: "up" | "down" | "unchecked" } }`, scripts/doctor-probes.cjs):
 * a host reported down goes last and everything else keeps its order, nothing is dropped, an unchecked host counts as up.
 * A size with no verified mirror returns the plan's own sources.
 */
function sttSourcesWithMirror(model, reach = {}) {
  const own = sttPlan(model, "").sources;
  const mirror = modelscopeSource(STT_REPOS[sttSize(model)]);
  const list = mirror ? [...own, mirror] : own;
  const hostOf = (source) => source.host || HUGGING_FACE_HOST;
  const down = (source) => reach?.[hostOf(source)]?.state === "down";
  return [...list.filter((source) => !down(source)), ...list.filter(down)];
}

/**
 * Fetches a `url-set` source into `dir`: every file missing or of the wrong size, one by one through the downloader
 * (which checks the pinned SHA-256 and size), then the whole folder is hashed against the pin and the pin record is
 * written, so the folder is the pinned model like any other. A failure leaves the files that passed and returns
 * `{ ok: false, error }`; it never throws. `deps.downloadUrl`, `deps.sizeOf` and `deps.pinForRepo` stand in for the network, the disk and the pin table in a test.
 */
async function downloadMirrorSet(source, dir, deps = {}) {
  const pin = (deps.pinForRepo || pins.pinForRepo)(source?.repo);
  if (!pin || source?.kind !== "url-set" || !Array.isArray(source.files))
    return { ok: false, error: "not a known mirror set" };
  const fetchOne = deps.downloadUrl || require("./model-download.cjs").downloadUrl;
  const statSize = deps.sizeOf || ((file) => (fs.existsSync(file) ? fs.statSync(file).size : -1));
  try {
    for (const file of source.files) {
      const pinned = pin.files[file.relPath];
      if (!pinned || pinned.sha256 !== file.sha256 || pinned.bytes !== file.bytes)
        throw new Error(`${file.relPath} does not match the pin`);
      const dest = path.join(dir, file.relPath);
      if (statSize(dest) === file.bytes) continue;
      await fetchOne(file.url, dest, {
        sha256: file.sha256,
        needBytes: file.bytes,
        label: source.label,
        ...(deps.onEvent ? { onEvent: deps.onEvent } : {}),
        ...(deps.signal ? { signal: deps.signal } : {}),
      });
    }
    const audit = await pins.auditDir(dir, pin, { hash: true });
    if (!audit.ok) {
      pins.removeBad(dir, audit);
      throw new Error(
        `checksum mismatch: ${[...audit.missing, ...audit.wrongSize, ...audit.wrongDigest].join(", ")}`,
      );
    }
    pins.writeMarker(dir, source.repo, pin);
    return { ok: true, via: "url-set", source: source.label, path: dir };
  } catch (error) {
    return { ok: false, source: source.label, error: String(error?.message || error) };
  }
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
  return PINNED.map((row) => ({
    ...row,
    dir: [...row.dir],
    sources: row.sources.map((source) => ({ ...source })),
    // What the prefetch or a repair prints when `downloadModel` fails for this helper: every source and why.
    failureLine: (result) => pinnedFailureLine(row.id, result),
  }));
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
  for (const ear of DERIVED_EARS) {
    if (derivedOnDisk(root, ear, check)) {
      found.push({
        catalogId: ear.catalogId,
        path: path.join(root, "models", ear.catalogId),
        kind: ear.kind,
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
      label: `FRIDAY Ear ${size} matches its pin`,
      ok: audit.ok,
      detail:
        describe(audit) +
        (audit.ok
          ? servedNote(path.join(root, "cache", "stt", size), pins.pinForRepo(STT_REPOS[size]))
          : ""),
    });
  }
  for (const ear of [...EAR_MODELS, ...EXTRA_MODELS]) {
    // A row appears only when the ear is installed (every pinned file present). A short or tampered file is red.
    if (!earOnDisk(root, ear, exists)) continue;
    const earDir = path.join(root, "models", ear.catalogId);
    const earPin = pins.pinForRepo(ear.repo);
    const audit = await pins.auditDir(earDir, earPin, deps);
    rows.push({
      id: ear.rowId,
      label: `${ear.label} matches its pin`,
      ok: audit.ok,
      detail: describe(audit) + (audit.ok ? servedNote(earDir, earPin) : ""),
    });
  }
  for (const ear of DERIVED_EARS) {
    // The derived ear is checked against its release files, never against the source pin it was converted from.
    if (!derivedOnDisk(root, ear, exists, deps)) continue;
    const earDir = path.join(root, "models", ear.catalogId);
    const audit = await pins.auditDir(earDir, derivedEarPin(ear.catalogId, deps), deps);
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
      label: "FRIDAY Voice matches its pin",
      ok: tts.ok,
      detail: describe(tts) + (tts.ok ? servedNote(tts.dir, pins.pinForRepo(TTS_REPO)) : ""),
    });
  }
  rows.push(...helperPinChecks(root, { ...deps, exists }));
  return rows;
}

/**
 * One `<id>-pin` row per installed single-file helper (Silero VAD, Smart Turn, the wake embedding): the file is the
 * pinned size, and with `hash` its SHA-256 matches too. The helpers are optional, so a row is never required and a
 * red one carries the helper's own install id, which fetches the pinned file again. `fileSize` and `hashFile` are
 * injectable for a test.
 */
function helperPinChecks(root, deps = {}) {
  const exists = deps.exists || (() => false);
  const sizeOf = deps.fileSize || ((file) => fs.statSync(file).size);
  const hashOf = deps.hashFile || pins.sha256FileSync;
  const rows = [];
  for (const row of PINNED) {
    const file = path.join(root || "", ...row.dir, row.file);
    if (!root || !exists(file)) continue;
    let problem = "";
    try {
      if (sizeOf(file) !== row.bytes) problem = `${row.file} wrong size`;
      else if (deps.hash && hashOf(file) !== row.sha256) problem = `${row.file} fails SHA-256`;
    } catch (error) {
      problem = `${row.file} cannot be read (${String(error?.message || error).slice(0, 80)})`;
    }
    const label = HELPER_LABELS[row.id] || row.id;
    rows.push({
      id: `${row.id}-pin`,
      label: `${label} matches its pin`,
      ok: !problem,
      optional: true,
      required: false,
      ...(problem ? { installId: row.id } : {}),
      detail: problem || `${row.file} matches the pinned size${deps.hash ? " and SHA-256" : ""}`,
    });
  }
  return rows;
}

/**
 * The Smart Turn Doctor row that opens the file. The kernel check only says "file present"; this runs the pinned
 * signature self-test (`runSelfTest({ dir, spec })`, the same runner the optional pins use) so a truncated, wrong or
 * unreadable file is red. Null when the file is not in its registered folder (the kernel's own row stays). A thrown
 * or missing runner is red, never a silent pass.
 */
async function smartTurnLoadCheck(root, deps = {}) {
  const exists = deps.exists || (() => false);
  const row = PINNED.find((item) => item.id === "smart-turn");
  const dir = path.join(root || "", ...row.dir);
  if (!root || !exists(path.join(dir, row.file))) return null;
  let result;
  try {
    result = deps.runSelfTest
      ? await deps.runSelfTest({ catalogId: row.id, dir, spec: SMART_TURN_SELF_TEST })
      : { ok: false, reason: "no-runner", detail: "the self-test runner is not available" };
  } catch (error) {
    result = { ok: false, reason: "run-failed", detail: String(error?.message || error) };
  }
  const ok = Boolean(result?.ok);
  return {
    id: row.id,
    label: ok ? "FRIDAY Turn loads and runs" : "FRIDAY Turn does not load",
    ok,
    optional: true,
    required: false,
    ...(ok ? {} : { installId: row.id }),
    detail: ok
      ? String(result.detail || "opens and ran one pass")
      : [result?.reason, result?.detail].filter(Boolean).join(": ") || "the file did not open",
  };
}

/**
 * Doctor rows for the optional pins that have a self-test (`voice-pins.cjs` SELF_TESTS): one "optional, not installed"
 * row with the install button when the folder is not whole, and one `selftest-<id>` row when it is. `runSelfTest`
 * ({ catalogId, dir, spec }) returns { ok, reason, detail }; the Doctor passes the kernel runner, a test passes a fake.
 * The rows are never required: the voice works without every one of these engines. An engine with no live wrapper
 * says so in its green row, so a pass never reads as "in use".
 */
async function pinSelfTests(root, deps = {}) {
  const exists = deps.exists || (() => false);
  const rows = [];
  for (const row of EXTRA_MODELS) {
    const spec = pins.SELF_TESTS[row.repo];
    if (!spec) continue;
    if (!root || !earOnDisk(root, row, exists)) {
      rows.push({
        id: `optional-${row.catalogId}`,
        label: `${row.label} (optional, not installed)`,
        ok: true,
        optional: true,
        required: false,
        installId: row.catalogId,
        detail: "not installed; optional, voice works without it",
      });
      continue;
    }
    let result;
    try {
      result = deps.runSelfTest
        ? await deps.runSelfTest({
            catalogId: row.catalogId,
            dir: path.join(root, "models", row.catalogId),
            spec,
          })
        : { ok: false, reason: "no-runner", detail: "the self-test runner is not available" };
    } catch (error) {
      result = { ok: false, reason: "run-failed", detail: String(error?.message || error) };
    }
    const ok = Boolean(result?.ok);
    if (ok && result.blocked) {
      // Nothing is wrong with the files, and a repair would fetch the same files again: say what is missing, offer no button.
      rows.push({
        id: `selftest-${row.catalogId}`,
        label: `${row.label} self-test (blocked)`,
        ok: true,
        blocked: true,
        required: false,
        installId: "",
        detail: `blocked: ${String(result.detail || result.reason || "a companion file is missing").slice(0, 200)}; no repair applies`,
      });
      continue;
    }
    rows.push({
      id: `selftest-${row.catalogId}`,
      label: `${row.label} self-test`,
      ok,
      required: false,
      installId: ok ? "" : row.catalogId,
      detail: ok
        ? `${String(result.detail || "passed")}${spec.wrapper ? "" : "; no live wrapper runs it yet, so it is not used"}`
        : `${String(result?.reason || "failed")}: ${String(result?.detail || "").slice(0, 200)}`,
    });
  }
  for (const ear of DERIVED_EARS) {
    const state = derivedEarState(root, ear.catalogId, { ...deps, exists });
    if (state.state !== "installed") {
      // No button: the Install Manager reaches a model through its pinned repository, and this ear's only source is
      // the converted files of the FRIDAY release; the text says which of the two is missing.
      const waiting = state.state === "needs-release";
      rows.push({
        id: `optional-${ear.catalogId}`,
        label: `${ear.label} (optional, not installed)`,
        ok: true,
        optional: true,
        required: false,
        installId: "",
        detail: waiting
          ? `${state.text}; optional, ${ear.fallback} keep hearing Roman Hinglish`
          : `not installed; optional, voice works without it (${state.text})`,
      });
      continue;
    }
    let result;
    try {
      result = deps.runSelfTest
        ? await deps.runSelfTest({
            catalogId: ear.catalogId,
            dir: path.join(root, "models", ear.catalogId),
            spec: { kind: "ct2-folder", wrapper: "kernel/stt.py", needs: [...ear.needs] },
          })
        : { ok: false, reason: "no-runner", detail: "the self-test runner is not available" };
    } catch (error) {
      result = { ok: false, reason: "run-failed", detail: String(error?.message || error) };
    }
    const ok = Boolean(result?.ok);
    rows.push({
      id: `selftest-${ear.catalogId}`,
      label: `${ear.label} self-test`,
      ok,
      required: false,
      installId: "",
      detail: ok
        ? String(result.detail || "passed")
        : `${String(result?.reason || "failed")}: ${String(result?.detail || "").slice(0, 200)}`,
    });
  }
  return rows;
}

/**
 * The voice language packs: named bundles of models that are already pinned above. Each pack installs in one action
 * from the Models page (`src/lib/friday/model-catalog.ts` `voicePacks` holds the labels, and sizes; a test
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
  const ear = [...EAR_MODELS, ...EXTRA_MODELS, ...DERIVED_EARS].find((row) => row.rowId === rowId);
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
function licenceOf(repo) {
  return String(pins.pinForRepo(repo)?.license || "");
}

function modelRegistry() {
  const rows = [];
  for (const size of SIZE_ORDER) {
    rows.push({
      catalogId: STT_CATALOG[size],
      kind: "stt",
      repo: STT_REPOS[size],
      dir: ["cache", "stt", size],
      label: `FRIDAY Ear ${size}`,
      license: licenceOf(STT_REPOS[size]),
      firewallClass: "local",
    });
  }
  for (const ear of [...EAR_MODELS, ...EXTRA_MODELS]) {
    rows.push({
      catalogId: ear.catalogId,
      kind: ear.kind || "stt",
      repo: ear.repo,
      dir: ["models", ear.catalogId],
      label: ear.label,
      license: licenceOf(ear.repo),
      firewallClass: "local",
    });
  }
  for (const ear of DERIVED_EARS) {
    // `repo` stays null on purpose: every consumer that fetches by `repo` (the prefetch, the Install Manager chain)
    // would otherwise reach for the 1.6 GB source checkpoint. `derivedFrom` names it for the facts.
    rows.push({
      catalogId: ear.catalogId,
      kind: ear.kind,
      repo: null,
      derivedFrom: ear.repo,
      dir: ["models", ear.catalogId],
      label: ear.label,
      license: licenceOf(ear.repo),
      firewallClass: "local",
    });
  }
  rows.push({
    catalogId: "supertonic-3",
    kind: "tts",
    repo: TTS_REPO,
    dir: ["models", "supertonic-3"],
    label: "FRIDAY Voice",
    license: licenceOf(TTS_REPO),
    firewallClass: "local",
  });
  for (const row of PINNED) {
    rows.push({
      catalogId: row.id,
      kind: "voice",
      repo: null,
      file: row.file,
      bytes: row.bytes,
      dir: [...row.dir],
      label: HELPER_LABELS[row.id] || row.id,
      optional: row.optional === true,
      license: row.license,
      firewallClass: row.firewallClass,
    });
  }
  return rows;
}

/** The manifest of one model by catalog id: the pinned facts with `diskBytes` from the pinned bytes; null if unknown. */
function manifestOf(catalogId) {
  const row = modelRegistry().find((item) => item.catalogId === catalogId);
  if (!row) return null;
  if (row.derivedFrom) {
    // The memory and speed facts are the source pin's; the disk is what the release files weigh (the converted copy).
    const facts = pins.manifestFor(row.derivedFrom);
    const plan = derivedEarPlan(catalogId);
    return facts
      ? {
          catalogId,
          kind: row.kind,
          ...facts,
          repo: null,
          sourceRepo: row.derivedFrom,
          diskBytes: plan ? plan.bytes : facts.diskBytes,
          license: row.license,
          firewallClass: row.firewallClass,
        }
      : null;
  }
  if (row.repo) {
    const facts = pins.manifestFor(row.repo);
    return facts
      ? {
          catalogId,
          kind: row.kind,
          ...facts,
          license: row.license,
          firewallClass: row.firewallClass,
        }
      : null;
  }
  const facts = pins.FILE_FACTS[catalogId];
  return facts
    ? {
        catalogId,
        kind: row.kind,
        repo: null,
        diskBytes: row.bytes,
        ...facts,
        license: row.license,
        firewallClass: row.firewallClass,
      }
    : null;
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
  for (const ear of DERIVED_EARS) {
    // A derived ear whose hashed pin row passed gets the marker the kernel reads; without it the ear stays unused.
    const dir = path.join(root, "models", ear.catalogId);
    if (deps.adopt && passing.has(ear.catalogId) && !pins.readMarker(dir)) {
      pins.writeMarker(dir, ear.repo, derivedEarPin(ear.catalogId, deps));
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

/**
 * The optional models a fresh setup plans on this PC (see OPTIONAL_PLAN_FALLBACKS), smallest need first: the Roman
 * Hinglish ear on every profile, the Hindi Whisper backup when the speech budget carries it (the disk is checked by
 * `voiceInstallPlan`), the light Hindi voice from 8 GB of RAM, the two small denoisers on every profile but lite.
 * `hardware-profile.ts` `optionalPlanFor` is the same table.
 */
function optionalPlanFor(total, speechBudgetGb, profile) {
  const ids = ["hinglish-ear"];
  if (speechBudgetGb >= (manifestOf("hindi-fallback-ear")?.minRamGb ?? Infinity))
    ids.push("hindi-fallback-ear");
  if (total >= 8) ids.push("hindi-light-tts");
  if (profile !== "lite") ids.push("denoise-gtcrn", "denoise-dpdfnet");
  return ids;
}

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
  const optionalInstall = optionalPlanFor(total, speechBudgetGb, profile);
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
    optionalInstall,
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

/**
 * The live streaming ear under `voice.streamEngine` "auto" (the shipped default): on only when this PC has at least
 * 12 GB of RAM and 4 cores AND a first-run self-bench of the ear (10 synthetic chunks of 320 ms, kernel/stream_ear.py
 * `self_bench`) computes a chunk in 160 ms or less at the 95th percentile, half of real time. A named engine is the
 * owner's choice and is never gated; "off" is always off. electron/stt.cjs stores the bench and re-runs it when the
 * hardware facts change.
 */
const STREAM_AUTO = Object.freeze({
  minRamGb: 12,
  minCores: 4,
  benchChunks: 10,
  chunkMs: 320,
  p95LimitMs: 160,
});

/** The hardware half of the "auto" rule: `{ eligible, reason, detail }`, reason `ok`, `low-ram` or `few-cores`. */
function streamAutoHardware(facts = {}) {
  const ram = Number(facts.totalRamGb);
  const cores = Math.floor(Number(facts.cores));
  if (!(ram >= STREAM_AUTO.minRamGb)) {
    const known = ram > 0 ? `${round1(ram)} GB` : "an unknown amount of";
    return {
      eligible: false,
      reason: "low-ram",
      detail: `the live streaming ear stays off: this PC has ${known} RAM, it needs ${STREAM_AUTO.minRamGb} GB`,
    };
  }
  if (!(cores >= STREAM_AUTO.minCores)) {
    const known = cores > 0 ? String(cores) : "an unknown number of";
    return {
      eligible: false,
      reason: "few-cores",
      detail: `the live streaming ear stays off: this PC has ${known} processor cores, it needs ${STREAM_AUTO.minCores}`,
    };
  }
  return { eligible: true, reason: "ok", detail: "" };
}

/** The bench half: a measured 95th-percentile chunk time within the limit. Anything unmeasured is not a pass. */
function streamAutoBenchPassed(p95Ms) {
  return (
    typeof p95Ms === "number" &&
    Number.isFinite(p95Ms) &&
    p95Ms >= 0 &&
    p95Ms <= STREAM_AUTO.p95LimitMs
  );
}

const mb = (bytes) => `${Math.round(bytes / 1024 ** 2)} MB`;

/** An upper bound for the English streaming speech download, used only when the file set is unknown (its real size is the set's). */
const MOONSHINE_DISK_BYTES = 100 * 1024 ** 2;

/**
 * File sets: a model that is several single files from the publisher's own host (no Hugging Face repository to pin by
 * revision), each file pinned by url, SHA-256 and bytes and fetched through the same downloader. `moonshine-en` is
 * English streaming speech (Moonshine tiny streaming, MIT; the publisher's README says the English speech models are
 * MIT, the exceptions are the non-English ones) in `<root>/models/moonshine-en`, the folder `kernel/stt.py`
 * `moonshine_model_dir` reads. The nine files are the list the moonshine-voice 0.1.6 package itself downloads for
 * `get_model_for_language("en", TINY_STREAMING)`: read from that Windows wheel's native library and from the CDN on
 * 2026-11-28, every file fetched and hashed here. The folder name `quantized_26_11_02` belongs to that package version,
 * so the pin moves with `moonshine-voice` in kernel/requirements-capabilities.txt. The publisher's Hugging Face copy
 * of the CDN (`moonshine-ai/moonshine-voice-assets`) holds `quantized_26_11_07` only, a newer set a newer package
 * would ask for, so it is NOT a second source of these bytes and none is listed.
 * Not in `modelRegistry` yet: the Models page catalog and the Install Manager rows read the registry, and
 * `src/lib/friday/model-catalog.ts` must grow the same row first.
 */
const MOONSHINE_BASE = "https://download.moonshine.ai/model/tiny-streaming-en/quantized_26_11_02";
const FILE_SETS = [
  {
    id: "moonshine-en",
    label: "FRIDAY Ear Live English",
    kind: "stt",
    dir: ["models", "moonshine-en"],
    license: "MIT",
    firewallClass: "local",
    optional: true,
    fallback: "faster-whisper (the speech model of today)",
    files: [
      ["adapter.ort", 1319616, "c5f9f7cc98c27a965d8e200816f7e5c07b892712bb30cf07444bbde4ffd38199"],
      ["cross_kv.ort", 1287504, "5f68900da4ea20f40fbe67bbec36399f0d47faedbd7198b29abd9dc5f472ef9f"],
      [
        "decoder_kv.ort",
        32748720,
        "6564f2c9a19de44195a53e336e07d05108f14babab57105d623bb68b79572d75",
      ],
      [
        "decoder_kv_with_attention.ort",
        32676624,
        "24181780a1cec49516390213fd3cb10261d8dbc0efd52f36bd51b2ae001e761c",
      ],
      ["encoder.ort", 7675392, "617e403b2aae48f2474e0b148bf835deb9510bc8692efeabfe27203959a3256e"],
      [
        "frontend.model.ort",
        23392,
        "5662679f0e5758646d8eade3bc4b5d9ebda875feb6e696c0cc5f1a08fea2219e",
      ],
      [
        "frontend.weights.ort",
        2093416,
        "55c91d7efab9f7506d7d753131cba72145ff016be3447319fe414a31e13f25b4",
      ],
      [
        "streaming_config.json",
        509,
        "74fe5ddebd63b17caf59e8a3b18c17547ff7bce1642050edbb1c3962674f8950",
      ],
      ["tokenizer.bin", 249974, "6884b35fd6377d4c4d32336a0bc152f36b64d1e45b6503683cdc238250a8472d"],
    ].map(([file, bytes, sha256]) => ({
      file,
      sha256,
      bytes,
      url: `${MOONSHINE_BASE}/${file}`,
    })),
  },
];

/** The file sets, with the bytes and the licence: `[{ id, label, kind, dir, license, optional, fallback, files, diskBytes }]`. */
function fileSets() {
  return FILE_SETS.map((set) => ({
    ...set,
    dir: [...set.dir],
    files: set.files.map((file) => ({ ...file })),
    diskBytes: set.files.reduce((sum, file) => sum + file.bytes, 0),
  }));
}

/** True when every file of a set is on disk at its pinned size (`deps.sizeOf` stands in for the disk). */
function fileSetReady(root, id, deps = {}) {
  const set = FILE_SETS.find((row) => row.id === id);
  if (!root || !set) return false;
  const at = (file) => path.join(root, ...set.dir, file.file);
  // `deps.sizeOf` checks the pinned size; `deps.exists` alone (a plan's stand-in for the disk) checks presence.
  if (!deps.sizeOf && typeof deps.exists === "function")
    return set.files.every((file) => deps.exists(at(file)));
  const sizeOf = deps.sizeOf || ((file) => (fs.existsSync(file) ? fs.statSync(file).size : -1));
  return set.files.every((file) => sizeOf(at(file)) === file.bytes);
}

/**
 * One download job per file of a set, in the shape of the other pinned helper jobs: `job.modelId` is the set id and
 * `job.dir` the models folder, so the downloader's url source writes `<root>/models/<id>/<file>`. Each source carries the
 * pinned SHA-256 and size, so a wrong file is refused. A failure is a note that names the fallback (`optional`).
 */
function fileSetJobs(root, id) {
  const set = FILE_SETS.find((row) => row.id === id);
  if (!root || !set) return [];
  return set.files.map((file) => ({
    id: `${set.id}/${file.file}`,
    kind: "voice-model",
    optional: set.optional === true,
    fallback: set.fallback,
    approxBytes: file.bytes,
    ready: path.join(root, ...set.dir, file.file),
    job: {
      modelId: set.id,
      dir: path.join(root, "models"),
      sources: [
        {
          kind: "url",
          url: file.url,
          sha256: file.sha256,
          bytes: file.bytes,
          label: "Moonshine (publisher's own download host, pinned SHA-256)",
        },
      ],
    },
  }));
}

/** The speech sizes besides the planned ear that a setup keeps: the lite fallback, and small beside a GPU-sized ear. */
function extraSizesFor(primary) {
  const above = SIZE_ORDER.indexOf(primary) > SIZE_ORDER.indexOf("small");
  return [...(primary === "tiny" ? [] : ["tiny"]), ...(above ? ["small"] : [])];
}

/**
 * Whether a setup on this PC fetches the streaming ear, from the same budget: `{ state, reason }` with state `on-disk`
 * (a verified copy is reused, never fetched again), `download`, or `skipped` with the reason. Never on the lite profile,
 * a low-end processor or a speech budget (which already counts free RAM) below the ear's recommended RAM, and never while the line
 * waits (`waitReason`: metered, on battery, heavy load, from electron/setup-plan.cjs). The disk is checked by the caller.
 */
function streamEarDecision(budget, probe, options = {}) {
  const facts = manifestOf(STREAM_EAR_ID);
  if (!facts) return null;
  if (options.onDisk === true) return { state: "on-disk", reason: "" };
  const skip = (reason) => ({ state: "skipped", reason });
  if (budget.profile === "lite")
    return skip(
      "the lite voice profile keeps the streaming ear off; install it from the Models page if you want it",
    );
  if (probe?.cpuClass === "low")
    return skip(
      "a low-end processor keeps the streaming ear off; install it from the Models page if you want it",
    );
  if (facts.recommendedRamGb > budget.speechBudgetGb)
    return skip(
      `not enough RAM: the streaming ear wants ${facts.recommendedRamGb} GB, the speech budget here is ${budget.speechBudgetGb} GB`,
    );
  const wait = typeof options.waitReason === "string" ? options.waitReason.trim() : "";
  if (wait)
    return skip(
      `a ${mb(facts.diskBytes)} download waits: ${wait}; install it from the Models page later`,
    );
  return { state: "download", reason: "" };
}

/**
 * What a fresh setup does about the voice on THIS PC, from the probe: which pinned models are fetched, which are already
 * on disk, which are skipped and why, and what stays optional on demand. Pure: `deps.exists` and `deps.statfs` stand in
 * for the disk, so a test needs no hardware. The essentials (the two helpers, the primary ear, the voice) are always
 * planned; the optional ones (the Hindi ear and punctuation) are skipped, with the reason, when the RAM budget or the
 * disk (1.3 times the bytes) cannot carry them. The streaming ear is decided apart (`streamEarDecision`, `streamEar`);
 * `deps.waitReason` says why a big download must wait here. `lines` is the text setup and `--dry-run` print.
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
    if (isOptionalHelper(id)) {
      item.optional = true;
      item.fallback = helperFallback(id);
    }
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
  // The extras: what a setup fetches besides the planned models, decided here and nowhere else. The lite size is the
  // fallback for a busy PC; small is the CPU companion of a PC whose ear runs on the GPU; English streaming speech is a
  // small download of its own. Any other size (base, medium, the big ones) is not fetched here: the Models page has it.
  const extras = [];
  let extraBytes = 0;
  const extraItem = (id, kind, bytes, here) => {
    const item = { id, kind, bytes, state: "download", reason: "", optional: true };
    if (here) item.state = "on-disk";
    else {
      const room = pins.diskPreflight(
        root,
        planned + extraBytes + bytes,
        deps.statfs ? { statfs: deps.statfs } : {},
      );
      if (room.ok) extraBytes += bytes;
      else {
        item.state = "skipped";
        item.reason = room.error;
      }
    }
    return item;
  };
  for (const size of extraSizesFor(budget.sttSize)) {
    const dir = path.join(root, "cache", "stt", size);
    extras.push(
      extraItem(
        `stt-${size}`,
        "stt",
        manifestOf(STT_CATALOG[size]).diskBytes,
        weightsReady(dir, exists),
      ),
    );
  }
  // English streaming speech: the pinned file set (real bytes, real presence). When it must be fetched the plan carries
  // the per-file jobs (url, SHA-256, bytes), so the fetcher needs no second list.
  const moonshine = fileSets().find((set) => set.id === "moonshine-en");
  const moonshineHere = fileSetReady(root, "moonshine-en", { exists });
  const moonshineItem = extraItem(
    "moonshine-en",
    "engine",
    moonshine?.diskBytes ?? MOONSHINE_DISK_BYTES,
    moonshineHere,
  );
  if (moonshineItem.state === "download") moonshineItem.jobs = fileSetJobs(root, "moonshine-en");
  extras.push(moonshineItem);
  // The streaming ear: planned only on a PC that can carry it (see streamEarDecision), reused when already verified on
  // disk. Planned, it stays optional: a failed fetch is a note naming the fallback, and the Doctor shows it missing but
  // not required; a plan that skips it says why, and the Doctor shows that as skipped, never missing.
  const stream = streamEarDecision(budget, probe, {
    onDisk: onDisk.has(STREAM_EAR_ID),
    waitReason: deps.waitReason,
  });
  // It is kept apart from `items` (the models every voice plan lists) as `streamEar`, and its bytes stay out of
  // `downloadBytes` (`streamEarBytes`): prefetch and setup-plan read both. It goes last, after the extras, on the disk.
  let streamEar = null;
  if (stream) {
    const facts = manifestOf(STREAM_EAR_ID);
    const item = {
      id: STREAM_EAR_ID,
      kind: facts.kind,
      bytes: facts.diskBytes,
      state: stream.state,
      reason: stream.reason,
      optional: true,
      fallback: STREAM_EAR_FALLBACK,
    };
    if (item.state === "download") {
      const room = pins.diskPreflight(
        root,
        planned + extraBytes + facts.diskBytes,
        deps.statfs ? { statfs: deps.statfs } : {},
      );
      if (!room.ok) {
        item.state = "skipped";
        item.reason = room.error;
      }
    }
    streamEar = item;
  }
  // The optional language and sound models of this PC (`budget.optionalInstall`): planned last, after the extras and the
  // streaming ear, on the disk that is left (1.3 times the bytes). Each is optional with its fallback, so a failed fetch
  // is a note and the Doctor shows an absent one as missing, not required. They are kept apart from `items` (the models
  // every voice plan must list) as `optionalItems`; their bytes stay out of `downloadBytes` (`optionalBytes`).
  const optionalItems = [];
  let optionalBytes = 0;
  for (const id of budget.optionalInstall) {
    const facts = manifestOf(id);
    if (!facts) continue;
    const item = {
      id,
      kind: facts.kind,
      bytes: facts.diskBytes,
      state: "download",
      reason: "",
      optional: true,
      fallback: planFallback(id),
    };
    if (onDisk.has(id)) item.state = "on-disk";
    else {
      const room = pins.diskPreflight(
        root,
        planned +
          extraBytes +
          (streamEar?.state === "download" ? streamEar.bytes : 0) +
          optionalBytes +
          facts.diskBytes,
        deps.statfs ? { statfs: deps.statfs } : {},
      );
      if (room.ok) optionalBytes += facts.diskBytes;
      else {
        item.state = "skipped";
        item.reason = room.error;
      }
    }
    optionalItems.push(item);
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
  for (const item of streamEar ? [streamEar] : []) {
    if (item.state === "on-disk")
      lines.push(`[friday] ok       ${item.id} already on disk (${mb(item.bytes)}), reused`);
    else if (item.state === "download")
      lines.push(`[friday] INFO     ${item.id} will be fetched (${mb(item.bytes)})`);
    else lines.push(`[friday] INFO     ${item.id} skipped: ${item.reason}`);
  }
  for (const item of optionalItems) {
    if (item.state === "on-disk")
      lines.push(`[friday] ok       ${item.id} (optional) already on disk (${mb(item.bytes)})`);
    else if (item.state === "download")
      lines.push(`[friday] INFO     ${item.id} (optional) will be fetched (${mb(item.bytes)})`);
    else lines.push(`[friday] INFO     ${item.id} (optional) skipped: ${item.reason}`);
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
    extras,
    blocked,
    optional,
    streamEar,
    streamEarBytes: streamEar?.state === "download" ? streamEar.bytes : 0,
    optionalItems,
    optionalBytes,
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
  let result = await deps.downloadModel(
    {
      modelId: plan.size,
      sources: plan.sources,
      dir: path.join(root, "cache", "stt"),
    },
    deps.onEvent,
    deps.signal,
  );
  // Every Hugging Face road failed (not for want of a network): the ModelScope copy of the same pinned files is tried,
  // each file held to the pinned SHA-256 and size. Only with the real downloader (or an injected `downloadUrl`), so a
  // stand-in `downloadModel` in a test never reaches the network.
  const mirror = modelscopeSource(plan.repo);
  const realDownloader =
    typeof deps.downloadUrl === "function" ||
    deps.downloadModel === require("./model-download.cjs").downloadModel;
  if (
    !result?.ok &&
    mirror &&
    plan.pin &&
    realDownloader &&
    !/^offline/i.test(String(result?.error || ""))
  ) {
    deps.onEvent?.({ status: `source: ${mirror.label}` });
    const got = await downloadMirrorSet(mirror, plan.dir, deps);
    result = got.ok
      ? { ok: true, via: got.via, source: got.source }
      : {
          ...result,
          ok: false,
          error: `${result?.error || "no source answered"}; ${mirror.label}: ${got.error}`,
        };
  }
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
  isOptionalHelper,
  otherVoiceJobs,
  ensureSttWeights,
  auditStt,
  auditTts,
  pinChecks,
  helperPinChecks,
  smartTurnLoadCheck,
  FIREWALL_CLASSES,
  pinSelfTests,
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
  TTS_ARCHIVE_REPO,
  HF_MIRROR_HOST,
  withOptInMirrors,
  RELEASE_LABEL,
  LOCAL_LABEL,
  OFFICIAL_LABEL,
  readFridayModels,
  fridayReleasePlan,
  localBundleSource,
  withFridayRelease,
  sourceNotePath,
  servedSource,
  servedNote,
  HINDI_EAR_REPO,
  HINGLISH_EAR_REPO,
  HINDI_FALLBACK_REPO,
  HINDI_PUNCT_REPO,
  HINDI_LIGHT_REPO,
  DENOISE_REPO,
  GTCRN_REPO,
  SPEAKER_REPO,
  HINDI_VAANI_REPO,
  HINGLISH_TRELIS_REPO,
  STREAM_EAR_REPO,
  ENGLISH_EAR_REPO,
  SWIFT_EAR_REPO,
  QUICK_EAR_REPO,
  QUICK_VOCAB_REPO,
  STREAM_EAR_ID,
  STREAM_EAR_FALLBACK,
  isPlanOptional,
  planFallback,
  OPTIONAL_PLAN_FALLBACKS,
  modelscopeSource,
  withModelscopeRoad,
  MODELSCOPE_REPO_MAP,
  sttSourcesWithMirror,
  downloadMirrorSet,
  MODELSCOPE_HOST,
  fileSets,
  fileSetReady,
  fileSetJobs,
  pinnedFailureLine,
  streamEarDecision,
  STREAM_AUTO,
  streamAutoHardware,
  streamAutoBenchPassed,
  EAR_MODELS,
  EXTRA_MODELS,
  HINGLISH_PRO_REPO,
  DERIVED_EARS,
  NEEDS_RELEASE,
  derivedEarPlan,
  derivedEarPin,
  derivedEarState,
  derivedEarSources,
};
