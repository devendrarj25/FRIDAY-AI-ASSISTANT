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
const path = require("node:path");

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

function ipcChannels(source, pattern) {
  return [...source.matchAll(pattern)].map((m) => m[1]);
}

const VOICE_CHANNEL = /^(voice|realtime|wake|stt|neural|sapi|speech|voiceprint)[:-]/;

function inventory({ root = "", platform = process.platform, env = process.env } = {}) {
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
    FRIDAY_PREFETCH_LLAMACPP: "1",
  };
  const plan = prefetch.prefetchPlan(root || "/friday", winEnv, "win32", {});
  const planned = new Set(plan.map((job) => job.id));
  for (const [id, why] of [
    ["smart-turn", "end-of-turn detector"],
    ["silero-vad", "speech detector"],
    ["stt-base", "fast listening"],
    ["stt-tiny", "lite listening fallback"],
    ["stt-small", "Hindi and Hinglish listening"],
    ["supertonic-3", "offline voice"],
    ["qwen2.5-1.5b-instruct", "the small chat model file"],
    ["llamacpp-runtime", "llama.cpp"],
    ["ollama-setup", "Ollama"],
  ])
    check(
      "setup",
      id,
      planned.has(id),
      `${why} is downloaded by npm run setup`,
      `${why} is NOT in the setup plan`,
    );
  for (const job of plan) {
    const src = job.job?.sources?.[0];
    const digest = Boolean(src?.sha256) || ["stt", "tts", "chat"].includes(job.kind);
    check(
      "setup",
      `${job.id} is verified`,
      digest,
      src?.sha256 ? "pinned SHA-256" : "checked against the publisher's listing",
      `${job.id} has no digest`,
    );
  }
  const bigStt = [...planned].filter((id) => /^stt-(medium|large)/.test(id));
  row("setup", "big speech sizes in the plan", "INFO", bigStt.length ? bigStt.join(", ") : "none");

  // ---- speech models on disk (only when a folder is given) -----------------------------------------------------
  if (root) {
    for (const job of plan) {
      const here = prefetch.alreadyThere(job);
      row("disk", job.id, here ? "PASS" : "FAIL", here ? "on disk" : "missing — run npm run setup");
    }
  }

  // ---- speech sizes: every list that names a size must agree with the weights map ---------------------------------
  const weights = require(path.join(REPO, "electron", "voice-weights.cjs"));
  const sizes = Object.keys(weights.STT_REPOS || {});
  const SIZE = /"(tiny|base|small|medium|large-v3-turbo|large-v3)"/g;
  const sizesIn = (text, startMarker, span) => {
    const at = text.indexOf(startMarker);
    return at < 0 ? [] : [...text.slice(at, at + span).matchAll(SIZE)].map((m) => m[1]);
  };
  const lists = {
    "kernel/stt.py known sizes": sizesIn(
      read("kernel/stt.py").replace(/'/g, '"'),
      "known = {",
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
    "src preferences sttSize": sizesIn(read("src/lib/friday/preferences.ts"), "sttSize:", 120),
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
  const modelRouter = read("electron/model-router.cjs");
  check(
    "router",
    "model router knows llama.cpp and Ollama as local",
    /"llamacpp"/.test(modelRouter) && /ollama/.test(modelRouter),
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
    /llamacpp/.test(billing) && /ollama/.test(billing),
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
  for (const [needle, why] of [
    ["createRealtimeStt", "live captions"],
    ["createStreamingSpeak", "streaming voice"],
    ["createWakeFrameFeed", "live wake"],
    ["BargeShadow", "barge-in shadow"],
    ["voiceNotes", "voice notes"],
    ["StageClock", "stage stamps"],
    ["speakWithCloud", "cloud voice clips"],
    ["startVoiceTask", "background tasks"],
    ["classifyVoiceControl", "spoken task words"],
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

function print(rows, log = console.log) {
  const width = Math.max(...rows.map((r) => r.name.length), 10);
  let layer = "";
  for (const r of rows) {
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

module.exports = { inventory, print, packageNames, BANNED_PACKAGES };

if (require.main === module) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--root");
  const rows = inventory({ root: at >= 0 ? args[at + 1] : "" });
  if (args.includes("--json")) {
    console.log(JSON.stringify(rows, null, 2));
    process.exitCode = rows.some((r) => r.state === "FAIL") ? 1 : 0;
  } else {
    process.exitCode = print(rows) ? 1 : 0;
  }
}
