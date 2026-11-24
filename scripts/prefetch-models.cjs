#!/usr/bin/env node
/**
 * Build-time model prefetch: the weights FRIDAY needs to hear, turn-take and
 * chat land in the selected FRIDAY folder during setup, so a fresh install
 * listens and answers offline on first boot instead of downloading on first
 * use.
 *
 * Everything goes through the app's own downloader (electron/model-download.cjs):
 * official sources first, the same allowlist, resumable parts, and a SHA-256
 * check against the publisher's digest (pinned here, or read from the Hugging
 * Face listing). The running app later reuses, repairs and updates the same
 * folders from Models and Install Manager. A download that does not finish
 * fails the step (exit 1) and names each model, so setup and the build stop
 * instead of leaving FRIDAY without its voice or chat model. A step that does
 * not run (hosted CI, offline, FRIDAY_PREFETCH=0) is skipped, not failed;
 * FRIDAY_PREFETCH_STRICT=0 reports a failure without failing.
 *
 * The offline neural voice (Supertonic 3, from its publisher's Hugging Face repo,
 * every file checked against the publisher's own digest) is fetched the same
 * way, so spoken answers work offline on the first launch.
 *
 * Running it again is cheap and quiet: every piece that is already on disk (and
 * matches its pinned digest where one exists) is only verified and the next one
 * is taken. `npm run setup` and `build:win` both run it, so nothing downloads twice.
 *
 * On Windows the same step also sets up Ollama. An Ollama that is already on
 * this PC (running, on PATH, or in its standard folders) is reused as it is:
 * no installer is downloaded and nothing is reinstalled. Only a missing Ollama
 * is installed per user (the newest official release, SHA-256 and Authenticode
 * checked, no administrator). It is then started and the one light, fast local
 * chat model of config/local-runners.json is pulled for quick replies and
 * talking; long, hard work goes to the larger models the router picks. A model
 * Ollama already holds is not pulled again, and the Qwen GGUF below is fetched
 * only when Ollama could not provide the same small model.
 *
 * Opt out: FRIDAY_PREFETCH=0 skips all of it, FRIDAY_PREFETCH_CHAT=0 skips the
 * local chat model only, FRIDAY_PREFETCH_TTS=0 the offline voice,
 * FRIDAY_PREFETCH_STT_LITE=0 the tiny size, FRIDAY_PREFETCH_STT_LARGE=0 the medium and large-v3 sizes,
 * FRIDAY_PREFETCH_STT_MAX=0 only large-v3, FRIDAY_PREFETCH_MOONSHINE=0 the English streaming speech,
 * FRIDAY_PREFETCH_OLLAMA=0 the Ollama install and the Qwen pull. The large-v3-turbo speech size is not part of
 * setup (FRIDAY fetches it from inside the app when it is chosen); FRIDAY_PREFETCH_STT_BIG=1 adds it.
 * install and pulls. Hosted CI skips it
 * unless FRIDAY_PREFETCH=1, so a workflow run does not pull gigabytes on every build.
 *
 * The voice follows this PC: the hardware probe (memory, free memory, GPU) picks the profile in electron/voice-weights.cjs
 * (budgetFor), and setup fetches only the pinned voice models that profile can carry, plus the Hindi ear and its punctuation
 * model; a speech size the PC does not load on its own (medium, large-v3-turbo, large-v3 without a verified GPU) and a model
 * that does not fit the RAM or the disk is skipped with its reason, and stays an install from the Models page.
 * FRIDAY_PREFETCH_VOICE_BUDGET=0 returns to the plain list. `node scripts/prefetch-models.cjs --voice` fetches the voice
 * alone, and `--voice --dry-run` prints the plan and downloads nothing.
 *
 * Setup is hardware-first: before any download the measured facts of this PC (electron/hardware.cjs) become ONE plan
 * (electron/setup-plan.cjs) and its "this PC" block is printed. The chat model is the plan's tier for this PC's memory
 * (an installed model that is at least as good is kept, never deleted or pulled again; a better one is only offered; a
 * metered line, battery or no network defers the pull with a note), the speech sizes come from the same voice plan the
 * Doctor reads, and llama.cpp, the CUDA libraries and ONNX Runtime follow the plan: no graphics card means no GPU
 * download. `--plan` prints the block and `--plan --json` the required set, and downloads nothing.
 */
const fs = require("node:fs");
// Colour that means something (ok green, FAIL red, a note yellow) on a real console; plain text everywhere else.
if (require.main === module) require("./live-console.cjs").installColorConsole();
const path = require("node:path");
const os = require("node:os");

const voiceWeights = require("../electron/voice-weights.cjs");
const stageToolchain = require("./stage-toolchain.cjs");
const localRunners = require("../config/local-runners.json");
const { DownloadBoard } = require("./download-board.cjs");
const localLibrary = require("../electron/local-library.cjs");
const updatePolicy = require("./update-policy.cjs");
const llamaRuntime = require("../electron/llama-runtime.cjs");
const setupPlan = require("../electron/setup-plan.cjs");

/** About how large each piece is, for the plan and the overall bar before the real sizes are known. */
const APPROX_BYTES = {
  "silero-vad": 2.3 * 1024 ** 2,
  "smart-turn": 8.7 * 1024 ** 2,
  "llamacpp-runtime": 18.6 * 1024 ** 2,
  "stt-tiny": 75 * 1024 ** 2,
  "stt-base": 141 * 1024 ** 2,
  "stt-small": 464 * 1024 ** 2,
  "stt-medium": 1457 * 1024 ** 2,
  "stt-large-v3-turbo": 1620 * 1024 ** 2,
  "stt-large-v3": 3100 * 1024 ** 2,
  "supertonic-3": 383 * 1024 ** 2,
  "hindi-ear": 131 * 1024 ** 2,
  "hindi-punct": 223 * 1024 ** 2,
  "qwen3-4b": 2500 * 1024 ** 2,
  "ollama-setup": 1.6 * 1024 ** 3,
};

/** The marker line `--plan --json` prints, so a console banner or a warning above it cannot be mistaken for the data. */
const PLAN_JSON = "FRIDAY_SETUP_PLAN_JSON ";

/** Ollama is the local engine FRIDAY starts and stops; the light chat model is pulled through it. */
const OLLAMA_API = "http://127.0.0.1:11434";
const OLLAMA_MODELS = localLibrary.ollamaModels();

/** Speech sizes: base starts listening fast, small is the Hindi/Hinglish default. */
const STT_SIZES = ["base", "small"];

/**
 * A larger, more accurate size kept on disk for long or hard speech (pick it in Settings, Voice, Speech size). Whether
 * this PC may carry it is the voice plan's word (electron/voice-weights.cjs budgetFor: a verified GPU and the memory),
 * the same one the Doctor reads, so no memory threshold lives here.
 */
const STT_LARGE = { size: "medium" };
/** The big speech size for a strong PC: near large-v3, far less decoding work. About 1.6 GB. Only FRIDAY_PREFETCH_STT_BIG=1 fetches it. */
const STT_BIG = { size: "large-v3-turbo" };

/** The lite fallback: the smallest size, so a weak or busy PC can still hear. About 75 MB, every PC. */
const STT_LITE = { size: "tiny" };
/** The most accurate size. About 3 GB; optional, so a failed download never fails setup, and the voice plan decides whether this PC takes it. */
const STT_MAX = { size: "large-v3" };

/** The offline neural voice the kernel opens from `<root>/models/supertonic-3` (voice F2). */
const TTS_MODEL = {
  id: "supertonic-3",
  sources: [{ kind: "hf-repo", repo: "Supertone/supertonic-3", label: "Hugging Face (Supertone)" }],
};

/** The same Qwen3 4B as the one Ollama pulls, from the publisher's own GGUF repo (Apache-2.0): the file copy used when Ollama's registry cannot be reached. */
const CHAT_MODEL = {
  id: "qwen3-4b",
  sources: [
    {
      kind: "hf-gguf",
      repo: "Qwen/Qwen3-4B-GGUF",
      match: ["q4_k_m", "q5_k_m", "q8_0"],
      label: "Hugging Face (Qwen official)",
    },
  ],
};

function enabled(env, key) {
  return String(env[key] ?? "1").trim() !== "0";
}

/** Off unless the owner asks for it with the value 1: the big speech sizes are fetched from inside FRIDAY later. */
function optedIn(env, key) {
  return String(env[key] ?? "0").trim() === "1";
}

const findOllama = localLibrary.findInstalledOllama;

/**
 * How many models download at once (FRIDAY_PREFETCH_PARALLEL, default 2, at most 4). One big model already
 * uses a pool of connections, but the many small files (turn detector, speech detector, the base speech
 * size) spend most of their time waiting for a connection to open, so a second lane keeps the line busy.
 * FRIDAY_PREFETCH_PARALLEL=1 gives the old one-at-a-time order.
 */
function prefetchParallelism(env = process.env) {
  const wanted = Math.floor(Number(env.FRIDAY_PREFETCH_PARALLEL));
  return Number.isFinite(wanted) && wanted >= 1 ? Math.min(wanted, 4) : 2;
}

const { mapPool, registerGguf } = require("../electron/model-download.cjs");

/**
 * llama.cpp in setup. With this PC's plan (`llama` = plan.llama) the plan's word counts: the pinned CPU zip is
 * installed when the plan says install, and FRIDAY_PREFETCH_LLAMACPP=0 leaves it out. Without a plan it stays what it was:
 * not part of setup, added later from the Install Manager, and FRIDAY_PREFETCH_LLAMACPP=1 opts it in.
 */
function llamaCppWanted(env, platform, llama) {
  if (platform !== "win32" || !enabled(env, "FRIDAY_AUTO_INSTALL")) return false;
  const flag = String(env.FRIDAY_PREFETCH_LLAMACPP ?? "").trim();
  if (flag === "0") return false;
  if (flag === "1") return true;
  return llama?.action === "install";
}

/** Ollama serves the chat model on Windows (the plan's tier for this PC), so the separate GGUF copy is not fetched there. */
function ollamaServesChat(env, platform) {
  return (
    platform === "win32" &&
    enabled(env, "FRIDAY_PREFETCH_OLLAMA") &&
    enabled(env, "FRIDAY_AUTO_INSTALL")
  );
}

/**
 * The ordered jobs for one FRIDAY root. Pure, so a test can read it.
 * `have.ollama` is an Ollama already on this PC: its installer is never planned.
 */
function prefetchPlan(root, env = process.env, platform = process.platform, have = {}) {
  if (!root || !enabled(env, "FRIDAY_PREFETCH")) return [];
  const hosted = Boolean(env.CI || env.GITHUB_ACTIONS);
  if (hosted && String(env.FRIDAY_PREFETCH || "") !== "1") return [];
  const jobs = [];
  // Order is priority: the two tiny files that decide when she stops listening come first, then the speech sizes
  // she hears with, then her voice and her chat model, and the big optional size last.
  for (const pinned of voiceWeights.pinnedJobs()) {
    const dir = path.join(root, ...pinned.dir);
    jobs.push({
      id: pinned.id,
      kind: "pinned",
      ready: path.join(dir, pinned.file),
      // The two helpers are optional: FRIDAY listens and ends a turn without them, so a failed fetch is a note.
      ...(pinned.optional === true ? { optional: true } : {}),
      failureLine: pinned.failureLine,
      job: {
        modelId: path.basename(dir),
        dir: path.dirname(dir),
        // Every source the pin lists, tried in order (the immutable revision first, the release second).
        sources: pinned.sources.map((source) => ({
          ...source,
          sha256: source.sha256 || pinned.sha256,
          bytes: source.bytes || pinned.bytes,
        })),
      },
    });
  }
  for (const size of STT_SIZES) {
    const plan = voiceWeights.sttPlan(size, root);
    jobs.push({
      id: plan.id,
      kind: "stt",
      ready: plan.dir,
      job: { modelId: plan.size, sources: plan.sources, dir: path.dirname(plan.dir) },
    });
  }
  if (enabled(env, "FRIDAY_PREFETCH_STT_LITE")) {
    const plan = voiceWeights.sttPlan(STT_LITE.size, root);
    jobs.push({
      id: plan.id,
      kind: "stt",
      ready: plan.dir,
      job: { modelId: plan.size, sources: plan.sources, dir: path.dirname(plan.dir) },
    });
  }
  if (enabled(env, "FRIDAY_PREFETCH_TTS")) jobs.push(ttsJob(root));
  // The voice plan of this PC (voice-weights.cjs voiceInstallPlan): the pinned models its RAM and disk can carry for
  // Hindi, English and Hinglish. Without a plan the list is exactly what it was.
  for (const item of have.plan?.items || []) {
    if (item.state === "skipped" || jobs.some((job) => job.id === voiceJobId(item.id))) continue;
    // FRIDAY_PREFETCH_STT_LARGE=0 keeps the two heavy sizes off this PC even when its plan could carry them.
    if (
      ["stt-medium", "stt-large-v3"].includes(voiceJobId(item.id)) &&
      !enabled(env, "FRIDAY_PREFETCH_STT_LARGE")
    )
      continue;
    const added = voiceModelJob(root, item.id);
    if (added) jobs.push(added);
  }
  // The chat GGUF file is the copy for a PC where Ollama does not serve chat (not Windows setup), or the one an owner
  // asks for with FRIDAY_PREFETCH_LLAMACPP=1. On Windows the chat model is the plan's tier, pulled through Ollama.
  const llamaOptIn = String(env.FRIDAY_PREFETCH_LLAMACPP ?? "").trim() === "1";
  if (enabled(env, "FRIDAY_PREFETCH_CHAT") && (!ollamaServesChat(env, platform) || llamaOptIn)) {
    jobs.push(chatJob(root));
  }
  // llama.cpp: the plan's step. Setup installs the pinned CPU zip (SHA-256 pinned) when the plan says install; a GPU
  // build, if the plan offers one, is installed from the Install Manager after setup, so no GPU download happens here.
  const llamaWanted = llamaCppWanted(env, platform, have.llama);
  const llamaRelease = (localRunners.runners || []).find((row) => row.id === "llamacpp")?.release;
  if (llamaWanted && llamaRelease?.url) {
    const dir = path.join(root, "runtime", "installers", "llamacpp");
    jobs.push({
      id: "llamacpp-runtime",
      kind: "archive",
      root,
      ready: path.join(dir, llamaRelease.asset),
      tag: llamaRelease.tag,
      job: {
        modelId: "llamacpp",
        dir,
        sources: [
          {
            kind: "url",
            url: llamaRelease.url,
            sha256: llamaRelease.sha256,
            bytes: llamaRelease.bytes,
            label: `llama.cpp ${llamaRelease.tag} (official release)`,
          },
        ],
      },
    });
  }
  const release = (localRunners.runners || []).find((row) => row.id === "ollama")?.release;
  if (
    platform === "win32" &&
    release?.url &&
    !have.ollama &&
    enabled(env, "FRIDAY_PREFETCH_OLLAMA")
  ) {
    const dir = path.join(root, "runtime", "installers");
    jobs.push({
      id: "ollama-setup",
      kind: "installer",
      ready: path.join(dir, "ollama", release.asset),
      job: {
        modelId: "ollama",
        dir,
        sources: [
          {
            kind: "url",
            url: release.url,
            sha256: release.sha256,
            bytes: release.bytes,
            label: `Ollama ${release.tag} (official release)`,
          },
          {
            kind: "url",
            url: "https://ollama.com/download/OllamaSetup.exe",
            sha256: release.sha256,
            bytes: release.bytes,
            label: "ollama.com (official site)",
          },
        ],
      },
    });
  }
  // The larger speech sizes (medium, large-v3) go last, so everything needed to listen, speak and chat is in place
  // first. large-v3-turbo is not part of setup: FRIDAY fetches it from inside the app (FRIDAY_PREFETCH_STT_BIG=1 adds it).
  // The plan alone says whether this PC carries one (a planned size is an item above and is not added twice; a size the
  // plan blocks or skips keeps its job only to be named with the plan's reason); without a plan the run asks the same
  // budget (`have.blocked`), so no memory threshold lives in this file.
  const sttExtra = (size, extra) => {
    const plan = voiceWeights.sttPlan(size, root);
    if (jobs.some((job) => job.id === plan.id)) return;
    jobs.push({
      id: plan.id,
      kind: "stt",
      ready: plan.dir,
      ...extra,
      job: { modelId: plan.size, sources: plan.sources, dir: path.dirname(plan.dir) },
    });
  };
  if (enabled(env, "FRIDAY_PREFETCH_STT_LARGE")) {
    sttExtra(STT_LARGE.size, {});
    // The big size comes after everything else, and the owner can leave it out.
    if (enabled(env, "FRIDAY_PREFETCH_STT_MAX")) sttExtra(STT_MAX.size, { optional: true });
  }
  if (optedIn(env, "FRIDAY_PREFETCH_STT_BIG")) sttExtra(STT_BIG.size, { explicit: true });
  // A speech size this PC does not load on its own stays out of setup (the owner can still install it from the Models
  // page, or ask for it here with FRIDAY_PREFETCH_STT_BIG=1); the run says why, in the same line as any other skip.
  // A size the plan itself skipped (its memory or disk does not carry it) is named with the plan's own reason.
  for (const item of have.plan?.items || []) {
    const job = item.state === "skipped" && jobs.find((row) => row.id === voiceJobId(item.id));
    if (job && !job.explicit && !job.skipReason) job.skipReason = item.reason;
  }
  for (const blocked of have.plan?.blocked || have.blocked || []) {
    const job = jobs.find((row) => row.id === `stt-${blocked.size}` && !row.explicit);
    if (job) job.skipReason = blocked.reason;
  }
  // With a plan, a speech size the plan does not list is a cheap extra (the fast starter, the lite fallback): fetched,
  // but a failed fetch is a note and the Doctor does not require it.
  if (have.plan) {
    const listed = new Set(
      (have.plan.items || []).filter((i) => i.state !== "skipped").map((i) => voiceJobId(i.id)),
    );
    for (const job of jobs) if (job.kind === "stt" && !listed.has(job.id)) job.optional = true;
  }
  return jobs;
}

/** The setup job id of a catalog id: a speech size is `stt-<size>`, every other voice model keeps its own id. */
function voiceJobId(catalogId) {
  const size = Object.keys(voiceWeights.STT_CATALOG).find(
    (key) => voiceWeights.STT_CATALOG[key] === catalogId,
  );
  return size ? `stt-${size}` : catalogId;
}

/**
 * The job for a pinned voice model that setup does not already fetch by its own rule: a speech size, the Hindi ear and its
 * punctuation model (fetched at their pinned revision into `<root>/models/<id>`, like the neural voice).
 */
function voiceModelJob(root, catalogId) {
  const size = Object.keys(voiceWeights.STT_CATALOG).find(
    (key) => voiceWeights.STT_CATALOG[key] === catalogId,
  );
  if (size) {
    const plan = voiceWeights.sttPlan(size, root);
    return {
      id: plan.id,
      kind: "stt",
      ready: plan.dir,
      job: { modelId: plan.size, sources: plan.sources, dir: path.dirname(plan.dir) },
    };
  }
  const row = voiceWeights.modelRegistry().find((item) => item.catalogId === catalogId);
  if (!row?.repo || row.dir[0] !== "models") return null;
  return {
    id: catalogId,
    kind: "voice-model",
    ready: path.join(root, ...row.dir),
    job: {
      modelId: catalogId,
      dir: path.join(root, "models"),
      sources: [{ kind: "hf-repo", repo: row.repo, label: `Hugging Face (${row.label})` }],
    },
  };
}

/** Done only when a whole run finished: the repo is fetched file by file, so one file proves nothing. */
function ttsJob(root) {
  const dir = path.join(root, "models");
  return {
    id: TTS_MODEL.id,
    kind: "tts",
    ready: path.join(dir, TTS_MODEL.id, ".friday-complete"),
    job: { modelId: TTS_MODEL.id, sources: TTS_MODEL.sources, dir },
  };
}

function chatJob(root) {
  return {
    id: CHAT_MODEL.id,
    kind: "chat",
    ready: path.join(root, "models", CHAT_MODEL.id),
    job: { modelId: CHAT_MODEL.id, sources: CHAT_MODEL.sources, dir: path.join(root, "models") },
  };
}

/** Is this piece already here? A pinned digest is checked; nothing is fetched to find out. */
/**
 * What a piece that is already here takes on disk, so the board's ALL total is the same whether this run
 * downloaded it (the bytes that arrived) or found it (the bytes on disk), not the catalogue's estimate. A
 * completion marker stands for the folder that holds it. 0 when it cannot be measured (the estimate is used).
 */
function bytesOnDisk(target) {
  try {
    const where = path.basename(target).startsWith(".friday-") ? path.dirname(target) : target;
    const stat = fs.statSync(where);
    if (stat.isFile()) return stat.size;
    if (stat.isDirectory())
      return require("./electron-module.cjs").load("activity.cjs").dirSize(where);
  } catch {
    /* unmeasurable: the estimate stays */
  }
  return 0;
}

function alreadyThere(row) {
  if (!row.ready) return false;
  if (row.kind === "stt") return voiceWeights.weightsReady(row.ready, fs.existsSync);
  // A pinned model folder is here when every pinned file is (the repair and the pin audit run in the app).
  if (row.kind === "voice-model") {
    return voiceWeights
      .voiceModelsOnDisk(path.dirname(path.dirname(row.ready)), fs.existsSync)
      .some((found) => found.catalogId === row.id);
  }
  // The zip is kept only as the installer: the piece is here when the server it holds is unpacked.
  if (row.kind === "archive") return llamaRuntime.installed(row.root);
  if (row.kind === "chat") {
    try {
      return fs.readdirSync(row.ready).some((name) => name.toLowerCase().endsWith(".gguf"));
    } catch {
      return false;
    }
  }
  if (!fs.existsSync(row.ready)) return false;
  // A kept file is reused only when it is the exact bytes the publisher signed off.
  const want = row.job.sources[0]?.sha256;
  if (!want) return true;
  try {
    return (
      require("../electron/model-download.cjs").hashFile(row.ready) === String(want).toLowerCase()
    );
  } catch {
    return false;
  }
}

function printer(log, id, linesOnly = false) {
  // A terminal redraws one live line (size, speed, ETA, connections). A log, or downloads running
  // side by side, print one line each time another ten percent is done, never one per update.
  const tty = !linesOnly && Boolean(process.stdout.isTTY) && log === console.log;
  let last = "";
  let bucket = -1;
  let open = false;
  const said = new Set();
  const report = (event) => {
    // A source that failed and the move to the next one are said once on their own line, so a
    // slow download shows why (the log used to hide a Hugging Face client that gave up).
    const note = String(event?.status || "");
    if (event?.progress == null && /did not finish|source failed|using FRIDAY's own/i.test(note)) {
      if (said.has(note)) return;
      said.add(note);
      if (open) process.stdout.write("\n");
      open = false;
      log(`[friday] ${id.padEnd(14)} ${note.slice(0, 200)}`);
      return;
    }
    const line = stageToolchain.progressLine(id, event, tty);
    if (!line || line === last) return;
    if (tty) {
      last = line;
      require("./electron-module.cjs").load("activity.cjs").markBoardActive();
      process.stdout.write(line);
      open = true;
      return;
    }
    const step = Math.floor(Math.max(0, Math.min(100, Number(event?.progress))) / 10);
    if (step <= bucket) return;
    bucket = step;
    last = line;
    log(line);
  };
  /** End the redrawn progress line so the next message starts on its own line. */
  report.end = () => {
    if (open) process.stdout.write("\n");
    open = false;
  };
  return report;
}

async function ollamaUp(fetchImpl) {
  try {
    const res = await fetchImpl(`${OLLAMA_API}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    const body = await res.json();
    return new Set((body.models || []).map((row) => String(row.name || row.model || "")));
  } catch {
    return null;
  }
}

/**
 * One short real answer from the light model, so "pulled" also means "loads and answers". A slow first load
 * on a CPU-only PC gets a generous time; a timeout or a refusal is reported, never thrown.
 */
async function ollamaAnswers(tag, fetchImpl, timeoutMs = 240000) {
  try {
    const res = await fetchImpl(`${OLLAMA_API}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: tag,
        prompt: "Reply with the single word: ready",
        stream: false,
        // Qwen3 is a thinking model: left to think, a short reply budget is spent on the thinking and the
        // answer comes back empty. The check wants an answer, so thinking is off for it.
        think: false,
        options: { num_predict: 32, temperature: 0 },
        keep_alive: "30s",
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await res.json();
    if (typeof body?.response !== "string") return { ok: false, error: "no answer field" };
    // A model that only produced thinking is alive and answering; an empty body is not.
    const spoke = body.response.trim().length > 0 || String(body.thinking || "").trim().length > 0;
    return { ok: spoke, error: "empty answer" };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/**
 * A pull that makes no progress for this long is given up, so a registry that cannot be reached
 * (a blocked or broken route to Ollama's storage host) hands over to the GGUF copy in about a
 * minute instead of retrying for many minutes.
 */
const PULL_IDLE_MS = Math.max(15, Number(process.env.FRIDAY_OLLAMA_PULL_IDLE_S) || 60) * 1000;

/**
 * Totals across the layers of one pull. Ollama reports each layer (the weights, the template, the licence) with its
 * own `digest`, `total` and `completed`; the bar needs the whole model: bytes done and total, speed, time left.
 * `now` is injectable so the speed is testable.
 */
function pullMeter(now = Date.now) {
  const layers = new Map();
  const started = now();
  let lastAt = started;
  let lastBytes = 0;
  let speed = 0; // bytes per second, smoothed
  return (row) => {
    const key = String(row.digest || "layer");
    const prev = layers.get(key) || { total: 0, completed: 0 };
    layers.set(key, {
      total: Math.max(prev.total, Number(row.total) || 0),
      completed: Math.max(prev.completed, Number(row.completed) || 0),
    });
    let total = 0;
    let done = 0;
    for (const layer of layers.values()) {
      total += layer.total;
      done += Math.min(layer.completed, layer.total || layer.completed);
    }
    const at = now();
    if (at - lastAt >= 500 && done >= lastBytes) {
      const instant = ((done - lastBytes) / (at - lastAt)) * 1000;
      speed = speed > 0 ? speed * 0.7 + instant * 0.3 : instant;
      lastAt = at;
      lastBytes = done;
    }
    const left = speed > 0 && total > done ? Math.round((total - done) / speed) : 0;
    return {
      progress: total > 0 ? (done / total) * 100 : 0,
      bytesDone: done,
      bytesTotal: total,
      ...(speed > 0 ? { speedMbps: Number((speed / 1024 ** 2).toFixed(1)) } : {}),
      ...(left > 0 ? { etaSeconds: left } : {}),
    };
  };
}

/** Stream POST /api/pull and report size, speed and time left; resolves ok when the daemon says success. */
async function ollamaPull(tag, { fetchImpl = fetch, onEvent, idleMs = PULL_IDLE_MS } = {}) {
  const meter = pullMeter();
  const guard = new AbortController();
  let timer = null;
  let idled = false;
  const rearm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      idled = true;
      guard.abort();
    }, idleMs);
  };
  try {
    rearm();
    const res = await fetchImpl(`${OLLAMA_API}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: tag, stream: true }),
      signal: guard.signal,
    });
    if (!res.ok || !res.body) return { ok: false, error: `HTTP ${res.status}` };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let ok = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rearm();
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (!line) continue;
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        if (row.error) return { ok: false, error: String(row.error) };
        if (row.status === "success") ok = true;
        if (row.total > 0 && row.completed >= 0) onEvent?.(meter(row));
      }
    }
    return ok ? { ok: true } : { ok: false, error: "the pull ended without success" };
  } catch (err) {
    if (idled) return { ok: false, error: `no progress for ${Math.round(idleMs / 1000)}s` };
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** The first .gguf file in a folder, or "" when there is none. */
function firstGguf(dir) {
  try {
    const name = fs.readdirSync(dir).find((entry) => entry.toLowerCase().endsWith(".gguf"));
    return name ? path.join(dir, name) : "";
  } catch {
    return "";
  }
}

/** Status lines from registering a GGUF with Ollama, each said once (the file read repeats a percentage). */
function statusPrinter(log, id) {
  const said = new Set();
  return (event) => {
    const note = String(event?.status || "").replace(/\s+\d+%$/, "");
    if (!note || said.has(note)) return;
    said.add(note);
    log(`[friday] ${id.padEnd(14)} ${note.slice(0, 200)}`);
  };
}

/** What Ollama holds: `{ name, size }` rows, or null when it does not answer (the plan then treats it as none installed). */
async function ollamaInstalled(fetchImpl) {
  try {
    const res = await fetchImpl(`${OLLAMA_API}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    const body = await res.json();
    return (body.models || [])
      .map((row) => ({ name: String(row.name || row.model || ""), size: Number(row.size) || 0 }))
      .filter((row) => row.name);
  } catch {
    return null;
  }
}

/**
 * The chat step of this PC's plan as the models to pull: `pull` is the one tier tag; `keep` and `offer-upgrade` leave the
 * installed model in use (never deleted, never pulled over; an offer is only said); `defer` and `none` are a note, not a
 * failure. The recorded Ollama settings are printed as data: FRIDAY applies them when it starts or calls Ollama.
 */
function chatTargets(chat, log, rows) {
  const say = (kind, line) => log(`[friday] ${kind.padEnd(8)} ${line}`);
  const inUse = chat.use || chat.tag || "";
  if (chat.settings && (chat.tag || chat.use)) {
    const o = chat.settings.options || {};
    say(
      "INFO",
      `Ollama settings for ${inUse}: context ${o.num_ctx ?? "default"}, keep loaded ${chat.settings.keep_alive || "default"} (recorded as data; FRIDAY applies them when it starts or calls Ollama, never to your own setup)`,
    );
  }
  if (chat.action === "pull" && chat.tag)
    return [{ tag: chat.tag, role: "chat model for this PC" }];
  if (chat.action === "keep" || chat.action === "offer-upgrade") {
    say(
      "ok",
      `${inUse} is already installed and stays the chat model; nothing is pulled or deleted`,
    );
    if (chat.action === "offer-upgrade")
      say(
        "INFO",
        `${chat.offer} is a better fit for this PC; pull it from the Models page when you want it`,
      );
    rows.push({ id: inUse, ok: true, downloaded: false, kept: true });
    return [];
  }
  if (chat.action === "defer") {
    say(
      "INFO",
      `chat model ${chat.tag || ""} is not pulled now: ${chat.deferReason || chat.reason}; setup goes on and the Doctor pulls it later`,
    );
    rows.push({ id: chat.tag || "chat-model", ok: true, downloaded: false, deferred: true });
    return [];
  }
  say("INFO", `no chat model is planned for this PC: ${chat.reason || "nothing fits"}`);
  return [];
}

/**
 * Install Ollama from the pinned, already verified installer, start it, and pull
 * the lite models. Every step is injectable and none throws.
 */
async function ensureOllama(root, row, { log = console.log, deps = {} } = {}) {
  const fetchImpl = deps.fetch || fetch;
  const exists = deps.exists || fs.existsSync;
  const rows = [];
  let have = await ollamaUp(fetchImpl);
  if (!have) {
    const installer = row?.ready;
    const exe =
      deps.ollamaExe ||
      findOllama({ exists })?.exe ||
      path.join(process.env.LOCALAPPDATA || "", "Programs", "Ollama", "ollama.exe");
    if (!exists(exe)) {
      if (!installer || !exists(installer)) {
        log(
          "[friday] INFO     ollama not installed (installer missing); install it from Install Manager",
        );
        return [{ id: "ollama", ok: false, error: "installer missing" }];
      }
      const signed = deps.signed ? await deps.signed(installer) : { ok: true };
      if (!signed.ok) {
        log(
          `[friday] INFO     ollama installer skipped (signature: ${signed.reason || "not valid"})`,
        );
        return [{ id: "ollama", ok: false, error: "signature" }];
      }
      log("[friday] installing Ollama for this user (no administrator)");
      const ran = await (deps.runInstaller || runInstaller)(installer);
      if (!ran.ok) {
        log(`[friday] INFO     ollama install did not finish (${ran.error}); use Install Manager`);
        return [{ id: "ollama", ok: false, error: ran.error }];
      }
    }
    await (deps.startOllama || startOllama)(exe);
    for (let i = 0; i < (deps.waitTries ?? 30) && !have; i += 1) {
      have = await ollamaUp(fetchImpl);
      if (!have) await new Promise((resolve) => setTimeout(resolve, deps.waitMs ?? 2000));
    }
    if (!have) {
      log("[friday] INFO     ollama installed but not answering yet; FRIDAY starts it on launch");
      return [{ id: "ollama", ok: false, error: "not answering" }];
    }
  }
  rows.push({ id: "ollama", ok: true });
  // The chat model is this PC's plan (electron/setup-plan.cjs). Ollama is up now, so what it really holds is read and
  // the plan's chat step is taken again: a model already installed that is at least as good is kept, never pulled over.
  let chat = deps.chat || null;
  if (chat && typeof deps.rechat === "function") {
    const held = await ollamaInstalled(fetchImpl);
    if (held) {
      try {
        const again = deps.rechat(held);
        if (again && again.action !== chat.action)
          log(
            `[friday] INFO     chat model: ${again.action} ${again.use || again.tag || ""} - ${again.reason}`,
          );
        if (again) chat = again;
      } catch {
        /* the first plan stands */
      }
    }
  }
  const models = chat ? chatTargets(chat, log, rows) : deps.models || OLLAMA_MODELS;
  const ramGb = deps.ramGb ?? deps.totalGb ?? os.totalmem() / 1024 ** 3;
  const skip = new Set(
    String(deps.skipOptional ?? process.env.FRIDAY_PREFETCH_CHAT_SMART ?? "").trim() === "0"
      ? models.filter((m) => m.optional).map((m) => m.tag)
      : [],
  );
  // The light model comes first; the bigger ones are pulled after it, only on a PC with the memory.
  for (const model of models) {
    if (skip.has(model.tag)) continue;
    if (model.minRamGb && ramGb < model.minRamGb) {
      log(
        `[friday] INFO     ${model.tag} skipped: needs ${model.minRamGb} GB RAM, this PC has ${Math.floor(ramGb)}`,
      );
      rows.push({ id: model.tag, ok: true, downloaded: false, skipped: true });
      continue;
    }
    if (have.has(model.tag)) {
      log(`[friday] ok       ${model.tag} already in Ollama; verified, not pulled again`);
      rows.push({ id: model.tag, ok: true, downloaded: false });
      continue;
    }
    // The same model as a GGUF already on this PC (an earlier run fetched it) is handed to Ollama
    // under its tag: nothing is downloaded, and a registry that cannot be reached is not asked.
    const local = deps.localGguf ? deps.localGguf(model) : "";
    if (local) {
      log(`[friday] registering the GGUF already on disk as ${model.tag} (nothing to download)`);
      const registered = await (deps.register || registerGguf)(
        model.tag,
        local,
        statusPrinter(log, model.tag),
      );
      if (registered.ok) {
        log(`[friday] ok       ${model.tag} registered with Ollama from the GGUF file`);
        rows.push({ id: model.tag, ok: true, downloaded: false, via: "gguf" });
        continue;
      }
      log(
        `[friday] INFO     ${model.tag} could not be registered from the file (${registered.error}); trying Ollama's registry`,
      );
    }
    log(`[friday] pulling ${model.tag} (${model.role})`);
    let result;
    const progress = printer(log, model.tag);
    try {
      result = await (deps.pull || ollamaPull)(model.tag, {
        fetchImpl,
        onEvent: progress,
      });
    } catch (err) {
      result = { ok: false, error: String((err && err.message) || err) };
    }
    progress.end();
    if (result.ok) rows.push({ id: model.tag, ok: true, downloaded: true });
    else {
      log(
        `[friday] INFO     ${model.tag} not pulled (${result.error}); FRIDAY pulls it on first use`,
      );
      rows.push({
        id: model.tag,
        ok: false,
        error: result.error,
        ...(model.optional ? { optional: true } : {}),
      });
    }
  }
  // The light model is the voice model: prove it loads and answers, as a note (a slow first load is not a failure).
  const answerTag = chat ? chat.use || chat.tag : models[0]?.tag;
  const light = rows.find((row) => row.id === answerTag && row.ok && !row.skipped);
  if (light && !deps.skipAnswerCheck) {
    const answer = await (deps.answers || ollamaAnswers)(light.id, fetchImpl);
    if (answer.ok) log(`[friday] ok       ${light.id} loaded and answered a test prompt`);
    else {
      log(
        `[friday] INFO     ${light.id} is pulled but did not answer a test prompt (${answer.error}); Doctor checks it again`,
      );
      rows.push({ id: "ollama-answers", ok: false, error: answer.error, optional: true });
    }
  }
  return rows;
}

/** The pinned Ollama installer is Inno Setup: the standard silent switches apply. */
function runInstaller(file, extraArgs = []) {
  return new Promise((resolve) => {
    const { spawn } = require("node:child_process");
    const child = spawn(file, ["/VERYSILENT", "/NORESTART", "/SUPPRESSMSGBOXES", ...extraArgs], {
      stdio: "ignore",
      windowsHide: true,
    });
    const timer = setTimeout(
      () => {
        child.kill();
        resolve({ ok: false, error: "timed out after 10 minutes" });
      },
      10 * 60 * 1000,
    );
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true } : { ok: false, error: `exit code ${code}` });
    });
  });
}

function startOllama(exe) {
  const { spawn } = require("node:child_process");
  try {
    const child = spawn(fs.existsSync(exe) ? exe : "ollama", ["serve"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* the probe below reports it */
  }
}

/**
 * Bring an installed Ollama up to the newest official release. The release's own SHA-256 is checked by the
 * downloader and its Authenticode signature before it runs; the installer then replaces the old files in
 * place (it closes a running Ollama itself). Never throws, and a failure leaves the installed Ollama alone.
 */
async function updateOllama({ root, newest, current, fetchModel, log, deps = {} }) {
  if (!newest?.url || !newest.sha256) {
    log(
      `[friday] INFO     ollama ${newest?.tag || "a newer release"} is available, but its official digest could not be read; the installed ${current} stays`,
    );
    return { ok: false, error: "no digest" };
  }
  const dir = path.join(root, "runtime", "installers");
  let asset = "OllamaSetup.exe";
  try {
    asset = path.basename(new URL(newest.url).pathname) || asset;
  } catch {
    /* the default name is fine */
  }
  const file = path.join(dir, "ollama", asset);
  const row = {
    ready: file,
    job: {
      modelId: "ollama",
      dir,
      sources: [
        {
          kind: "url",
          url: newest.url,
          sha256: newest.sha256,
          bytes: newest.bytes,
          label: `Ollama ${newest.tag} (latest official release)`,
        },
      ],
    },
  };
  log(
    `[friday] updating Ollama ${current || "(version unknown)"} -> ${String(newest.tag).replace(/^v/, "")}${newest.bytes ? ` (${(newest.bytes / 1024 ** 3).toFixed(1)} GB installer, checked against the published SHA-256)` : ""}`,
  );
  if (!alreadyThere(row)) {
    const progress = printer(log, "ollama-update");
    let got;
    try {
      got = await fetchModel(row.job, progress, undefined);
    } catch (err) {
      got = { ok: false, error: String((err && err.message) || err) };
    }
    progress.end();
    if (!got || !got.ok) {
      const why = (got && got.error) || "download failed";
      log(
        `[friday] INFO     ollama ${newest.tag} was not downloaded (${why}); the installed ${current} stays`,
      );
      return { ok: false, error: why };
    }
  }
  const signed = deps.signed ? await deps.signed(file) : { ok: true };
  if (!signed.ok) {
    log(`[friday] INFO     ollama update skipped (signature: ${signed.reason || "not valid"})`);
    return { ok: false, error: "signature" };
  }
  const ran = await (deps.runInstaller || runInstaller)(file, ["/CLOSEAPPLICATIONS"]);
  if (!ran.ok) {
    log(
      `[friday] INFO     ollama update did not finish (${ran.error}); the installed version stays`,
    );
    return { ok: false, error: ran.error };
  }
  const fetchImpl = deps.fetch || fetch;
  await (deps.startOllama || startOllama)(deps.ollamaExe || "ollama");
  let up = null;
  for (let i = 0; i < (deps.waitTries ?? 30) && !up; i += 1) {
    up = await ollamaUp(fetchImpl);
    if (!up) await new Promise((resolve) => setTimeout(resolve, deps.waitMs ?? 2000));
  }
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* a kept installer only costs disk */
  }
  // One spelling of a version on both sides (`0.40.16 -> 0.40.17`), as Doctor prints it.
  log(
    `[friday] ok       ollama updated to ${String(newest.tag).replace(/^v/, "")}${up ? "" : "; it starts with FRIDAY"}`,
  );
  return { ok: true };
}

/** Is an Ollama already on this PC? Running, on PATH, or in a standard folder. */
async function detectOllama({ fetchImpl = fetch, find = findOllama } = {}) {
  const running = Boolean(await ollamaUp(fetchImpl));
  const local = find();
  return {
    installed: running || Boolean(local),
    running,
    exe: local?.exe || "",
    version: local?.version || null,
  };
}

/** Point the installer job at the newest official release (digest-verified), else keep the pin. */
async function useLatestInstaller(row, latest) {
  const release = await latest("ollama");
  if (!release?.url || !release.sha256) return release;
  const sources = row.job.sources;
  sources[0] = {
    ...sources[0],
    url: release.url,
    sha256: release.sha256,
    bytes: release.bytes,
    label: `Ollama ${release.tag} (${release.source === "live" ? "latest official release" : "official release"})`,
  };
  if (sources[1]) sources[1] = { ...sources[1], sha256: release.sha256, bytes: release.bytes };
  return release;
}

/**
 * English streaming speech (Moonshine tiny, MIT). It is the fastest way to turn English into text while the
 * owner is still talking, but it was never fetched: the kernel looks for it in `<root>/models/moonshine-en`
 * and, finding nothing, quietly used the slower whisper path for every English turn. The publisher's own
 * Python package knows the official file list, sizes and checksums, so it does the download into that folder.
 */
const MOONSHINE_DIR = ["models", "moonshine-en"];
const MOONSHINE_SCRIPT = [
  "import sys",
  "from pathlib import Path",
  "from moonshine_voice import ModelArch, get_model_for_language",
  "path, arch = get_model_for_language('en', ModelArch.TINY_STREAMING, cache_root=Path(sys.argv[1]))",
  "print('MOONSHINE_OK', path)",
].join("\n");

/** The same test the kernel uses (kernel/stt.py moonshine_model_dir): real model files, not a stub. */
function moonshineReady(dir) {
  const walk = (folder, depth) => {
    let found = 0;
    let entries = [];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (depth < 8) found += walk(full, depth + 1);
      } else if (/\.(onnx|ort)$/i.test(entry.name)) {
        try {
          if (fs.statSync(full).size >= 100_000) found += 1;
        } catch {
          /* unreadable file */
        }
      }
    }
    return found;
  };
  return walk(dir, 0) > 0;
}

/** Fetch the English streaming weights with the venv Python. Returns one result row; never throws. */
async function fetchMoonshine(root, { env = process.env, log = console.log, run } = {}) {
  const dir = path.join(root, ...MOONSHINE_DIR);
  if (moonshineReady(dir)) {
    log("[friday] ok       moonshine-en verified on disk; not downloaded again");
    return { id: "moonshine-en", ok: true, downloaded: false };
  }
  const python = require("./explicit-python.cjs").explicitPython(env.FRIDAY_PYTHON);
  if (!python) {
    log(
      "[friday] INFO     moonshine-en skipped: no Python runtime yet (npm run setup:python fetches it)",
    );
    return { id: "moonshine-en", ok: true, downloaded: false, skipped: true };
  }
  log("[friday] fetching moonshine-en (English streaming speech)");
  const runIt =
    run ||
    ((exe, args, options) =>
      new Promise((resolve) => {
        const child = require("node:child_process").spawn(exe, args, {
          env: options.env,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        child.stdout.on("data", (chunk) => (out = (out + chunk).slice(-4000)));
        child.stderr.on("data", (chunk) => (out = (out + chunk).slice(-4000)));
        const timer = setTimeout(() => child.kill(), options.timeout);
        // The download prints nothing until it ends, so a proof-of-life line says it is still working.
        const ticker = require("./electron-module.cjs")
          .load("activity.cjs")
          .startTicker({ label: "moonshine-en", watch: [dir], write: (line) => log(line) });
        child.on("error", (error) => {
          clearTimeout(timer);
          ticker.stop();
          resolve({ status: -1, stdout: out, stderr: "", error });
        });
        child.on("close", (status) => {
          clearTimeout(timer);
          ticker.stop();
          resolve({ status, stdout: out, stderr: "" });
        });
      }));
  const ran = await runIt(python, ["-c", MOONSHINE_SCRIPT, dir], {
    encoding: "utf8",
    timeout: 20 * 60 * 1000,
    env: { ...env, PYTHONIOENCODING: "utf-8" },
  });
  const text = `${ran.stdout || ""}${ran.stderr || ""}`;
  if (ran.status === 0 && moonshineReady(dir)) {
    log("[friday] ok       moonshine-en (publisher download, English streaming speech)");
    return { id: "moonshine-en", ok: true, downloaded: true };
  }
  const why = (
    ran.error
      ? String(ran.error.message || ran.error)
      : text.trim().split(/\r?\n/).slice(-2).join(" ")
  ).slice(0, 220);
  log(`[friday] FAIL     moonshine-en was not downloaded (${why || "no files arrived"})`);
  return { id: "moonshine-en", ok: false, error: why || "no files arrived" };
}

/** Run every job; returns one row per job. Never throws. */
async function prefetch(
  root,
  {
    env = process.env,
    log = console.log,
    download,
    platform = process.platform,
    ollama,
    latest = localLibrary.latestOfficialRelease,
    totalGb,
    freshnessFetch,
    policyRoot,
    moonshine,
    board,
    llama,
    probe,
    facts,
    thisPc,
    installedModels,
    quietPlan = false,
  } = {},
) {
  const rows = [];
  const wantOllama = platform === "win32" && enabled(env, "FRIDAY_PREFETCH_OLLAMA");
  let existing = { installed: false };
  if (wantOllama && root) {
    try {
      existing = await detectOllama({ fetchImpl: ollama?.fetch || fetch, find: ollama?.find });
    } catch {
      existing = { installed: false };
    }
  }
  const ramGb = totalGb ?? os.totalmem() / 1024 ** 3;
  // THIS PC decides everything that is hardware-bound, in one plan (electron/setup-plan.cjs): the chat model, the
  // speech sizes (the voice profile), llama.cpp and the packages. A caller that injects its own downloader (the tests)
  // gets the plain list unless it also hands over a probe, facts or a plan; FRIDAY_PREFETCH_VOICE_BUDGET=0 keeps the
  // plain speech list.
  let voicePlan = null;
  let plan = null;
  let made = null;
  const active = Boolean(root) && prefetchPlan(root, env, platform).length > 0;
  if (active && (probe || facts || thisPc || !download)) {
    try {
      made =
        thisPc ||
        (await thisPcPlan(root, {
          env,
          fetchImpl: ollama?.fetch || fetch,
          ...(facts ? { facts } : {}),
          ...(probe ? { probe } : {}),
          ...(installedModels ? { installedModels } : {}),
        }));
      plan = made.plan;
      voicePlan = enabled(env, "FRIDAY_PREFETCH_VOICE_BUDGET") ? made.voicePlan : null;
    } catch (err) {
      log(
        `[friday] INFO     this PC's plan could not be made (${String((err && err.message) || err)}); using the plain list`,
      );
    }
  }
  const have = {
    ollama: existing.installed,
    plan: voicePlan,
    ...(plan?.llama ? { llama: plan.llama } : {}),
    ...(active && !voicePlan ? { blocked: plainBlocked(root, ramGb) } : {}),
  };
  const jobs = prefetchPlan(root, env, platform, have);
  if (!jobs.length) {
    log("[friday] model prefetch skipped");
    return rows;
  }
  // Setup prints the block itself, ahead of its Python step (FRIDAY_PLAN_PRINTED=1), and a retry round does not repeat it.
  if (plan && !quietPlan && String(env.FRIDAY_PLAN_PRINTED ?? "") !== "1")
    for (const line of setupPlan.describePlan(plan)) log(line);
  if (
    plan?.llama?.install &&
    plan.llama.install.backend !== "cpu" &&
    plan.llama.action !== "present"
  )
    log(
      `[friday] INFO     llama.cpp: setup installs the pinned CPU build; the ${plan.llama.install.backend} build this PC qualifies for is installed from the Install Manager (Engines), with a hash check and a fallback`,
    );
  if (voicePlan && !quietPlan) {
    // A skipped speech size that has its own job is named once, by that job, when the run reaches it.
    const sizeLines = new Set(
      voicePlan.blocked
        .filter((row) => jobs.some((job) => job.id === `stt-${row.size}`))
        .map((row) => row.line),
    );
    for (const line of voicePlan.lines) if (!sizeLines.has(line)) log(line);
  }
  const installer = jobs.find((row) => row.kind === "installer");
  if (installer) {
    try {
      await useLatestInstaller(installer, latest);
    } catch {
      /* the pinned, verified release stays */
    }
  }
  if (existing.installed) {
    log(
      `[friday] ok       ollama ${existing.version || "(version unknown)"} already installed${existing.exe ? ` at ${existing.exe}` : " and running"}; using it, nothing to download`,
    );
  }
  const updateOllamaLast = async () => {
    if (!existing.installed) return;
    try {
      const newest = await latest("ollama");
      const newer =
        existing.version && newest?.tag && localLibrary.newerTag(newest.tag, existing.version);
      const how = updatePolicy.mode(env);
      const policy = { env, ...(policyRoot ? { root: policyRoot } : {}) };
      if (
        newer &&
        how !== "off" &&
        enabled(env, "FRIDAY_AUTO_INSTALL") &&
        updatePolicy.due("ollama", policy)
      ) {
        const updated = await updateOllama({
          root,
          newest,
          current: existing.version,
          fetchModel: download || require("../electron/model-download.cjs").downloadModel,
          log,
          deps: {
            signed: async (file) =>
              require("../electron/download-safety.cjs").authenticodeStatus(file),
            ...(existing.exe ? { ollamaExe: existing.exe } : {}),
            ...ollama,
          },
        });
        if (updated.ok) updatePolicy.markChecked("ollama", policy);
      } else if (newer) {
        log(
          how === "off"
            ? `[friday] INFO     ollama ${newest.tag} is available; updates are switched off here (FRIDAY_SETUP_UPDATE=0, hosted CI or offline)`
            : `[friday] INFO     ollama ${newest.tag} is available; the update check runs once a day (FRIDAY_SETUP_UPDATE=1 checks now)`,
        );
      } else if (existing.version && newest?.tag) {
        log(`[friday] ok       ollama ${existing.version} is the latest official release`);
        if (how !== "off") updatePolicy.markChecked("ollama", policy);
      }
    } catch {
      /* the version note is optional */
    }
  };
  const uiRef = { current: null };
  const fetchModel = download || require("../electron/model-download.cjs").downloadModel;
  // The English streaming speech is small and comes from its own host, so it downloads beside the big files.
  const moonshineRun = enabled(env, "FRIDAY_PREFETCH_MOONSHINE")
    ? fetchMoonshine(root, {
        env,
        log: (line) => (uiRef.current ? uiRef.current.say(line) : log(line)),
        ...(moonshine ? { run: moonshine } : {}),
      })
    : null;
  // The speech, voice and chat files are independent, so several download at once: one
  // connection per file rarely fills a fast line. Rows keep their order in the result.
  const parallel = prefetchParallelism(env);
  // Asked only for a real run: a caller that injects its own downloader (the tests) stays offline.
  const checkFreshness =
    (!download || Boolean(freshnessFetch)) && env.FRIDAY_MODEL_FRESHNESS !== "0";
  const sizeText = (bytes) =>
    bytes >= 1024 ** 3
      ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
      : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  // A real run in a terminal gets the live board; a log file gets a line per ten percent and an overall line.
  const ui =
    board !== undefined
      ? board
      : download
        ? null
        : new DownloadBoard({ ...(log !== console.log ? { log } : {}) });
  uiRef.current = ui;
  const say = ui ? (line) => ui.say(line) : log;
  if (ui) {
    ui.start(jobs.map((row) => ({ id: row.id, approxBytes: APPROX_BYTES[row.id] || 0 })));
  }
  const outcomes = await mapPool(jobs, parallel, async (row) => {
    if (alreadyThere(row)) {
      // One listing request per repository says whether a file here has changed upstream. A network that
      // cannot answer keeps the folder as it is.
      const stale = checkFreshness
        ? await require("../electron/model-freshness.cjs").staleFor(row, {
            ...(freshnessFetch ? { fetchImpl: freshnessFetch } : {}),
          })
        : [];
      if (!stale.length) {
        if (ui)
          ui.finish(row.id, {
            ok: true,
            note: "already on disk, not downloaded again",
            bytes: bytesOnDisk(row.ready),
          });
        else log(`[friday] ok       ${row.id} verified on disk; not downloaded again`);
        return { id: row.id, ok: true, downloaded: false };
      }
      say(`[friday] update   ${row.id}: ${stale.length} file(s) changed upstream, fetching them`);
    }
    if (row.skipReason) {
      if (ui) ui.finish(row.id, { ok: true, note: `skipped: ${row.skipReason}`.slice(0, 80) });
      say(`[friday] INFO     ${row.id} skipped: ${row.skipReason}`);
      return { id: row.id, ok: true, downloaded: false, skipped: true };
    }
    if (!ui) log(`[friday] fetching ${row.id}`);
    let result;
    const progress = ui
      ? Object.assign(
          (event) => {
            const note = String(event?.status || "");
            if (
              event?.progress == null &&
              /did not finish|source failed|using FRIDAY's own/i.test(note)
            )
              ui.say(`[friday] ${row.id.padEnd(14)} ${note.slice(0, 200)}`);
            else ui.update(row.id, event);
          },
          { end() {} },
        )
      : printer(log, row.id, parallel > 1);
    const startedAt = Date.now();
    try {
      result = await fetchModel(row.job, progress, undefined);
    } catch (err) {
      result = { ok: false, error: String((err && err.message) || err) };
    }
    progress.end();
    const seconds = Math.max(1, (Date.now() - startedAt) / 1000);
    if (result && result.ok) {
      if (row.kind === "tts") {
        try {
          fs.mkdirSync(path.dirname(row.ready), { recursive: true });
          fs.writeFileSync(row.ready, new Date().toISOString());
        } catch {
          /* without the marker the next run only checks the files again */
        }
      }
      const average =
        Number(result.bytes) > 0 ? (result.bytes / 1024 ** 2 / seconds).toFixed(1) : "";
      const sized =
        Number(result.bytes) > 0
          ? `, ${sizeText(result.bytes)} in ${Math.round(seconds)}s, ${average} MB/s on average${result.engine === "hub" ? ", Hugging Face client" : ""}`
          : "";
      if (ui) {
        ui.finish(row.id, {
          ok: true,
          bytes: Number(result.bytes) || 0,
          note: `${average ? `${average} MB/s average` : "ready"}${result.engine === "hub" ? " (Hugging Face client)" : ""}`,
        });
      } else {
        log(`[friday] ok       ${row.id} (${result.source || result.via || "downloaded"}${sized})`);
      }
      return { id: row.id, ok: true, downloaded: true };
    }
    const why = (result && result.error) || "download failed";
    if (row.optional) {
      // An optional piece (a helper with a built-in fallback, a size this PC does not need) is a note: setup goes on.
      if (ui) ui.finish(row.id, { ok: true, note: `optional, not installed: ${why}`.slice(0, 80) });
      say(
        `[friday] NOTE     ${
          typeof row.failureLine === "function"
            ? row.failureLine(result)
            : `${row.id} did not download (${why}); optional, setup goes on`
        }`,
      );
      return { id: row.id, ok: false, error: why, optional: true };
    }
    if (ui) ui.finish(row.id, { ok: false, note: String(why).slice(0, 80) });
    say(`[friday] FAIL     ${row.id} was not downloaded (${why})`);
    return { id: row.id, ok: false, error: why };
  });
  if (ui) ui.stop();
  uiRef.current = null;
  rows.push(...outcomes);
  // llama.cpp: the zip is downloaded and checked above; here it is unpacked into FRIDAY's engines folder.
  const llamaJob = jobs.find((row) => row.kind === "archive");
  if (llamaJob) {
    const fetched = outcomes.find((row) => row.id === llamaJob.id);
    if (fetched && !fetched.ok) {
      /* the download failure is already in the rows */
    } else if (llamaRuntime.installed(root)) {
      log(`[friday] ok       llama.cpp already installed at ${llamaRuntime.findServer(root)}`);
    } else {
      const put = await llamaRuntime.installFromZip(root, llamaJob.ready, llamaJob.tag, {
        ...(llama?.extract ? { run: llama.extract } : {}),
        ...(env.FRIDAY_PYTHON ? { python: env.FRIDAY_PYTHON } : {}),
      });
      if (put.ok) log(`[friday] ok       llama.cpp ${llamaJob.tag} installed (${put.server})`);
      else log(`[friday] FAIL     llama.cpp was not installed (${put.error})`);
      const at = rows.findIndex((row) => row.id === llamaJob.id);
      if (!put.ok && at >= 0) rows[at] = { id: llamaJob.id, ok: false, error: put.error };
    }
  }
  let ollamaRows = [];
  if (wantOllama && enabled(env, "FRIDAY_AUTO_INSTALL")) {
    const fetched = installer ? rows.find((row) => row.id === installer.id) : null;
    if (existing.installed || fetched?.ok || (installer && alreadyThere(installer))) {
      try {
        ollamaRows = await ensureOllama(root, installer || null, {
          log,
          deps: {
            signed: async (file) =>
              require("../electron/download-safety.cjs").authenticodeStatus(file),
            ramGb,
            skipOptional: env.FRIDAY_PREFETCH_CHAT_SMART,
            // The chat model is the plan's tier for this PC; with no plan the configured light model is pulled as before.
            // The downloaded GGUF is the light model only; a bigger tier must never be registered from it.
            localGguf: (model) =>
              model?.tag === OLLAMA_MODELS[0]?.tag ? firstGguf(chatJob(root).ready) : "",
            ...(plan ? { chat: plan.chat, ...(made?.rechat ? { rechat: made.rechat } : {}) } : {}),
            ...(existing.exe ? { ollamaExe: existing.exe } : {}),
            ...ollama,
          },
        });
      } catch (err) {
        const why = String((err && err.message) || err);
        log(`[friday] FAIL     ollama setup did not finish (${why})`);
        ollamaRows = [{ id: "ollama", ok: false, error: why }];
      }
    }
  }
  // The chat model comes from Ollama's registry when that works. When it cannot (a blocked or broken route to the
  // registry) and this PC has the memory for it, the light Qwen is taken as a GGUF through FRIDAY's own multi-connection
  // downloader, then handed to Ollama under the tag FRIDAY routes to. Only a model that is in neither place is a failure,
  // so a registry timeout no longer stops the setup. With this PC's plan the fallback is tried only when the plan
  // wanted a pull, the pull failed, and the plan's usable memory fits that GGUF (never a bigger model than the PC carries).
  const small = OLLAMA_MODELS[0]?.tag;
  const ggufNeedGb = (APPROX_BYTES["qwen3-4b"] * 1.2) / 1024 ** 3;
  const planned = plan?.chat;
  const failedTag = planned ? (planned.action === "pull" ? planned.tag : "") : small;
  const fallbackAllowed =
    !planned || (planned.action === "pull" && Number(planned.memory?.usableGb) >= ggufNeedGb);
  const provides = (row) =>
    planned
      ? row.ok && row.id !== "ollama" && row.id !== "ollama-answers"
      : row.id === small && row.ok;
  let provided = failedTag ? ollamaRows.some(provides) : true;
  const extra = [];
  const chatWanted =
    ollamaServesChat(env, platform) && enabled(env, "FRIDAY_PREFETCH_CHAT") && fallbackAllowed;
  if (chatWanted && !provided) {
    const gguf = chatJob(root);
    let onDisk = alreadyThere(gguf);
    if (!onDisk) {
      log(
        `[friday] INFO     ${failedTag || "the chat model"} is not in Ollama; fetching the light Qwen GGUF copy (${small})`,
      );
      let result;
      const progress = printer(log, gguf.id);
      try {
        result = await fetchModel(gguf.job, progress, undefined);
      } catch (err) {
        result = { ok: false, error: String((err && err.message) || err) };
      }
      progress.end();
      onDisk = Boolean(result && result.ok);
      extra.push(
        onDisk
          ? { id: gguf.id, ok: true, downloaded: true }
          : { id: gguf.id, ok: false, error: (result && result.error) || "download failed" },
      );
    }
    const file = onDisk ? firstGguf(gguf.ready) : "";
    if (file && small && ollamaRows.some((row) => row.id === "ollama" && row.ok)) {
      const registered = await (ollama?.register || registerGguf)(
        small,
        file,
        statusPrinter(log, small),
      );
      if (registered.ok) {
        provided = true;
        log(`[friday] ok       ${small} registered with Ollama from the GGUF file`);
        extra.push({ id: small, ok: true, downloaded: false, via: "gguf" });
      } else {
        log(
          `[friday] INFO     ${small} is on disk as a GGUF file; Ollama did not register it (${registered.error}). FRIDAY loads the file with its own runner, and npm run doctor registers it again`,
        );
        provided = true;
        extra.push({ id: small, ok: true, downloaded: false, via: "gguf-file" });
      }
    }
  }
  rows.push(
    ...ollamaRows.filter((row) => !(row.id === failedTag && !row.ok && provided)),
    ...extra,
  );
  if (moonshineRun) rows.push(await moonshineRun);
  // Last of all: a newer Ollama is a 1.6 GB installer and nothing waits on it, so every speech, voice and
  // chat file is already in place when it starts (it used to download first and hold everything else back).
  await updateOllamaLast();
  return rows;
}

/** Does a model that cannot be fetched fail the step? On by default. */
function strict(env = process.env) {
  return enabled(env, "FRIDAY_PREFETCH_STRICT");
}

/** One line per model that could not be fetched, and the way forward. Empty when all is well. */
function failureReport(rows) {
  // An optional bigger model that could not be fetched is a note, not a failed setup.
  const failed = (rows || []).filter((row) => !row.ok && !row.optional);
  if (!failed.length) return [];
  return [
    `[friday] ACTION REQUIRED  ${failed.length} model download(s) did not finish:`,
    ...failed.map(
      (row) => `[friday]   - ${row.id}: ${String(row.error || "failed").slice(0, 160)}`,
    ),
    "[friday] Check the network (a proxy or a firewall can block huggingface.co and ollama.com), then run: npm run setup:python",
    "[friday] (or npm run doctor, which repairs and checks again)",
  ];
}

module.exports = {
  STT_SIZES,
  strict,
  failureReport,
  CHAT_MODEL,
  OLLAMA_MODELS,
  prefetchPlan,
  prefetch,
  prefetchParallelism,
  ensureOllama,
  ollamaPull,
  pullMeter,
  ollamaAnswers,
  firstGguf,
  findOllama,
  startOllama,
  ollamaUp,
  detectOllama,
  ollamaServesChat,
  looksTransient,
  prefetchWithRetries,
  fetchMoonshine,
  moonshineReady,
  alreadyThere,
  bytesOnDisk,
  voiceDryRun,
  setupCudaVerdict,
  setupProbe,
  thisPcPlan,
  readPlanSync,
  plainBlocked,
  voiceJobId,
  PLAN_JSON,
  MOONSHINE_DIR,
};

/** Does this failure look like the network dropping out for a moment, rather than a file that is wrong? */
function looksTransient(error) {
  return /offline|no such host|getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ECONNREFUSED|timed? ?out|stalled|no byte|did not finish|socket|network|TLS|503|502|504|429/i.test(
    String(error || ""),
  );
}

/**
 * Run the whole step, and when something failed only because the line dropped out (a DNS blip, a Wi-Fi
 * reconnect) wait and run it again: every piece already on disk is only verified, so a second round fetches
 * just what is missing. Three more rounds with growing waits cover a short outage without anyone typing a command.
 */
async function prefetchWithRetries(root, options = {}, { wait, rounds } = {}) {
  const env = (options && options.env) || process.env;
  const maxExtra = Number.isFinite(rounds)
    ? rounds
    : Math.max(0, Math.min(6, Math.floor(Number(env.FRIDAY_PREFETCH_RETRIES ?? 3))));
  const sleep = wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = (options && options.log) || console.log;
  let rows = await prefetch(root, options);
  for (let round = 1; round <= maxExtra; round += 1) {
    const failed = rows.filter((row) => !row.ok);
    if (!failed.length || !failed.every((row) => looksTransient(row.error))) break;
    const seconds = Math.min(90, 15 * 2 ** (round - 1));
    log(
      `[friday] INFO     ${failed.length} download(s) stopped on a network problem (${failed.map((row) => row.id).join(", ")}); trying again in ${seconds}s (round ${round + 1} of ${maxExtra + 1})`,
    );
    await sleep(seconds * 1000);
    rows = await prefetch(root, { ...options, quietPlan: true });
  }
  return rows;
}

/**
 * Whether the speech kernel itself finds cuBLAS 12 and cuDNN 9 (kernel/stt.py `cuda_runtime_ready`, the one verdict
 * that may pick a GPU speech size). Setup asks it once, only when the first hardware probe saw a graphics card and a
 * Python runtime exists; the driver alone never counts. Any failure, timeout or odd answer is "no": the plan then keeps
 * the CPU default and offers the CUDA libraries instead.
 */
function setupCudaVerdict(env = process.env, first, deps = {}) {
  try {
    if (!first || !first.gpu || !(Number(first.gpu.vramGb) > 0)) return false;
    const python = require("./explicit-python.cjs").explicitPython(env.FRIDAY_PYTHON);
    if (!python) return false;
    const script = path.join(__dirname, "..", "kernel", "stt.py");
    const run = deps.spawnSync || require("node:child_process").spawnSync;
    const out = run(python, [script, "--probe"], {
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
      shell: false,
      env: { ...env, FRIDAY_STT_CUDA: "1" },
    });
    if (!out || out.error || out.status !== 0) return false;
    const lines = String(out.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{"));
    for (let at = lines.length - 1; at >= 0; at -= 1) {
      try {
        const parsed = JSON.parse(lines[at]);
        if (parsed && typeof parsed === "object") return parsed.cudaRuntimeReady === true;
      } catch {
        /* an earlier line may be the JSON */
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * The voice-plan probe of this PC with the speech kernel's CUDA verdict (see setupCudaVerdict). `deps.hardwareFacts`
 * (a function returning the measured facts of electron/hardware.cjs) lets the probe read the same facts the plan uses.
 */
function setupProbe(env = process.env, deps = {}) {
  const facts =
    typeof deps.hardwareFacts === "function" ? { hardwareFacts: deps.hardwareFacts } : {};
  const first = voiceWeights.probeHardware(facts);
  const verdict = setupCudaVerdict(env, first, deps);
  return verdict ? voiceWeights.probeHardware({ ...facts, cudaRuntimeReady: true }) : first;
}

/** The measured facts of this PC (electron/hardware.cjs), or `{}` when they cannot be read: the plan then says "unknown". */
async function measureThisPc(root) {
  try {
    const hardware = require("../electron/hardware.cjs");
    const detected = await hardware.detectHardware({ root, capabilityGraceMs: 15000 });
    return hardware.hardwareFacts(detected, { freeRamGb: os.freemem() / 1024 ** 3 });
  } catch {
    return {};
  }
}

/**
 * The ONE plan of this PC (electron/setup-plan.cjs buildSetupPlan), from its measured facts, the chat models Ollama
 * already holds and what is already installed. Returns the plan, the voice install plan it was built from (the very
 * object the speech jobs read, so setup and Doctor cannot disagree), the facts, and `rechat(list)`, which plans the chat
 * step again once Ollama answers with the models it really holds. Never throws.
 */
async function thisPcPlan(root, options = {}) {
  const env = options.env || process.env;
  const facts = options.facts || (await measureThisPc(root));
  const held = options.installedModels ?? (await ollamaInstalled(options.fetchImpl || fetch)) ?? [];
  let voicePlan = null;
  const voice = {
    voiceInstallPlan: (...args) => (voicePlan = voiceWeights.voiceInstallPlan(...args)),
  };
  const deps = (installedModels) => ({
    root,
    installedModels,
    installed: {
      llama: (() => {
        try {
          return llamaRuntime.installed(root) === true;
        } catch {
          return false;
        }
      })(),
    },
    exists: options.exists || fs.existsSync,
    ...(options.statfs ? { statfs: options.statfs } : {}),
    voiceProbe: options.probe || setupProbe(env, { hardwareFacts: () => facts }),
    voiceWeights: voice,
  });
  const plan = setupPlan.buildSetupPlan(facts, deps(held));
  return {
    plan,
    voicePlan,
    facts,
    rechat: (list) => setupPlan.buildSetupPlan(facts, deps(list)).chat,
  };
}

/** Speech sizes this PC does not carry, from the same voice plan, for a run with no plan of its own (the plain list). */
function plainBlocked(root, ramGb) {
  try {
    return voiceWeights.voiceInstallPlan(
      root,
      { totalRamGb: ramGb, freeRamGb: 0, cpuThreads: 4, gpu: { name: "", vramGb: 0 } },
      { exists: () => false },
    ).blocked;
  } catch {
    return [];
  }
}

/**
 * The same plan, read by another script (the Doctor, the Python step) as plain data: this file runs itself with `--plan
 * --json`. Returns `toJSON(plan)` or null when it could not be read (the caller then keeps its old behaviour).
 */
function readPlanSync(env = process.env, deps = {}) {
  try {
    const run = deps.spawnSync || require("node:child_process").spawnSync;
    const out = run(process.execPath, [__filename, "--plan", "--json"], {
      encoding: "utf8",
      timeout: deps.timeoutMs || 120000,
      windowsHide: true,
      shell: false,
      env,
    });
    if (!out || out.error || out.status !== 0) return null;
    for (const line of String(out.stdout || "")
      .split(/\r?\n/)
      .reverse()) {
      if (!line.startsWith(PLAN_JSON)) continue;
      const parsed = JSON.parse(line.slice(PLAN_JSON.length));
      return parsed && Array.isArray(parsed.required) ? parsed : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * `node scripts/prefetch-models.cjs --voice [--dry-run]` (npm run voice:install): the voice models this PC can carry,
 * chosen from the hardware probe. `--dry-run` prints this plan and downloads nothing; without it only the voice is
 * fetched (the speech sizes, helpers, neural voice and Hindi ear), and the same plan is printed first by the run itself.
 */
function voiceDryRun(root, log = console.log) {
  const plan = voiceWeights.voiceInstallPlan(root, setupProbe(process.env), {
    exists: fs.existsSync,
  });
  for (const line of plan.lines) log(line);
  log(
    `[friday] INFO     dry run: nothing was downloaded (${Math.round(plan.downloadBytes / 1024 ** 2)} MB would be fetched)`,
  );
  return plan;
}

if (require.main === module && process.argv.includes("--plan")) {
  // `--plan` prints this PC's block and downloads nothing; `--plan --json` prints the required set the Doctor reads.
  const picked = require("./friday-root.cjs").workspaceRootOrDev({ record: false });
  const json = process.argv.includes("--json");
  thisPcPlan(picked.root, { env: process.env }).then(
    ({ plan }) => {
      if (json)
        process.stdout.write(
          `${PLAN_JSON}${JSON.stringify({ ...setupPlan.toJSON(plan), pc: plan.pc })}\n`,
        );
      else for (const line of setupPlan.describePlan(plan)) console.log(line);
    },
    (err) => {
      console.error(
        `[friday] INFO     this PC's plan could not be made: ${String((err && err.message) || err)}`,
      );
      process.exitCode = json ? 1 : 0;
    },
  );
} else if (
  require.main === module &&
  process.argv.includes("--voice") &&
  process.argv.includes("--dry-run")
) {
  voiceDryRun(require("./friday-root.cjs").workspaceRootOrDev({ record: false }).root);
} else if (require.main === module) {
  const fridayRoot = require("./friday-root.cjs");
  const picked = fridayRoot.workspaceRootOrDev();
  if (process.argv.includes("--voice")) {
    // Only the voice: the chat model, Ollama and llama.cpp belong to setup.
    Object.assign(process.env, {
      FRIDAY_PREFETCH: "1",
      FRIDAY_PREFETCH_CHAT: "0",
      FRIDAY_PREFETCH_OLLAMA: "0",
      FRIDAY_PREFETCH_LLAMACPP: "0",
    });
  }
  process.env.FRIDAY_ROOT = process.env.FRIDAY_ROOT || picked.root;
  // A FRIDAY_PYTHON that points nowhere is dropped; the kernel virtual environment is used instead.
  require("./explicit-python.cjs").dropStalePython(process.env);
  if (!process.env.FRIDAY_PYTHON) {
    try {
      const venv = require("./python-runtime.cjs").resolveVenvPython();
      if (venv && require("node:fs").existsSync(venv)) process.env.FRIDAY_PYTHON = venv;
    } catch {
      /* Moonshine is then skipped with a note, as before */
    }
  }
  if (picked.development) require("../electron/staged-assets.cjs").recordStaging(picked.root);
  // Leave through exitCode, not process.exit(): ending the process while the network layer is still closing
  // sockets makes Node on Windows abort with "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)".
  const finish = (code) => {
    process.exitCode = code;
    const force = setTimeout(() => process.exit(code), 5000);
    force.unref();
  };
  prefetchWithRetries(picked.root).then(
    (rows) => {
      const lines = failureReport(rows);
      for (const line of lines) console.error(line);
      finish(lines.length && strict() ? 1 : 0);
    },
    (err) => {
      console.error(`[friday] FAIL     model step crashed: ${String((err && err.message) || err)}`);
      finish(strict() ? 1 : 0);
    },
  );
}
