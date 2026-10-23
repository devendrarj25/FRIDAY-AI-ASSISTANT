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
 * On Windows the same step also sets up Ollama. An Ollama that is already on
 * this PC (running, on PATH, or in its standard folders) is reused as it is:
 * no installer is downloaded and nothing is reinstalled. Only a missing Ollama
 * is installed per user (the newest official release, SHA-256 and Authenticode
 * checked, no administrator). It is then started and the two small chat models
 * above are pulled, so chat works on the first launch.
 *
 * Opt out: FRIDAY_PREFETCH=0 skips all of it, FRIDAY_PREFETCH_CHAT=0 skips the
 * local chat model only, FRIDAY_PREFETCH_OLLAMA=0 skips the Ollama install and pulls. Hosted CI skips it unless FRIDAY_PREFETCH=1, so a
 * workflow run does not pull gigabytes on every build.
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const voiceWeights = require("../electron/voice-weights.cjs");
const stageToolchain = require("./stage-toolchain.cjs");
const localRunners = require("../config/local-runners.json");
const localLibrary = require("../electron/local-library.cjs");

/** Ollama is the local engine FRIDAY starts and stops; these two are pulled through it. */
const OLLAMA_API = "http://127.0.0.1:11434";
const OLLAMA_MODELS = [
  { tag: "qwen2.5:1.5b", role: "fast replies and voice turns" },
  { tag: "qwen2.5:3b", role: "smarter chat, English, Hindi and Hinglish" },
];

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

/** Standard places a per-user or per-machine Ollama lands on Windows. */
function ollamaLocations(env = process.env) {
  const exe = ["Ollama", "ollama.exe"];
  return [
    env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, "Programs", ...exe),
    env.ProgramFiles && path.win32.join(env.ProgramFiles, ...exe),
    env["ProgramFiles(x86)"] && path.win32.join(env["ProgramFiles(x86)"], ...exe),
  ].filter(Boolean);
}

/** The Ollama on this PC: its executable and version, or null when none is installed. */
function findOllama({ env = process.env, exists = fs.existsSync, version } = {}) {
  const names = process.platform === "win32" ? ["ollama.exe"] : ["ollama"];
  const onPath = String(env.PATH || env.Path || "")
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((dir) => names.map((name) => path.join(dir, name)));
  const exe = [...onPath, ...ollamaLocations(env)].find((file) => exists(file));
  if (!exe) return null;
  return { exe, version: (version || ollamaVersion)(exe) };
}

/** `ollama --version` prints the client version; a running older daemon adds its own line. */
function ollamaVersion(exe) {
  try {
    const out = execFileSync(exe, ["--version"], {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
    });
    const client = /client version is\s+v?(\d+(?:\.\d+)+)/i.exec(out);
    const plain = /version is\s+v?(\d+(?:\.\d+)+)/i.exec(out);
    return (client || plain || [])[1] || null;
  } catch {
    return null;
  }
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
  if (enabled(env, "FRIDAY_PREFETCH_CHAT")) {
    jobs.push({
      id: CHAT_MODEL.id,
      kind: "chat",
      ready: "",
      job: { modelId: CHAT_MODEL.id, sources: CHAT_MODEL.sources, dir: path.join(root, "models") },
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
  return jobs;
}

function alreadyThere(row) {
  if (!row.ready) return false;
  if (row.kind === "stt") return voiceWeights.weightsReady(row.ready, fs.existsSync);
  if (!fs.existsSync(row.ready)) return false;
  // A kept installer is reused only when it is the exact bytes the publisher signed off.
  const want = row.kind === "installer" ? row.job.sources[0]?.sha256 : "";
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
  for (const model of OLLAMA_MODELS) {
    if (have.has(model.tag)) {
      log(`[friday] ok       ${model.tag} already pulled`);
      rows.push({ id: model.tag, ok: true, downloaded: false });
      continue;
    }
    log(`[friday] pulling ${model.tag} (${model.role})`);
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
      log(`[friday] ok       ${row.id} already on disk`);
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
  if (wantOllama && enabled(env, "FRIDAY_AUTO_INSTALL")) {
    const fetched = installer ? rows.find((row) => row.id === installer.id) : null;
    if (existing.installed || fetched?.ok || (installer && alreadyThere(installer))) {
      try {
        rows.push(
          ...(await ensureOllama(root, installer || null, {
            log,
            deps: {
              signed: async (file) =>
                require("../electron/download-safety.cjs").authenticodeStatus(file),
              ...(existing.exe ? { ollamaExe: existing.exe } : {}),
              ...ollama,
            },
          })),
        );
      } catch (err) {
        log(`[friday] INFO     ollama setup skipped (${String((err && err.message) || err)})`);
      }
    }
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
  ollamaVersion,
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
