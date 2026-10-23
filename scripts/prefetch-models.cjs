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
 * folders from Models and Install Manager. A failed or offline download never
 * fails the build; it is reported and the app fetches it on first use.
 *
 * Running it again is cheap and quiet: every piece that is already on disk (and
 * matches its pinned digest where one exists) is only verified and the next one
 * is taken. `npm run setup` and `build:win` both run it, so nothing downloads twice.
 *
 * On Windows the same step also sets up Ollama. An Ollama that is already on
 * this PC (running, on PATH, or in its standard folders) is reused as it is:
 * no installer is downloaded and nothing is reinstalled. Only a missing Ollama
 * is installed per user (the newest official release, SHA-256 and Authenticode
 * checked, no administrator). It is then started and the local chat models of
 * config/local-runners.json are pulled: two light, fast ones for quick replies
 * and talking, and one larger, smarter one for long, hard work. A model Ollama
 * already holds is not pulled again, and the Qwen GGUF below is fetched only
 * when Ollama could not provide the same small model.
 *
 * Opt out: FRIDAY_PREFETCH=0 skips all of it, FRIDAY_PREFETCH_CHAT=0 skips the
 * local chat model only, FRIDAY_PREFETCH_OLLAMA=0 skips the Ollama install and pulls. Hosted CI skips it unless FRIDAY_PREFETCH=1, so a
 * workflow run does not pull gigabytes on every build.
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const voiceWeights = require("../electron/voice-weights.cjs");
const stageToolchain = require("./stage-toolchain.cjs");
const localRunners = require("../config/local-runners.json");
const localLibrary = require("../electron/local-library.cjs");

/** Ollama is the local engine FRIDAY starts and stops; the tiered models are pulled through it. */
const OLLAMA_API = "http://127.0.0.1:11434";
const OLLAMA_MODELS = localLibrary.ollamaModels();

/** Speech sizes: base starts listening fast, small is the Hindi/Hinglish default. */
const STT_SIZES = ["base", "small"];

/** A small, fast, Apache-2.0 local chat model from the publisher's own GGUF repo. */
const CHAT_MODEL = {
  id: "qwen2.5-1.5b-instruct",
  sources: [
    {
      kind: "hf-gguf",
      repo: "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
      match: ["q4_k_m", "q5_k_m", "q8_0"],
      label: "Hugging Face (Qwen official)",
    },
  ],
};

function enabled(env, key) {
  return String(env[key] ?? "1").trim() !== "0";
}

const findOllama = localLibrary.findInstalledOllama;

/** Whether this PC can hold a tier: a smart model needs the RAM its config row names. */
function modelWanted(model, env = process.env, totalGb = os.totalmem() / 1024 ** 3) {
  if (model.tier === "smart" && !enabled(env, "FRIDAY_PREFETCH_OLLAMA_SMART")) {
    return { ok: false, why: "FRIDAY_PREFETCH_OLLAMA_SMART=0" };
  }
  if (model.minRamGb && totalGb < model.minRamGb) {
    return { ok: false, why: `needs ${model.minRamGb} GB RAM, this PC has ${Math.floor(totalGb)}` };
  }
  return { ok: true, why: "" };
}

/** Ollama serves the small chat model on Windows, so the separate GGUF copy is not fetched there. */
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
  for (const size of STT_SIZES) {
    const plan = voiceWeights.sttPlan(size, root);
    jobs.push({
      id: plan.id,
      kind: "stt",
      ready: plan.dir,
      job: { modelId: plan.size, sources: plan.sources, dir: path.dirname(plan.dir) },
    });
  }
  for (const pinned of voiceWeights.pinnedJobs()) {
    const dir = path.join(root, ...pinned.dir);
    jobs.push({
      id: pinned.id,
      kind: "pinned",
      ready: path.join(dir, pinned.file),
      job: {
        modelId: path.basename(dir),
        dir: path.dirname(dir),
        sources: [
          {
            kind: "url",
            url: pinned.url,
            sha256: pinned.sha256,
            bytes: pinned.bytes,
            label: "official release",
          },
        ],
      },
    });
  }
  if (enabled(env, "FRIDAY_PREFETCH_CHAT") && !ollamaServesChat(env, platform)) {
    jobs.push(chatJob(root));
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
  return jobs;
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
function alreadyThere(row) {
  if (!row.ready) return false;
  if (row.kind === "stt") return voiceWeights.weightsReady(row.ready, fs.existsSync);
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

function printer(log, id) {
  const tty = Boolean(process.stdout.isTTY) && log === console.log;
  let last = "";
  return (event) => {
    const line = stageToolchain.progressLine(id, event, tty);
    if (!line || line === last) return;
    last = line;
    if (tty) process.stdout.write(line);
    else log(line);
  };
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

/** Stream POST /api/pull and report percent; resolves ok when the daemon says success. */
async function ollamaPull(tag, { fetchImpl = fetch, onEvent } = {}) {
  const res = await fetchImpl(`${OLLAMA_API}/api/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: tag, stream: true }),
  });
  if (!res.ok || !res.body) return { ok: false, error: `HTTP ${res.status}` };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ok = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
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
      if (row.total > 0 && row.completed >= 0) {
        onEvent?.({ progress: (row.completed / row.total) * 100 });
      }
    }
  }
  return ok ? { ok: true } : { ok: false, error: "the pull ended without success" };
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
  const models = deps.models || OLLAMA_MODELS;
  for (const model of models) {
    const wanted = modelWanted(model, deps.env || process.env, deps.totalGb);
    if (!wanted.ok) {
      log(`[friday] INFO     ${model.tag} (${model.tier}) skipped: ${wanted.why}`);
      rows.push({ id: model.tag, ok: true, downloaded: false, skipped: wanted.why });
      continue;
    }
    if (have.has(model.tag)) {
      log(
        `[friday] ok       ${model.tag} (${model.tier}) already in Ollama; verified, not pulled again`,
      );
      rows.push({ id: model.tag, ok: true, downloaded: false });
      continue;
    }
    log(`[friday] pulling ${model.tag} (${model.tier}: ${model.role})`);
    let result;
    try {
      result = await (deps.pull || ollamaPull)(model.tag, {
        fetchImpl,
        onEvent: printer(log, model.tag),
      });
    } catch (err) {
      result = { ok: false, error: String((err && err.message) || err) };
    }
    if (result.ok) rows.push({ id: model.tag, ok: true, downloaded: true });
    else {
      log(
        `[friday] INFO     ${model.tag} not pulled (${result.error}); FRIDAY pulls it on first use`,
      );
      rows.push({ id: model.tag, ok: false, error: result.error });
    }
  }
  return rows;
}

/** The pinned Ollama installer is Inno Setup: the standard silent switches apply. */
function runInstaller(file) {
  return new Promise((resolve) => {
    const { spawn } = require("node:child_process");
    const child = spawn(file, ["/VERYSILENT", "/NORESTART", "/SUPPRESSMSGBOXES"], {
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
  const jobs = prefetchPlan(root, env, platform, { ollama: existing.installed });
  if (!jobs.length) {
    log("[friday] model prefetch skipped");
    return rows;
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
    try {
      const newest = await latest("ollama");
      if (existing.version && newest?.tag && localLibrary.newerTag(newest.tag, existing.version)) {
        log(
          `[friday] INFO     ollama ${newest.tag} is available; update it from Install Manager when you want it`,
        );
      }
    } catch {
      /* the version note is optional */
    }
  }
  const fetchModel = download || require("../electron/model-download.cjs").downloadModel;
  for (const row of jobs) {
    if (alreadyThere(row)) {
      log(`[friday] ok       ${row.id} verified on disk; not downloaded again`);
      rows.push({ id: row.id, ok: true, downloaded: false });
      continue;
    }
    log(`[friday] fetching ${row.id}`);
    let result;
    try {
      result = await fetchModel(row.job, printer(log, row.id), undefined);
    } catch (err) {
      result = { ok: false, error: String((err && err.message) || err) };
    }
    if (result && result.ok) {
      log(`[friday] ok       ${row.id} (${result.source || result.via || "downloaded"})`);
      rows.push({ id: row.id, ok: true, downloaded: true });
    } else {
      const why = (result && result.error) || "download failed";
      log(`[friday] INFO     ${row.id} not prefetched (${why}); FRIDAY fetches it on first use`);
      rows.push({ id: row.id, ok: false, error: why });
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
            ...(existing.exe ? { ollamaExe: existing.exe } : {}),
            ...ollama,
          },
        });
        rows.push(...ollamaRows);
      } catch (err) {
        log(`[friday] INFO     ollama setup skipped (${String((err && err.message) || err)})`);
      }
    }
  }
  // The Qwen GGUF is the same small model Ollama pulls; it is fetched only
  // when Ollama is meant to provide it and could not.
  const small = OLLAMA_MODELS.find((model) => model.tier === "fast")?.tag;
  const provided = ollamaRows.some((row) => row.id === small && row.ok);
  if (
    ollamaServesChat(env, platform) &&
    enabled(env, "FRIDAY_PREFETCH_CHAT") &&
    !provided &&
    !alreadyThere(chatJob(root))
  ) {
    log(
      `[friday] INFO     ${small || "the small chat model"} is not in Ollama; fetching the GGUF copy`,
    );
    const gguf = chatJob(root);
    let result;
    try {
      result = await fetchModel(gguf.job, printer(log, gguf.id), undefined);
    } catch (err) {
      result = { ok: false, error: String((err && err.message) || err) };
    }
    rows.push(
      result && result.ok
        ? { id: gguf.id, ok: true, downloaded: true }
        : { id: gguf.id, ok: false, error: (result && result.error) || "download failed" },
    );
  }
  return rows;
}

module.exports = {
  STT_SIZES,
  CHAT_MODEL,
  OLLAMA_MODELS,
  prefetchPlan,
  prefetch,
  ensureOllama,
  ollamaPull,
  findOllama,
  detectOllama,
  modelWanted,
  ollamaServesChat,
};

if (require.main === module) {
  const fridayRoot = require("./friday-root.cjs");
  const picked = fridayRoot.workspaceRootOrDev();
  process.env.FRIDAY_ROOT = process.env.FRIDAY_ROOT || picked.root;
  prefetch(picked.root).then(
    () => process.exit(0),
    () => process.exit(0),
  );
}
