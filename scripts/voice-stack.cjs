#!/usr/bin/env node
/**
 * Voice stack inventory: is every runner, model, package, router, gate and system of the voice mode really there,
 * and really connected to the next one? Every row comes from the files of this checkout (and, when a FRIDAY folder
 * is given, from what is on disk). Nothing is assumed and nothing is started: it reads files and loads modules.
 *
 *   node scripts/voice-stack.cjs            a table, exit code 1 when a row FAILs
 *   node scripts/voice-stack.cjs --json     the rows as JSON
 *   node scripts/voice-stack.cjs --root DIR also check which models are on disk under DIR
 *
 * A row is PASS, FAIL (a gap: something that must exist or be connected is not) or INFO (a fact, not a verdict).
 * What only a real PC can show (a microphone, a live account, a Windows run) is never reported here as PASS.
 */
const fs = require("node:fs");
// Colour that means something (ok green, FAIL red, a note yellow) on a real console; plain text everywhere else.
if (require.main === module) require("./live-console.cjs").installColorConsole();
const path = require("node:path");
const { jobHosts, sourceHosts, sourcesLine, probeModules } = require("./doctor-probes.cjs");

const REPO = path.resolve(__dirname, "..");
const read = (rel) => {
  try {
    return fs.readFileSync(path.join(REPO, rel), "utf8");
  } catch {
    return "";
  }
};
const exists = (rel) => fs.existsSync(path.join(REPO, rel));

/** Never part of the voice stack (AGENTS.md): none may appear in a requirements file. */
const BANNED_PACKAGES = [
  "torch",
  "vllm",
  "vosk",
  "piper-tts",
  "kokoro-onnx",
  "sherpa-onnx",
  "silero-vad",
];

function packageNames(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean)
    .map((line) =>
      line
        .split(/[<>=!~;\[ ]/)[0]
        .toLowerCase()
        .replace(/_/g, "-"),
    );
}

/** How one download source is verified: its own SHA-256, or a repository pin with a revision and a digest per file. */
function sourceVerdict(src, pins) {
  if (src?.sha256) return { ok: true, how: "pinned SHA-256" };
  const pin = src?.kind === "hf-repo" && src.repo ? pins.pinForRepo(src.repo) : null;
  const files = Object.values(pin?.files || {});
  if (
    /^[0-9a-f]{40}$/.test(pin?.revision || "") &&
    files.length > 0 &&
    files.every((file) => /^[0-9a-f]{64}$/.test(file?.sha256 || ""))
  )
    return {
      ok: true,
      how: `pinned revision ${pin.revision.slice(0, 8)}, SHA-256 for ${files.length} files`,
    };
  return { ok: false, how: "" };
}

/**
 * Is a setup job verified, and how? EVERY source of the job is looked at (a mirror without a digest is a way in
 * for unverified bytes): a source digest; the publisher's own listing (speech, voice, chat); or a repository pin in
 * electron/voice-pins.cjs with a full revision AND a SHA-256 for every file (the Hindi ears and the other pinned
 * models, fetched by revision). Anything else is not verified, and the row names the first source that has no digest.
 */
function verifiedBy(job, pins = require(path.join(REPO, "electron", "voice-pins.cjs"))) {
  const sources = Array.isArray(job.job?.sources) ? job.job.sources : [];
  if (sources.length && sources.every((src) => src?.sha256))
    return {
      ok: true,
      how:
        sources.length > 1 ? `pinned SHA-256 on all ${sources.length} sources` : "pinned SHA-256",
    };
  if (["stt", "tts", "chat"].includes(job.kind))
    return { ok: true, how: "checked against the publisher's listing" };
  const verdicts = sources.map((src) => sourceVerdict(src, pins));
  if (verdicts.length && verdicts.every((v) => v.ok)) {
    const hows = [...new Set(verdicts.map((v) => v.how))];
    return {
      ok: true,
      how: verdicts.length > 1 ? `all ${verdicts.length} sources: ${hows.join("; ")}` : hows[0],
    };
  }
  const bad = verdicts.findIndex((v) => !v.ok);
  const host = bad >= 0 && sources.length > 1 ? sourceHosts([sources[bad]])[0] : "";
  return {
    ok: false,
    how: host ? `${job.id} source ${host} has no digest` : `${job.id} has no digest`,
  };
}

/** Engines that need no download: always there, so every role has a last fallback. */
const BUILT_IN_ENGINES = new Set([
  "edge-tts",
  "sapi",
  "formant",
  "energy-vad",
  "silence-timer",
  "transcript-wake",
  "script-ratio",
]);

/** Engines that live in a Python package or the kernel, not in a model folder: Doctor's voice-files step checks them. */
const UNCHECKED_ENGINES = new Set([
  "rnnoise",
  "openwakeword",
  "wespeaker-ecapa",
  "fasttext-lid218",
  "moonshine-en",
]);

/** The fallback chains of src/lib/friday/voice-engine/voice-engine-table.ts, read as text (node cannot load TS). */
function engineChains(text) {
  const whisper = [
    ...(/const WHISPER_SIZES = \[([^\]]*)\]/.exec(text)?.[1] || "").matchAll(/"([^"]+)"/g),
  ].map((m) => m[1]);
  const at = text.indexOf("export const VOICE_CHAINS");
  const chains = {};
  let role = "";
  const scan = /^ {2}(\w+): \{|\b(hi|en|hinglish):\s*\[([^\]]*)\]/gm;
  for (const m of at < 0 ? [] : text.slice(at).matchAll(scan)) {
    if (m[1]) {
      role = m[1];
      chains[role] = {};
    } else if (role) {
      chains[role][m[2]] = [...m[3].matchAll(/"([^"]+)"|\.\.\.WHISPER_SIZES/g)].flatMap((x) =>
        x[1] ? [x[1]] : whisper,
      );
    }
  }
  return chains;
}

/** INFO rows: per role (and language for listening and speaking) the engine in use and the installed fallbacks. */
function engineRows(chains, installed, proof = {}) {
  const rows = [];
  for (const [role, langs] of Object.entries(chains)) {
    const perLang = role === "stt" || role === "tts";
    for (const lang of perLang ? ["hi", "en", "hinglish"] : ["hi"]) {
      const chain = langs[lang] || [];
      if (!chain.length) continue;
      const name = perLang ? `${role} ${lang}` : role;
      if (!installed) {
        rows.push({
          layer: "engine",
          name,
          state: "INFO",
          detail: `chain ${chain.join(" > ")} (disk state needs --root)`,
        });
        continue;
      }
      const here = chain.filter(
        (id) => BUILT_IN_ENGINES.has(id) || installed.has(id) || proof.present?.has(id),
      );
      // An engine in a Python package is "not checked" only when no venv python answered; with an answer it is
      // either here (the package is importable) or not installed.
      const unchecked = chain.filter(
        (id) => UNCHECKED_ENGINES.has(id) && !here.includes(id) && !proof.absent?.has(id),
      );
      const missing = chain.filter((id) => !here.includes(id) && !unchecked.includes(id));
      const none = role === "stt" ? "no listening engine installed" : "no engine installed";
      const detail = here.length
        ? `active ${here[0]}${here.length > 1 ? `; fallbacks ${here.slice(1).join(", ")}` : "; no fallback installed"}`
        : none;
      rows.push({
        layer: "engine",
        name,
        state: "INFO",
        detail: `${detail}${missing.length ? ` (not installed: ${missing.length})` : ""}${unchecked.length ? ` (not checked here: ${unchecked.join(", ")})` : ""}`,
      });
    }
  }
  return rows;
}

/** The Python module behind each engine that lives in a package (the importable name, not the pip name). */
const ENGINE_MODULES = {
  rnnoise: "pyrnnoise",
  openwakeword: "openwakeword",
  "fasttext-lid218": "fasttext",
  "moonshine-en": "moonshine_voice",
};

/** Every module a language, engine or role row needs from the venv, probed together in one python run. */
const VOICE_MODULES = [
  ...new Set([
    ...Object.values(ENGINE_MODULES),
    "pyaec",
    "supertonic",
    "numpy",
    "onnx_asr",
    "sentencepiece",
    "faster_whisper",
    "onnxruntime",
  ]),
];

/** Pip names for the modules whose import name differs, for the detail text. */
const PIP_NAME = {
  onnx_asr: "onnx-asr",
  moonshine_voice: "moonshine-voice",
  faster_whisper: "faster-whisper",
};

/** Folders `kernel/voice_runtime.py find_named` looks in for the speaker file. */
const SPEAKER_FILE = "wespeaker-ecapa.onnx";
const SPEAKER_DIRS = ["", "voice", "silero-vad", "kokoro-v1", "smart-turn"];

function speakerFileThere(root, exists) {
  return SPEAKER_DIRS.some((dir) => exists(path.join(root, "models", dir, SPEAKER_FILE)));
}

/**
 * Proof for the engines in UNCHECKED_ENGINES: `present` and `absent` sets of engine ids. A package engine is proven by
 * the venv python (`mods`: `{ module: boolean }`, or null when no python answered, which proves nothing); the Moonshine
 * English streaming ear also needs its model folder; the speaker file is a file, checked on disk.
 */
function engineProof({ mods, root, exists, moonshineReady }) {
  const present = new Set();
  const absent = new Set();
  const mark = (id, ok) => (ok ? present : absent).add(id);
  if (mods) {
    for (const [id, mod] of Object.entries(ENGINE_MODULES)) {
      if (id === "moonshine-en") mark(id, mods[mod] === true && moonshineReady === true);
      else mark(id, mods[mod] === true);
    }
  }
  if (root) mark("wespeaker-ecapa", speakerFileThere(root, exists));
  return { present, absent };
}

/** The same switch prefetch-models.cjs reads: only the value 0 turns a download off. */
const switchedOff = (value) => String(value ?? "1").trim() === "0";

/**
 * The voice plan as setup followed it (the required rows of `readPlanSync`, the same object check-environment.cjs builds),
 * so the disk rows and the language rows cannot disagree about what this PC carries.
 */
function planAsVoicePlan(planData, weights) {
  const skipped = new Map((planData.skipped || []).map((row) => [row.id, row.reason]));
  return {
    items: planData.required
      .filter((row) => row.kind === "voice-model")
      .map((row) => ({ id: row.id, state: row.action === "present" ? "on-disk" : "download" })),
    blocked: weights.SIZE_ORDER.filter((size) => skipped.has(size)).map((size) => ({
      id: size,
      size,
      reason: skipped.get(size),
    })),
  };
}

/** What this PC's plan says about a voice model: planned, skipped (with its reason) or not part of the plan. */
function planView(planData, voicePlan) {
  const planned = new Set();
  const skipped = new Map();
  if (planData && Array.isArray(planData.required)) {
    for (const row of planData.required) if (row.kind === "voice-model") planned.add(row.id);
    for (const row of planData.skipped || []) skipped.set(row.id, row.reason);
    return { source: "plan", planned, skipped };
  }
  if (voicePlan && Array.isArray(voicePlan.items)) {
    for (const item of voicePlan.items) {
      if (item.state === "skipped") skipped.set(item.id, item.reason);
      else planned.add(item.id);
    }
    return { source: "voice plan", planned, skipped };
  }
  return { source: "", planned, skipped };
}

/**
 * One row per language and role (Hindi, English, Hinglish: ears, speaking, punctuation, the light voice, the fallback
 * ear) plus the language-free noise and echo rows. A model that this PC's plan carries and that is not on disk is FAIL
 * (MISSING); one the plan skipped is INFO with the plan's reason; one that is not part of the plan is INFO. A package
 * the row needs is FAIL when absent from the venv on a PC that must have it, INFO when it was not checked.
 */
function languageRows({
  onDisk,
  view,
  mods,
  packagesRequired = false,
  moonshine = { ready: false },
  env = {},
  hasPython = true,
}) {
  const rows = [];
  const modelPart = (id) => {
    if (onDisk.has(id)) return { state: "ok", text: `${id} on disk` };
    if (view.skipped.has(id))
      return {
        state: "skipped",
        text: `${id} skipped on this PC: ${String(view.skipped.get(id)).slice(0, 110)}`,
      };
    if (view.planned.has(id))
      return { state: "missing", text: `${id} MISSING: planned for this PC, run npm run setup` };
    if (!view.source)
      return { state: "unknown", text: `${id} not on disk (this PC's plan could not be read)` };
    return {
      state: "unplanned",
      text: `${id} not planned for this PC (optional, the Models page installs it)`,
    };
  };
  const moonshinePart = () => {
    if (moonshine.ready) return { state: "ok", text: "moonshine-en on disk" };
    if (switchedOff(env.FRIDAY_PREFETCH_MOONSHINE) || switchedOff(env.FRIDAY_PREFETCH))
      return {
        state: "skipped",
        text: "moonshine-en skipped on this PC: its prefetch is switched off",
      };
    if (!hasPython)
      return {
        state: "skipped",
        text: "moonshine-en skipped on this PC: no Python runtime yet (npm run setup:python fetches it)",
      };
    return {
      state: "missing",
      text: "moonshine-en MISSING: setup fetches it on every PC, run npm run setup",
    };
  };
  const packagePart = (mod) => {
    const name = PIP_NAME[mod] || mod;
    if (!mods) return { state: "unchecked", text: `package ${name} not checked (no venv python)` };
    return mods[mod] === true
      ? { state: "ok", text: `package ${name} present` }
      : { state: "absent", text: `package ${name} NOT installed in the venv` };
  };
  const optionalPart = (mod) => {
    const name = PIP_NAME[mod] || mod;
    if (!mods) return { state: "unchecked", text: `package ${name} not checked (no venv python)` };
    return mods[mod] === true
      ? { state: "ok", text: `package ${name} present (fallback)` }
      : { state: "ok", text: `own runner (optional fallback ${name} not installed)` };
  };
  const add = (name, models, modules, optional = []) => {
    const parts = [...models.map((m) => (m === "moonshine-en" ? moonshinePart() : modelPart(m)))];
    const needed = !parts.length || parts.some((p) => p.state === "ok" || p.state === "missing");
    const pkgs = modules.map(packagePart);
    const extras = optional.map(optionalPart);
    let state = "INFO";
    if (parts.some((p) => p.state === "missing")) state = "FAIL";
    else if (needed && pkgs.some((p) => p.state === "absent"))
      state = packagesRequired ? "FAIL" : "INFO";
    else if (needed && parts.every((p) => p.state === "ok") && pkgs.every((p) => p.state === "ok"))
      state = "PASS";
    rows.push({
      layer: "language",
      name,
      state,
      detail: [...parts, ...pkgs, ...extras].map((p) => p.text).join("; "),
    });
  };
  add("hindi ears (STT)", ["hindi-ear"], ["numpy", "onnxruntime"], ["onnx_asr"]);
  add("hindi fallback ear", ["hindi-fallback-ear"], ["faster_whisper"]);
  add("hindi speaking (TTS)", ["supertonic-3"], ["supertonic"]);
  add("hindi light TTS", ["hindi-light-tts"], []);
  add("hindi punctuation", ["hindi-punct"], ["sentencepiece"]);
  add("english ears (STT)", ["moonshine-en"], ["moonshine_voice"]);
  add("english speaking (TTS)", ["supertonic-3"], ["supertonic"]);
  add("hinglish ears (STT)", ["hinglish-ear"], ["faster_whisper"]);
  add("hinglish speaking (TTS)", ["supertonic-3"], ["supertonic"]);
  add("hinglish punctuation", ["hindi-punct"], ["sentencepiece"]);
  add("noise suppression (all languages)", [], [], ["pyrnnoise"]);
  add("echo canceller (all languages)", [], ["pyaec"]);
  return rows;
}

function ipcChannels(source, pattern) {
  return [...source.matchAll(pattern)].map((m) => m[1]);
}

const VOICE_CHANNEL = /^(voice|realtime|wake|stt|neural|sapi|speech|voiceprint)[:-]/;

/**
 * `planData` is this PC's setup plan as plain data (`readPlanSync` of prefetch-models.cjs); `python` the FRIDAY venv
 * interpreter (it proves the Python packages); `reach(hosts)` answers `{ host: { state } }` for the sources line of a
 * download. Each is optional: without one the row says "not checked" and never guesses.
 */
function inventory({
  root = "",
  platform = process.platform,
  env = process.env,
  planData = null,
  python = "",
  reach = null,
  run,
} = {}) {
  const rows = [];
  const row = (layer, name, state, detail) => rows.push({ layer, name, state, detail });
  const check = (layer, name, ok, good, bad) =>
    row(layer, name, ok ? "PASS" : "FAIL", ok ? good : bad);

  // ---- packages -----------------------------------------------------------------------------------------------
  const names = new Set([
    ...packageNames(read("kernel/requirements.txt")),
    ...packageNames(read("kernel/requirements-capabilities.txt")),
  ]);
  for (const [pkg, why] of [
    ["faster-whisper", "the speech engine"],
    ["av", "decodes any recording to PCM"],
    ["edge-tts", "the online neural voice"],
    ["fastapi", "the kernel server"],
  ])
    check(
      "package",
      pkg,
      names.has(pkg),
      `${why} is pinned in the kernel requirements`,
      `${why} is NOT in the kernel requirements`,
    );
  const bannedFound = BANNED_PACKAGES.filter((pkg) => names.has(pkg));
  check(
    "package",
    "banned voice packages",
    bannedFound.length === 0,
    "none of torch, vLLM, vosk, piper-tts, kokoro-onnx, sherpa-onnx, silero-vad",
    `banned: ${bannedFound.join(", ")}`,
  );

  // ---- runners ------------------------------------------------------------------------------------------------
  const runners = JSON.parse(read("config/local-runners.json") || '{"runners":[]}').runners || [];
  const models = require(path.join(REPO, "electron", "models.cjs"));
  for (const id of ["ollama", "llamacpp"]) {
    const entry = runners.find((r) => r.id === id);
    const release = entry?.release;
    check(
      "runner",
      `${id} release pin`,
      Boolean(
        release?.url?.startsWith("https://github.com/") &&
        /^[0-9a-f]{64}$/.test(release?.sha256 || ""),
      ),
      `${release?.tag} ${release?.asset} with a SHA-256`,
      `${id} has no pinned official release with a SHA-256`,
    );
    check(
      "runner",
      `${id} start control`,
      Boolean(models.ENGINE_CONTROL?.[id]),
      "FRIDAY can probe and start it",
      `no ENGINE_CONTROL entry for ${id}`,
    );
  }
  check(
    "runner",
    "llama.cpp is a process FRIDAY can stop",
    models.ENGINE_CONTROL?.llamacpp?.modelStart?.managed === true,
    "started by FRIDAY, so stopped by FRIDAY",
    "llama.cpp start is not tracked, so it cannot be stopped",
  );
  const startup = require(path.join(REPO, "electron", "startup.cjs"));
  check(
    "runner",
    "engines start at launch",
    typeof startup.runStartupFlow === "function",
    "startup flow starts every engine that can start",
    "no startup flow",
  );

  // ---- setup plan (models and runners fetched before the build) ------------------------------------------------
  const prefetch = require(path.join(REPO, "scripts", "prefetch-models.cjs"));
  const winEnv = {
    ...env,
    CI: "",
    GITHUB_ACTIONS: "",
    FRIDAY_PREFETCH: "1",
    FRIDAY_AUTO_INSTALL: "1",
  };
  // With a folder given, the plan is the one setup follows on this PC (the voice profile of its memory and GPU), so a
  // speech size that setup deliberately leaves out is not reported as missing.
  const weightsApi = require(path.join(REPO, "electron", "voice-weights.cjs"));
  const voicePlan = !root
    ? null
    : planData && Array.isArray(planData.required)
      ? planAsVoicePlan(planData, weightsApi)
      : weightsApi.voiceInstallPlan(root, weightsApi.probeHardware(), { exists: fs.existsSync });
  const plan = prefetch.prefetchPlan(root || "/friday", winEnv, "win32", { plan: voicePlan });
  const planned = new Set(plan.map((job) => job.id));
  for (const [id, why] of [
    ["smart-turn", "end-of-turn detector"],
    ["silero-vad", "speech detector"],
    ["stt-base", "fast listening"],
    ["stt-tiny", "lite listening fallback"],
    ["stt-small", "Hindi and Hinglish listening"],
    ["supertonic-3", "offline voice"],
    ["ollama-setup", "Ollama"],
  ])
    check(
      "setup",
      id,
      planned.has(id),
      `${why} is downloaded by npm run setup`,
      `${why} is NOT in the setup plan`,
    );
  // Every source of every download, in the order setup tries them, and which of them answers now.
  const reachMap = reach ? reach([...new Set(plan.flatMap((job) => jobHosts(job)))]) : {};
  const sourcesOf = (job, missing = false) => sourcesLine(jobHosts(job), reachMap, { missing });
  for (const job of plan) {
    const verdict = verifiedBy(job);
    const sources = sourcesOf(job);
    const text = sources ? `${verdict.how}; ${sources}` : verdict.how;
    check("setup", `${job.id} is verified`, verdict.ok, text, text);
  }
  const bigStt = [...planned].filter((id) => /^stt-(medium|large-v3$)/.test(id));
  // Planned is the good answer (the big sizes are part of setup); INFO only when none is planned.
  row(
    "setup",
    "big speech sizes in the plan",
    bigStt.length ? "PASS" : "INFO",
    bigStt.length ? bigStt.join(", ") : "none",
  );

  // ---- speech models on disk (only when a folder is given) -----------------------------------------------------
  if (root) {
    const ramGb = require("node:os").totalmem() / 1024 ** 3;
    const ollamaHere = Boolean(prefetch.findOllama());
    for (const job of plan) {
      const here = prefetch.alreadyThere(job);
      const sources = (missing) => {
        const line = sourcesOf(job, missing);
        return line ? `; ${line}` : "";
      };
      // The Ollama installer is only downloaded when Ollama is not on the PC: an installed Ollama is the proof.
      if (job.kind === "installer" && !here && ollamaHere) {
        row("disk", job.id, "PASS", "Ollama is installed, so its installer was not needed");
        continue;
      }
      // Setup skips a size this PC has too little memory for, and an optional download may not have landed:
      // neither is a gap, so they are reported but never fail the check.
      if (!here && job.skipReason) {
        row("disk", job.id, "INFO", `not fetched on this PC: ${job.skipReason}${sources(true)}`);
      } else if (!here && job.minRamGb && ramGb < job.minRamGb) {
        row(
          "disk",
          job.id,
          "INFO",
          `not fetched: needs ${job.minRamGb} GB, this PC has ${Math.floor(ramGb)}${sources(true)}`,
        );
      } else if (!here && job.optional) {
        row("disk", job.id, "INFO", `optional, not on disk${sources(true)}`);
      } else {
        row(
          "disk",
          job.id,
          here ? "PASS" : "FAIL",
          here ? `on disk${sources(false)}` : `missing — run npm run setup${sources(true)}`,
        );
      }
    }
  }

  const weights = require(path.join(REPO, "electron", "voice-weights.cjs"));
  // ---- engines per role: the one in use and the fallbacks that are installed (information, never a verdict) -------
  const onDisk = root
    ? new Set(weights.voiceModelsOnDisk(root, fs.existsSync).map((found) => found.catalogId))
    : null;
  // Engines in a Python package are proven with the venv python (importlib.util.find_spec), not assumed.
  const mods = root && python ? probeModules(python, VOICE_MODULES, { run }) : null;
  const moonshineReady = root
    ? prefetch.moonshineReady(path.join(root, ...prefetch.MOONSHINE_DIR))
    : false;
  rows.push(
    ...engineRows(
      engineChains(read("src/lib/friday/voice-engine/voice-engine-table.ts")),
      onDisk,
      root ? engineProof({ mods, root, exists: fs.existsSync, moonshineReady }) : {},
    ),
  );
  if (root) {
    rows.push(
      ...languageRows({
        onDisk,
        view: planView(planData, voicePlan),
        mods,
        packagesRequired:
          platform === "win32" &&
          env.FRIDAY_OFFLINE !== "1" &&
          String(env.FRIDAY_PREFETCH_STRICT ?? "1").trim() !== "0",
        moonshine: { ready: moonshineReady },
        env,
        hasPython: Boolean(python),
      }),
    );
  }

  // ---- speech sizes: every list that names a size must agree with the weights map ---------------------------------
  const sizes = Object.keys(weights.STT_REPOS || {});
  const SIZE = /"(tiny|base|small|medium|large-v3-turbo|large-v3)"/g;
  const sizesIn = (text, startMarker, span) => {
    const at = text.indexOf(startMarker);
    return at < 0 ? [] : [...text.slice(at, at + span).matchAll(SIZE)].map((m) => m[1]);
  };
  const lists = {
    "kernel/stt.py known sizes": sizesIn(
      read("kernel/stt.py").replace(/'/g, '"'),
      "OWNER_SIZES = frozenset({",
      140,
    ),
    "electron/stt.cjs MODELS": sizesIn(read("electron/stt.cjs"), "const MODELS = [", 120),
    "electron/voice-verify.cjs": sizesIn(
      read("electron/voice-verify.cjs"),
      "const STT_SIZES = [",
      120,
    ),
    "electron/voice-install.cjs": sizesIn(
      read("electron/voice-install.cjs"),
      "const MODEL_ORDER = [",
      120,
    ),
    "src voice-session ladder": sizesIn(
      read("src/lib/friday/voice-session.ts"),
      "const SPEECH_LADDER = [",
      120,
    ),
    "src preferences sttSize": sizesIn(
      read("src/lib/friday/preferences.ts"),
      "export const STT_SIZE_PICKS = [",
      200,
    ),
  };
  for (const [name, found] of Object.entries(lists)) {
    const missing = sizes.filter((size) => !found.includes(size));
    check(
      "speech",
      name,
      missing.length === 0,
      `names all ${sizes.length} sizes`,
      `missing: ${missing.join(", ") || "(list not found)"}`,
    );
  }
  check(
    "speech",
    "every size has a Models-page row",
    sizes.every((size) =>
      read("src/lib/friday/model-catalog.ts").includes(
        `"${(weights.STT_CATALOG || {})[size] || "?"}"`,
      ),
    ),
    "each size maps to a catalogue id",
    "a size has no catalogue row",
  );

  // ---- kernel voice files and routes --------------------------------------------------------------------------
  for (const [file, why] of [
    ["kernel/stt.py", "faster-whisper worker"],
    ["kernel/voice_runtime.py", "VAD, Smart Turn, Supertonic voice"],
    ["kernel/wake_word.py", "wake scorer"],
    ["kernel/language_segmenter.py", "script spans"],
    ["kernel/hindi_ear.py", "Hindi ear (IndicConformer int8)"],
    ["kernel/whisper_ears.py", "Hinglish ear and Hindi fallback (faster-whisper folders)"],
    ["kernel/hindi_punct.py", "optional Hindi punctuation (sentencepiece)"],
    ["kernel/tts_hindi_light.py", "optional light Hindi voice (speak-pcm engine hindi-light)"],
    ["kernel/router.py", "model router"],
    ["kernel/privacy.py", "privacy firewall"],
    ["kernel/billing.py", "billing firewall"],
  ])
    check("kernel", file, exists(file), why, `${file} is missing`);

  // ---- IPC wiring: every voice channel the page can call has a handler and a time budget ------------------------
  const preload = read("electron/preload.cjs");
  const main = read("electron/main.cjs");
  const budget = read("electron/ipc-budget-table.cjs");
  const invoked = new Set(
    ipcChannels(preload, /ipcRenderer\.invoke\(\s*"([^"]+)"/g).filter((c) => VOICE_CHANNEL.test(c)),
  );
  const handled = new Set(ipcChannels(main, /ipcMain\.handle\(\s*"([^"]+)"/g));
  const unhandled = [...invoked].filter((c) => !handled.has(c));
  const unbudgeted = [...invoked].filter((c) => !budget.includes(`"${c}"`));
  check(
    "ipc",
    "voice channels have a handler",
    invoked.size > 0 && unhandled.length === 0,
    `${invoked.size} channels, all handled in main`,
    `no handler for: ${unhandled.join(", ")}`,
  );
  check(
    "ipc",
    "voice channels have a time budget",
    unbudgeted.length === 0,
    "all in the IPC budget table",
    `no budget for: ${unbudgeted.join(", ")}`,
  );

  // ---- routers ------------------------------------------------------------------------------------------------
  const voiceRouter = read("src/lib/friday/voice-engine/voice-provider-router.ts");
  check(
    "router",
    "voice provider router",
    /export function routeVoice/.test(voiceRouter) && /class UsageLedger/.test(voiceRouter),
    "capability table, quota ledger, zero-spend default",
    "routeVoice or UsageLedger is missing",
  );
  // The local engines are one table (kernel/local_engines.json) read by the router and the billing firewall.
  const engineTable = read("kernel/local_engines.json");
  const tableHasBothEngines = /"llamacpp"/.test(engineTable) && /"ollama"/.test(engineTable);
  const modelRouter = read("electron/model-router.cjs");
  check(
    "router",
    "model router knows llama.cpp and Ollama as local",
    (/"llamacpp"/.test(modelRouter) && /ollama/.test(modelRouter)) ||
      (/local-engines/.test(modelRouter) && tableHasBothEngines),
    "both are local providers",
    "a local engine is missing from the model router",
  );
  check(
    "router",
    "cloud speech goes through the router first",
    /routeVoice\(/.test(read("src/lib/friday/voice-engine/voice-cloud-client.ts")),
    "quota and privacy are checked before every cloud call",
    "speakWithCloud does not ask the router",
  );

  // ---- gates --------------------------------------------------------------------------------------------------
  const cloud = read("electron/voice-cloud.cjs");
  const gateBody = cloud.slice(
    cloud.indexOf("function gate("),
    cloud.indexOf("function gate(") + 1400,
  );
  check(
    "gate",
    "cloud speech gate order",
    /cloudEnabled|cloudVoice/.test(gateBody) && /privacy/i.test(gateBody) && /key/i.test(gateBody),
    "cloud on, provider allowed, privacy off, key saved",
    "the main-process gate misses a condition",
  );
  check(
    "gate",
    "streaming speech uses the same gate",
    /createSarvamStreams\(\{\s*gate: \(provider\) => voiceCloudApi\.gate\(provider\)/.test(
      main.replace(/\s+/g, " ").replace(/\{ gate/g, "{ gate"),
    ) || /voiceCloudApi\.gate\(provider\)/.test(main),
    "voice-stream:open goes through voiceCloudApi.gate",
    "streaming speech opens without the gate",
  );
  check(
    "gate",
    "realtime cloud gate",
    /voicePrivacyOn\(\)/.test(main) && /paidUnlocked/.test(main),
    "privacy, paid access and consent are re-checked in main",
    "realtime:open-cloud misses privacy or paid access",
  );
  const billing = read("electron/billing-firewall.cjs");
  check(
    "gate",
    "billing firewall treats local engines as free",
    (/llamacpp/.test(billing) && /ollama/.test(billing)) ||
      (/local-engines/.test(billing) && tableHasBothEngines),
    "llama.cpp and Ollama are local",
    "a local engine is not in the billing firewall's local list",
  );
  const kernelYaml = read("config/kernel.yaml");
  check(
    "gate",
    "execution is not auto-approved",
    /auto_approve_exec:\s*false/.test(kernelYaml),
    "automation.auto_approve_exec is false",
    "auto_approve_exec is not false",
  );
  const cloudDefaults = read("src/lib/friday/voice-engine/voice-cloud-settings.ts");
  check(
    "gate",
    "cloud speech is off by default",
    /cloudEnabled:\s*false/.test(cloudDefaults) &&
      /streaming:\s*false/.test(cloudDefaults) &&
      /streamCaptions:\s*false/.test(cloudDefaults),
    "cloud, streaming and captions default to off",
    "a cloud path defaults to on",
  );

  // ---- systems ------------------------------------------------------------------------------------------------
  const audioFiles = ["src", "electron"].flatMap((dir) =>
    fs
      .readdirSync(path.join(REPO, dir), { recursive: true })
      .map(String)
      .filter((f) => /\.(ts|tsx|cjs)$/.test(f))
      .map((f) => path.join(dir, f)),
  );
  const micCalls = audioFiles.filter((f) => {
    const text = read(f);
    return (
      /getUserMedia\(\s*\{[^}]*audio\s*:(?!\s*false\b)/.test(text) && !/voice-audio\.ts$/.test(f)
    );
  });
  check(
    "system",
    "one microphone owner",
    micCalls.length === 0,
    "only voice-audio.ts opens an audio stream",
    `another file opens a microphone: ${micCalls.join(", ")}`,
  );
  check(
    "system",
    "voice state machine",
    exists("src/lib/friday/voice-state.ts") &&
      /VoiceState/.test(read("src/lib/friday/voice-state.ts")),
    "one event-driven state machine",
    "voice-state.ts is missing",
  );
  check(
    "system",
    "hands-free starts off",
    /handsFree:\s*false/.test(read("src/lib/friday/assistant-mode.ts")),
    "the in-memory flag starts false",
    "handsFree does not start false",
  );
  const assistant = read("src/lib/friday/assistant-mode.ts");
  check(
    "system",
    "spoken task words are classified by the router",
    /classifyVoiceControl/.test(read("src/lib/friday/voice-engine/utterance-router.ts")),
    "the utterance router classifies the spoken task words",
    "utterance-router.ts does not use classifyVoiceControl",
  );
  for (const [needle, why] of [
    ["createRealtimeStt", "live captions"],
    ["createStreamingSpeak", "streaming voice"],
    ["createWakeFrameFeed", "live wake"],
    ["BargeShadow", "barge-in shadow"],
    ["voiceNotes", "voice notes"],
    ["StageClock", "stage stamps"],
    ["speakWithCloud", "cloud voice clips"],
    ["startVoiceTask", "background tasks"],
    ["routeUtterance", "spoken task words"],
    ["applyTaskRoute", "task routes"],
    ["SpeechArbiter", "one speech queue"],
  ])
    check(
      "system",
      `${why} is wired into Auto mode`,
      assistant.includes(needle),
      `${needle} is used by assistant-mode.ts`,
      `${needle} is not used by assistant-mode.ts`,
    );

  return rows;
}

function print(rows, log = console.log, { summary = false } = {}) {
  // Summary (inside `npm run setup`): the rows that need a look, then the count. A full pass is one line.
  const shown = summary ? rows.filter((r) => r.state !== "PASS") : rows;
  const width = Math.max(...shown.map((r) => r.name.length), 10);
  let layer = "";
  for (const r of shown) {
    if (r.layer !== layer) {
      layer = r.layer;
      log(`\n[${layer}]`);
    }
    log(`  ${r.state.padEnd(4)}  ${r.name.padEnd(width)}  ${r.detail}`);
  }
  const fails = rows.filter((r) => r.state === "FAIL");
  log(
    `\n${rows.length} rows: ${rows.filter((r) => r.state === "PASS").length} pass, ${fails.length} fail, ${rows.filter((r) => r.state === "INFO").length} info`,
  );
  return fails.length;
}

module.exports = {
  inventory,
  print,
  packageNames,
  verifiedBy,
  engineChains,
  engineRows,
  engineProof,
  languageRows,
  planView,
  VOICE_MODULES,
  BANNED_PACKAGES,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--root");
  const root = at >= 0 ? args[at + 1] : "";
  const probes = require("./doctor-probes.cjs");
  const rows = inventory({
    root,
    // The same plan Setup and the environment check read, so the language rows say "skipped on this PC" or MISSING by it.
    planData: root ? require("./prefetch-models.cjs").readPlanSync(process.env) : null,
    python: root ? probes.venvPython(process.env) : "",
    reach: (hosts) => probes.reachSync(hosts),
  });
  if (args.includes("--json")) {
    console.log(JSON.stringify(rows, null, 2));
    process.exitCode = rows.some((r) => r.state === "FAIL") ? 1 : 0;
  } else {
    process.exitCode = print(rows, console.log, { summary: args.includes("--summary") }) ? 1 : 0;
  }
}
