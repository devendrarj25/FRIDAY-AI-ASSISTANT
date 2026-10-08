/**
 * Voice weights are fetched here, then the worker opens the folder.
 * The worker does not download. A hash is checked only when one is pinned.
 */
const path = require("path");

const STT_REPOS = {
  tiny: "Systran/faster-whisper-tiny",
  base: "Systran/faster-whisper-base",
  small: "Systran/faster-whisper-small",
  medium: "Systran/faster-whisper-medium",
  "large-v3": "Systran/faster-whisper-large-v3",
};

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
    sources: [{ kind: "hf-repo", repo: STT_REPOS[size], label: "Hugging Face" }],
  };
}

function weightsReady(dir, exists) {
  const check = exists || (() => false);
  return STT_FILES.filter((name) => name === "config.json" || name === "model.bin").every((name) =>
    check(path.join(dir, name)),
  );
}

function pinnedJobs() {
  return PINNED.map((row) => ({ ...row, dir: [...row.dir] }));
}

/**
 * Supertonic and the speaker file have no single pinned digest here.
 * They are not fetched by the worker. Wake audio ships with the app.
 */
function otherVoiceJobs() {
  return [
    {
      id: "supertonic-3",
      sha256: null,
      url: null,
      reason: "no pinned digest, so the worker does not download it",
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

async function ensureSttWeights(model, root, deps = {}) {
  const plan = sttPlan(model, root);
  plan.skipped = otherVoiceJobs().map((row) => row.id);
  plan.pinned = pinnedJobs().map((row) => row.id);
  const exists = deps.exists || (() => false);
  if (!root)
    return { ok: false, cause: "path", error: "no FRIDAY folder is selected", dir: plan.dir };
  if (weightsReady(plan.dir, exists)) return { ok: true, dir: plan.dir, downloaded: false, plan };
  if (typeof deps.downloadModel !== "function") {
    return {
      ok: false,
      cause: "downloading",
      error: "speech weights are not on disk and the downloader is unavailable",
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
  return { ok: true, dir: plan.dir, downloaded: true, plan };
}

module.exports = {
  STT_REPOS,
  sttPlan,
  weightsReady,
  pinnedJobs,
  otherVoiceJobs,
  ensureSttWeights,
};
