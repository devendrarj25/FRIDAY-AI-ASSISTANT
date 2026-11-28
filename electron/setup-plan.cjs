/**
 * Setup plan: ONE plan for THIS PC, built from the measured hardware facts before setup downloads anything.
 *
 * `buildSetupPlan(facts, deps)` is pure and injectable. `facts` is the object `hardwareFacts` (electron/hardware.cjs)
 * returns; `deps` stands in for everything else (installed models, the pinned llama.cpp zip, the voice probe, the tier
 * table), so a test needs no hardware, no network and no disk. It never probes, never throws and never branches on a
 * graphics card's name: only vendor, driver number, compute capability and measured sizes count. An unknown fact never
 * rules a step out by itself; it is said in the plan.
 *
 * The plan answers four questions and one summary:
 *   llama      which llama.cpp build. The CUDA 12 / Vulkan / CPU chain is `llama-runtime.backendChain`. The SETUP default
 *              is the pinned CPU zip (config/local-runners.json, SHA-256 pinned). A GPU build is planned only when the
 *              PC has a qualifying card AND the line is usable; its zip digest is then read from the official release
 *              API at install time, verified, health-checked, and a failed build falls back one step down
 *              (electron/engine-install.cjs). Never a GPU build on a PC without a qualifying GPU.
 *   chat       which Ollama chat model (`chatModelFor`, table config/chat-tiers.json): the best tier whose weights plus
 *              20 percent fit the usable memory, judged on the TOTAL memory of this PC (video memory less 1 GB on a
 *              verified NVIDIA card, or on a dedicated AMD or Intel card through Vulkan, else RAM less what Windows,
 *              Electron and speech keep). Free memory never changes the tier: it only warns. Never a partial offload by
 *              default; a model already installed is kept when it is at least as good (never deleted or re-pulled).
 *              The plan also carries `numCtx` (context window that fits), `voice` (the small fast twin model) and
 *              `backend` (cuda, vulkan or cpu).
 *   packages   CUDA 12 libraries only with an NVIDIA GPU whose driver reports CUDA 12; the GPU stack by driver tier
 *              (`gpuStack`: CUDA 13 libraries from 580, the CUDA 12.9 extras from 576, DirectML below); the ONNX Runtime variant; heavy
 *              extras are listed as offered, not installed.
 *   voice      electron/voice-weights.cjs `voiceInstallPlan`, read only, its decision carried in the same object.
 *
 * A step is `install`, `present`, `keep`, `pull`, `offer-upgrade`, `defer` (offline, metered line, battery, health) or
 * `skip`; each with a reason. `describePlan` prints the "this PC" block and `toJSON` is the single hardware-derived
 * required set the Doctor reuses.
 */
"use strict";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
/** A download this big waits on a metered line, on battery, or while the PC is unhealthy (as engine-fit.cjs). */
const BIG_DOWNLOAD_BYTES = 500 * MIB;
/** Bytes the CUDA libraries need (config: electron/engine-install.cjs, read from PyPI). */
const CUDA_LIBS_BYTES = 553162896 + 696300805;
const ORT_BYTES = Object.freeze({ cpu: 16698767, directml: 25111930 });

/**
 * What a pinned wheel bundle of engine-install.cjs writes (the cp312 wheel of each part): the sizes of the CUDA 13 and
 * CUDA 12 stacks come from the pins, never from a second copy.
 */
function bundleBytes(bundleId) {
  const engines = require("./engine-install.cjs");
  const bundle = engines.PIP_BUNDLES[bundleId];
  if (!bundle) return 0;
  return bundle.parts.reduce((sum, part) => {
    const pin = engines.PINNED_WHEELS[part.pin || part.dist];
    const asset = pin?.assets.find((a) => /cp312|py3-none/.test(a.name)) || pin?.assets[0];
    return sum + (Number(asset?.bytes) || 0);
  }, 0);
}
/** What a GPU llama.cpp zip weighs, from the release pages (an estimate: the real size is read at install time). */
const LLAMA_GPU_APPROX_BYTES = Object.freeze({
  cuda: 650 * MIB,
  vulkan: 60 * MIB,
  "cuda-13.5-x64": 622 * MIB,
  "rocm-10.0-x64": 271 * MIB,
});
/** The llama.cpp release asset ids (decision D-9) a build step installs; CUDA steps carry theirs by driver. */
const LLAMA_ASSET_IDS = Object.freeze({
  cpu: "cpu-x64",
  vulkan: "vulkan-x64",
  rocm: "rocm-10.0-x64",
});
/** NVIDIA driver major version from which the CUDA 13.5 build runs. */
const CUDA13_MIN_DRIVER = 580;
const PLAN_SCHEMA = 1;
const INFO = "[friday] INFO     ";

const num = (value) => {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim()))
    return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const positive = (value) => {
  const n = num(value);
  return n !== null && n > 0 ? n : null;
};
const round1 = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);
const isRecord = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const gb = (bytes) => `${round1(bytes / GIB)} GB`;
const mb = (bytes) => `${Math.round(bytes / MIB)} MB`;

/* ------------------------------------------------------------------ config */

let tierMemo;
/** The chat tier table: `deps.tiers`, else config/chat-tiers.json through the shared config reader, else null. */
function loadTiers(deps = {}) {
  if (isRecord(deps.tiers)) return deps.tiers;
  if (tierMemo !== undefined) return tierMemo;
  tierMemo = null;
  try {
    const row = require("./resource-paths.cjs").readConfigJson("chat-tiers.json", null);
    if (isRecord(row?.value) && Array.isArray(row.value.tiers)) tierMemo = row.value;
  } catch {
    tierMemo = null;
  }
  return tierMemo;
}

/** The pinned llama.cpp release (`engine-install.llamaPin()` shape) or null; `deps.llamaPin` overrides it. */
function pinOf(deps) {
  if (deps.llamaPin !== undefined) return deps.llamaPin;
  try {
    return require("./engine-install.cjs").llamaPin();
  } catch {
    return null;
  }
}

/** True when the pinned llama.cpp release carries a native ARM64 CPU zip. */
const ARM64_CPU_ZIP = /-bin-win-cpu-arm64\.zip$/i;
const X64_CPU_ZIP = /-bin-win-cpu-x64\.zip$/i;
const hasNativeArm = (pin) =>
  Array.isArray(pin?.assets) && pin.assets.some((a) => ARM64_CPU_ZIP.test(String(a?.name ?? "")));

/* ------------------------------------------------------------------- facts */

/** "551.61" -> [551, 61]; null when it is not a version. */
function versionParts(value) {
  const m = /^(\d+)(?:\.(\d+))?/.exec(String(value ?? "").trim());
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : null;
}
const versionAtLeast = (have, want) => {
  const a = versionParts(have);
  const b = versionParts(want);
  if (!a || !b) return null;
  return a[0] !== b[0] ? a[0] > b[0] : a[1] >= b[1];
};

/**
 * The graphics cards of this PC, sorted out by what they can do. An integrated part (shared memory) counts as no GPU.
 *   nvidia   the NVIDIA card a CUDA build or a GPU chat model could use (largest memory), or null
 *   vulkan   cards a Vulkan build may use: a real device with at least 2 GB (or a card known to have 4 GB or more)
 */
function gpuView(f) {
  const rows = (Array.isArray(f.gpus) ? f.gpus : []).filter(isRecord);
  const real = rows.filter((g) => g.integrated !== true);
  const byMemory = (a, b) => (num(b.vramGb) ?? 0) - (num(a.vramGb) ?? 0);
  const nvidia = real.filter((g) => g.vendor === "nvidia").sort(byMemory)[0] || null;
  const vulkan = real.filter((g) => (num(g.vramGb) ?? 0) >= 2 || g.vramCapped === true);
  // A dedicated AMD or Intel card (not an APU whose "video memory" is a carve-out of RAM) a chat model may use.
  const vulkanChat =
    real
      .filter(
        (g) =>
          (g.vendor === "amd" || g.vendor === "intel") &&
          g.unifiedMemory !== true &&
          positive(g.vramGb) !== null,
      )
      .sort(byMemory)[0] || null;
  const dedicated = real.filter((g) => g.unifiedMemory !== true);
  return {
    rows,
    real,
    nvidia,
    vulkan,
    vulkanChat,
    multiGpu: dedicated.length > 1,
    integratedOnly: rows.length > 0 && real.length === 0,
  };
}

const networkOf = (f) => {
  const n = isRecord(f.network) ? f.network : {};
  return {
    online: n.online === false ? false : n.online === true ? true : null,
    metered: n.metered === true || n.roaming === true,
  };
};

/** Why a download of this size must wait right now, or "". Offline is handled by the caller. */
function waitReason(f, bytes) {
  const net = networkOf(f);
  if (net.online === false) return "this PC is offline";
  if (bytes < BIG_DOWNLOAD_BYTES) return "";
  if (net.metered) return "the connection is metered";
  const power = isRecord(f.power) ? f.power : {};
  if (power.batteryPresent === true && power.onAc === false) return "the PC is on battery";
  if (isRecord(f.health) && f.health.level === "critical")
    return "the PC is under heavy load or memory pressure";
  return "";
}

/* ------------------------------------------------------------- chat models */

function resolveAlias(tag, cfg) {
  const t = String(tag || "")
    .trim()
    .toLowerCase();
  const alias = isRecord(cfg?.aliases) ? cfg.aliases[t] : null;
  return typeof alias === "string" ? alias : t;
}

/**
 * A rough quality number for a tag: parameter count (a mixture of experts: the geometric mean of total and active)
 * times the family factor of the table. A heuristic to compare an installed model with the tier choice, not a
 * benchmark. null when the family or the size is not known (embedding models, unknown tags).
 */
function qualityOf(tag, cfg) {
  const [family, variant = ""] = resolveAlias(tag, cfg).split(":");
  const factor = num(cfg?.qualityFamilies?.[family]);
  if (!factor || factor <= 0) return null;
  const moe = /(?:^|-)(\d+(?:\.\d+)?)b-a(\d+(?:\.\d+)?)b/.exec(variant);
  const effective = /(?:^|-)e(\d+(?:\.\d+)?)b(?:-|$)/.exec(variant);
  const plain = /(?:^|-)(\d+(?:\.\d+)?)b(?:-|$)/.exec(variant);
  let size = null;
  if (moe) size = Math.sqrt(Number(moe[1]) * Number(moe[2]));
  else if (effective) size = Number(effective[1]);
  else if (plain) size = Number(plain[1]);
  return size === null ? null : Math.round(size * factor * 1000) / 1000;
}

/** Everything a tier table row or alternative knows about a tag, by its resolved name. */
function knownRows(cfg) {
  const out = new Map();
  for (const tier of cfg.tiers) {
    out.set(String(tier.tag).toLowerCase(), tier);
    for (const alt of Array.isArray(tier.alternatives) ? tier.alternatives : [])
      out.set(String(alt.tag).toLowerCase(), alt);
  }
  return out;
}

/** What Windows, Electron and speech keep of this much RAM: linear between the table's points, flat outside them. */
function reserveFor(ramTotal, rules) {
  const r = rules.cpuReserveGb || {};
  const points = [
    [4, num(r.at4) ?? 2],
    [8, num(r.at8) ?? 4.5],
    [16, num(r.at16) ?? 6],
  ];
  if (ramTotal <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i += 1) {
    if (ramTotal <= points[i][0]) {
      const [x0, y0] = points[i - 1];
      const [x1, y1] = points[i];
      return y0 + ((y1 - y0) * (ramTotal - x0)) / (x1 - x0);
    }
  }
  return points[points.length - 1][1];
}

/** The processor architecture the facts carry ("x64", "arm64"), or "". */
const archOf = (f) =>
  text(f.arch) || text(f.os?.arch) ? require("./llama-runtime.cjs").archOf(f) : "";

/**
 * A cap on the size of a model that runs on the CPU: no AVX2 (llama.cpp falls back to its plain build) and ARM64
 * Windows (the x64 build runs by emulation; `arm64Native` is true when a native ARM64 build is pinned, which lifts
 * the cap to the row's `native*` figures). `{ maxGb, notes }`; maxGb is null when nothing caps this PC.
 */
function cpuCapFor(f, rules, arm64Native = false) {
  const caps = isRecord(rules.cpuCaps) ? rules.cpuCaps : {};
  const hits = [];
  if (/^arm/i.test(archOf(f)) && isRecord(caps.arm64)) {
    const a = caps.arm64;
    const native = arm64Native && num(a.nativeMaxDownloadGb) !== null;
    hits.push(
      native
        ? {
            maxDownloadGb: a.nativeMaxDownloadGb,
            lowClassMaxDownloadGb: a.nativeLowClassMaxDownloadGb ?? a.lowClassMaxDownloadGb,
            note: a.nativeNote,
          }
        : a,
    );
  }
  if (isRecord(f.cpu) && f.cpu.avx2 === false && isRecord(caps.noAvx2)) hits.push(caps.noAvx2);
  if (!hits.length) return { maxGb: null, notes: [] };
  const weak = f.cpuClass === "low";
  const limits = hits
    .map((h) =>
      weak ? (num(h.lowClassMaxDownloadGb) ?? num(h.maxDownloadGb)) : num(h.maxDownloadGb),
    )
    .filter((v) => v !== null);
  let variant = "";
  try {
    variant = require("./llama-runtime.cjs").cpuVariant(f);
  } catch {
    variant = "";
  }
  return {
    maxGb: limits.length ? Math.min(...limits) : null,
    notes: [
      ...hits.map((h) => text(h.note)).filter(Boolean),
      ...(variant ? [`llama.cpp runs its ${variant} CPU build on this PC`] : []),
    ],
  };
}

/**
 * The memory plan of this PC for a chat model, from TOTAL memory: a verified NVIDIA card or a dedicated AMD or Intel
 * card through Vulkan (video memory), else the CPU (RAM). Free memory is carried as `freeUsableGb` to warn with; it
 * never decides the tier.
 */
function memoryFor(f, cfg, view) {
  const rules = cfg.rules || {};
  const margin = num(rules.weightsMargin) ?? 1.2;
  const notes = [];
  const ramTotalKnown = positive(f.ramGb);
  const ramTotal = ramTotalKnown ?? 8;
  if (ramTotalKnown === null)
    notes.push("the memory of this PC is unknown, so it is treated as an 8 GB PC");
  const ramFree = positive(f.ramFreeGb);
  const freeHeadroom = num(rules.cpuFreeHeadroomGb) ?? 1;
  const cpuUsable = ramTotal - reserveFor(ramTotal, rules);

  // A verified NVIDIA card: CUDA 12 driver, the compute capability and the driver Ollama needs, memory measured.
  // Ollama's rule (https://docs.ollama.com/gpu, read 2026-11-28): compute capability 5.0+, driver 550+, and driver
  // 570+ for compute capability 5.0 to 6.2.
  const card = view.nvidia;
  const minCc = num(rules.ollamaMinComputeCap) ?? 5;
  const legacyCc = num(rules.ollamaLegacyCcMax) ?? 6.2;
  const minDriver =
    num(card?.computeCap) !== null && card.computeCap <= legacyCc
      ? (rules.ollamaMinDriverLegacyCc ?? "570")
      : (rules.ollamaMinDriver ?? "550");
  let gpu = null;
  let gpuWhy = "";
  const sameCard = (g) => !f.gpuName || !g.name || f.gpuName === g.name;
  if (!card) {
    gpuWhy = view.integratedOnly
      ? "the only graphics part is integrated (shared memory)"
      : "no NVIDIA graphics card was found";
    // A dedicated AMD or Intel card: Ollama's Vulkan backend. Speed is estimated, not measured.
    const alt = view.vulkanChat;
    const vulkanMin = num(rules.vulkanGpuMinTotalGb) ?? 6;
    if (alt && f.vulkan !== false) {
      if (alt.vramGb < vulkanMin)
        gpuWhy = `${alt.vramGb} GB of video memory is below the ${vulkanMin} GB a Vulkan chat model needs`;
      else {
        const free = sameCard(alt) ? positive(f.vramFreeGb) : null;
        const headroom = num(rules.vulkanHeadroomGb) ?? 1.5;
        gpu = {
          backend: "vulkan",
          estimated: true,
          totalGb: alt.vramGb,
          freeGb: free,
          usableGb: round1(alt.vramGb - headroom),
          freeUsableGb: free === null ? null : round1(free - headroom),
        };
        gpuWhy = "";
        notes.push("the graphics card runs the chat model through Vulkan: speed is estimated");
      }
    }
  } else if (f.cudaReady !== true) gpuWhy = "the NVIDIA driver does not support CUDA 12";
  else if (!(positive(card.vramGb) > 0)) gpuWhy = "the card's video memory could not be measured";
  else if (num(card.computeCap) !== null && card.computeCap < minCc)
    gpuWhy = `compute capability ${card.computeCap} is below ${minCc}`;
  else if (versionAtLeast(card.driver, minDriver) === false)
    gpuWhy = `driver ${card.driver} is older than ${minDriver}, which Ollama needs`;
  else if (card.vramGb < (num(rules.gpuMinTotalGb) ?? 3.5))
    gpuWhy = `${card.vramGb} GB of video memory is too little for a chat model`;
  else {
    const total = card.vramGb;
    const free = sameCard(card) ? positive(f.vramFreeGb) : null;
    const headroom = num(rules.gpuHeadroomGb) ?? 1;
    gpu = {
      backend: "cuda",
      estimated: false,
      totalGb: total,
      freeGb: free,
      usableGb: round1(total - headroom),
      freeUsableGb: free === null ? null : round1(free - headroom),
    };
  }
  if (view.multiGpu && gpu)
    notes.push(
      "several graphics cards were found: only the largest one is used for the chat model",
    );
  return {
    margin,
    notes,
    ramTotal,
    cpu: {
      totalGb: ramTotal,
      freeGb: ramFree,
      usableGb: round1(cpuUsable),
      freeUsableGb: ramFree === null ? null : round1(ramFree - freeHeadroom),
    },
    gpu,
    gpuWhy,
  };
}

/** The notes `chatModelFor` returns for one alternative: fits, needs a split (mixture of experts only) or does not fit. */
function judgeAlternatives(tier, mem, device, rules, diskAvail) {
  const usable = device === "gpu" ? mem.gpu.usableGb : mem.cpu.usableGb;
  const diskFactor = num(rules.diskFactor) ?? 1.3;
  const fit = [];
  const rejected = [];
  for (const alt of Array.isArray(tier.alternatives) ? tier.alternatives : []) {
    const need = alt.downloadGb * mem.margin;
    const row = {
      tag: alt.tag,
      downloadGb: alt.downloadGb,
      ...(alt.note ? { note: alt.note } : {}),
      ...(alt.textOnly ? { textOnly: true } : {}),
    };
    if (alt.downloadGb * diskFactor > diskAvail)
      rejected.push({ tag: alt.tag, reason: "not enough free disk space" });
    else if (need <= usable) fit.push(row);
    else if (alt.moe === true && device === "gpu" && need <= usable + Math.max(0, mem.cpu.usableGb))
      fit.push({
        ...row,
        split: true,
        note: `${alt.note ? alt.note + "; " : ""}needs a CPU/GPU split, so it is an option, not the default`,
      });
    else
      rejected.push({
        tag: alt.tag,
        reason:
          alt.needsSplit === true
            ? "it would spill to the CPU, and a dense model that spills is several times slower"
            : `needs about ${round1(need)} GB, ${round1(usable)} GB is usable`,
      });
  }
  return { alternatives: fit, rejectedAlternatives: rejected };
}

/**
 * The context window (num_ctx) that fits: the largest ladder step within half of the memory left after the weights
 * (one token of key-value cache costs the row's `kvKbPerToken`), the model's native context and the device cap
 * (the CPU stays at 16k: prompt processing there is slow). A PC under 6 GB of RAM gets 2k and under 9 GB 4k, as
 * kernel/router.py does. The ladder's first step is the floor.
 */
function numCtxFor(tier, mem, device, spareGb, rules) {
  const n = isRecord(rules.numCtx) ? rules.numCtx : {};
  const ladder = (Array.isArray(n.ladder) ? n.ladder : [2048, 4096, 8192, 16384, 32768, 65536])
    .filter((v) => Number.isInteger(v) && v > 0)
    .sort((a, b) => a - b);
  const kv = positive(tier.kvKbPerToken) ?? positive(n.defaultKvKbPerToken) ?? 64;
  const share = num(n.spareShare) ?? 0.5;
  // A row's fixed cache (sliding-window layers hold a constant window, whatever num_ctx is) comes off the spare first.
  const fixed = positive(tier.kvFixedGb) ?? 0;
  let limit = Math.floor((Math.max(0, spareGb - fixed) * share * 1024 * 1024) / kv);
  limit = Math.min(
    limit,
    positive(tier.contextK) ? tier.contextK * 1024 : Infinity,
    device === "gpu" ? (num(n.gpuCap) ?? Infinity) : (num(n.cpuCap) ?? 16384),
  );
  if (device === "cpu")
    for (const [ceiling, cap] of Array.isArray(n.smallRamCaps) ? n.smallRamCaps : [])
      if (mem.ramTotal < ceiling) {
        limit = Math.min(limit, cap);
        break;
      }
  let pick = ladder[0];
  for (const rung of ladder) if (rung <= limit) pick = rung;
  return pick;
}

/**
 * The small fast twin model for the quick spoken lane: `{ voice: { tag, sizeGb, ctx, device, needGb } | null, why }`.
 * Null when the row has none (the main model is already 2b or smaller), the disk cannot take both, or the memory
 * cannot hold both: then the smaller model wins and answers alone.
 */
function voiceTwinFor(chosen, device, mem, usable, need, rules, diskAvail, diskFactor) {
  const v = isRecord(chosen.voice) ? chosen.voice : null;
  if (!v || !text(v.tag) || !(v.downloadGb > 0) || v.tag === chosen.tag)
    return { voice: null, why: "the main model is already small and fast, so it needs no twin" };
  if ((chosen.downloadGb + v.downloadGb) * diskFactor > diskAvail)
    return { voice: null, why: "not enough free disk space for the fast voice twin" };
  const twinNeed = round1(v.downloadGb * mem.margin);
  const row = (where) => ({
    tag: v.tag,
    sizeGb: v.downloadGb,
    ctx: num(rules.voiceCtx) ?? 4096,
    device: where,
    needGb: twinNeed,
  });
  if (need + twinNeed <= usable + 1e-9) return { voice: row(device), why: "" };
  if (device === "gpu" && twinNeed <= mem.cpu.usableGb + 1e-9)
    return { voice: row("cpu"), why: "" };
  return {
    voice: null,
    why: `memory cannot hold ${chosen.tag} and ${v.tag} together, so the smaller model answers alone`,
  };
}

/**
 * The chat model for this PC from the tier table: `{ tag, reason, alternatives, needs, numCtx, voice, backend, ... }`
 * (tag is null when no tier fits). Pure. The tier follows the TOTAL memory (free memory only adds `warn`).
 * `options.tiers` overrides the table, `options.diskReserveGb` is disk other downloads of the same setup already
 * take (before the 1.3 factor).
 */
function chatModelFor(facts, options = {}) {
  const f = isRecord(facts) ? facts : {};
  const cfg = loadTiers(options);
  if (!cfg)
    return {
      tag: null,
      reason: "the chat tier table (config/chat-tiers.json) could not be read",
      alternatives: [],
      rejectedAlternatives: [],
      needs: null,
      device: null,
      numCtx: null,
      voice: null,
    };
  const rules = cfg.rules || {};
  const view = gpuView(f);
  const mem = memoryFor(f, cfg, view);
  const cap = cpuCapFor(f, rules, options.arm64Native ?? hasNativeArm(pinOf(options)));
  const diskFactor = num(rules.diskFactor) ?? 1.3;
  const diskFree = positive(f.diskFreeGb);
  const diskAvail =
    diskFree === null
      ? Infinity
      : diskFree - (num(rules.diskReserveGb) ?? 1) - Math.max(0, num(options.diskReserveGb) ?? 0);
  const marginOf = (tier) => num(tier.weightsMargin) ?? mem.margin;
  const needOf = (tier) => tier.downloadGb * marginOf(tier);
  const fits = (tier, usable, device) =>
    needOf(tier) <= usable + 1e-9 &&
    tier.downloadGb * diskFactor <= diskAvail + 1e-9 &&
    (device !== "cpu" || cap.maxGb === null || tier.downloadGb <= cap.maxGb + 1e-9);
  const byDevice = (device) =>
    cfg.tiers
      .filter((t) => t.device === device)
      .sort((a, b) => num(b.minTotalGb) - num(a.minTotalGb) || b.downloadGb - a.downloadGb);

  let chosen = null;
  let device = null;
  let gpuNote = "";
  if (mem.gpu) {
    chosen =
      byDevice("gpu").find(
        (t) => mem.gpu.totalGb >= t.minTotalGb && fits(t, mem.gpu.usableGb, "gpu"),
      ) || null;
    device = chosen ? "gpu" : null;
    // A card too small to carry a worthwhile model lets the CPU run a small one (only tiers marked for that, and
    // only when the CPU model is the better one).
    const cpuTier =
      byDevice("cpu").find(
        (t) =>
          t.gpuPcCpuFallback === true &&
          mem.ramTotal >= t.minTotalGb &&
          fits(t, mem.cpu.usableGb, "cpu"),
      ) || null;
    const better = (a, b) => {
      const qa = qualityOf(a.tag, cfg);
      const qb = qualityOf(b.tag, cfg);
      return qa !== null && qb !== null ? qa > qb : a.downloadGb > b.downloadGb;
    };
    if (cpuTier && (!chosen || better(cpuTier, chosen))) {
      gpuNote = `the card's usable video memory (${mem.gpu.usableGb} GB) is too small for a model worth running on it, so the CPU runs it`;
      chosen = cpuTier;
      device = "cpu";
    }
  } else {
    chosen =
      byDevice("cpu").find(
        (t) => mem.ramTotal >= t.minTotalGb && fits(t, mem.cpu.usableGb, "cpu"),
      ) || null;
    device = chosen ? "cpu" : null;
  }

  const memoryLine = (usable, kind) => `${round1(usable)} GB of ${kind} usable`;
  if (!chosen) {
    const smallest = [...cfg.tiers].sort((a, b) => a.downloadGb - b.downloadGb)[0];
    const diskBlocked = smallest && smallest.downloadGb * diskFactor > diskAvail;
    return {
      tag: null,
      reason: diskBlocked
        ? `not enough free disk space for even the smallest chat model (${smallest.tag}, ${smallest.downloadGb} GB); free some space, then run setup again`
        : `no local chat model fits: ${mem.gpu ? memoryLine(mem.gpu.usableGb, "video memory") : memoryLine(mem.cpu.usableGb, "RAM")}; FRIDAY uses a cloud model or the extractive answer here`,
      alternatives: [],
      rejectedAlternatives: [],
      needs: null,
      device: null,
      backend: null,
      numCtx: null,
      voice: null,
      memory: {
        mode: mem.gpu ? "gpu" : "cpu",
        usableGb: mem.gpu ? mem.gpu.usableGb : mem.cpu.usableGb,
      },
      notes: [
        ...mem.notes,
        ...(mem.gpu ? [] : [`no GPU is used for chat: ${mem.gpuWhy}`]),
        ...cap.notes,
      ],
    };
  }

  const usable = device === "gpu" ? mem.gpu.usableGb : mem.cpu.usableGb;
  const freeUsable = device === "gpu" ? mem.gpu.freeUsableGb : mem.cpu.freeUsableGb;
  const need = round1(needOf(chosen));
  const spare = round1(usable - need);
  const twin = voiceTwinFor(
    chosen,
    device,
    mem,
    usable,
    needOf(chosen),
    rules,
    diskAvail,
    diskFactor,
  );
  const twinHere = twin.voice && twin.voice.device === device ? twin.voice.needGb : 0;
  const numCtx = numCtxFor(chosen, mem, device, usable - needOf(chosen) - twinHere, rules);
  const judged = judgeAlternatives(chosen, mem, device, rules, diskAvail);
  const backend = device === "gpu" ? mem.gpu.backend : "cpu";
  const estimated = device === "gpu" ? mem.gpu.estimated === true : chosen.speed === "estimated";
  const where =
    device === "gpu" ? `${memoryLine(usable, "video memory")}` : `${memoryLine(usable, "RAM")}`;
  const kind = device === "gpu" ? "video memory" : "RAM";
  const warn =
    freeUsable !== null && freeUsable < need + twinHere
      ? `only ${Math.max(0, freeUsable)} GB of ${kind} is free right now and ${chosen.tag} needs about ${need} GB: close other apps for the best speed (the planned model does not change)`
      : "";
  return {
    tag: chosen.tag,
    tier: chosen.id,
    device,
    backend,
    estimated,
    reason: `${chosen.label}: ${chosen.tag} (${chosen.downloadGb} GB download, about ${need} GB in memory) fits in ${where}${gpuNote ? `; ${gpuNote}` : ""}${device === "cpu" && mem.gpuWhy && !gpuNote ? `; the GPU is not used for chat: ${mem.gpuWhy}` : ""}${backend === "vulkan" ? "; through Vulkan, speed is estimated" : ""}`,
    ...judged,
    needs: {
      downloadGb: chosen.downloadGb,
      diskGb: round1(chosen.downloadGb * diskFactor),
      memoryGb: need,
      memoryKind: device === "gpu" ? "vram" : "ram",
      runner: "ollama",
    },
    contextK: chosen.contextK,
    numCtx,
    voice: twin.voice,
    ...(twin.voice ? {} : { voiceWhy: twin.why }),
    capabilities: [...(chosen.capabilities || [])],
    licence: chosen.licence || null,
    memory: {
      mode: device,
      usableGb: usable,
      freeUsableGb: freeUsable,
      needGb: need,
      spareGb: spare,
    },
    tight: spare < 1,
    ...(warn ? { warn } : {}),
    unverified: chosen.unverified || "memory and speed are estimates",
    notes: [
      ...mem.notes,
      ...(gpuNote ? [gpuNote] : []),
      ...(device === "cpu" ? cap.notes : []),
      ...(warn ? [warn] : []),
    ],
  };
}

/**
 * The tags of the small fast voice twin models: `voice.tags` of config/chat-tiers.json plus any tag a tier row names
 * as its `voice` (the same list the kernel and the model router read). Lower case, no repeats, never throws.
 */
function voiceModelTags(options = {}) {
  const cfg = loadTiers(options);
  const out = [];
  const add = (tag) => {
    const t = typeof tag === "string" ? tag.trim().toLowerCase() : "";
    if (t && !out.includes(t)) out.push(t);
  };
  if (!cfg) return out;
  for (const tag of Array.isArray(cfg.voice?.tags) ? cfg.voice.tags : []) add(tag);
  for (const tier of cfg.tiers) add(tier?.voice?.tag);
  return out;
}

/** The Ollama options FRIDAY applies when it starts or calls Ollama (recorded, never forced on the owner's own setup). */
function ollamaSettingsFor(pick, cfg) {
  const s = cfg?.ollamaSettings || {};
  const smallGpu =
    pick?.device === "gpu" && (num(pick.memory?.usableGb) ?? 99) + 1 <= (num(s.smallGpuGb) ?? 8);
  const env = {
    ...(s.env?.OLLAMA_FLASH_ATTENTION
      ? { OLLAMA_FLASH_ATTENTION: String(s.env.OLLAMA_FLASH_ATTENTION) }
      : {}),
    ...(s.env?.OLLAMA_KV_CACHE_TYPE
      ? { OLLAMA_KV_CACHE_TYPE: String(s.env.OLLAMA_KV_CACHE_TYPE) }
      : {}),
    ...(smallGpu && s.env?.OLLAMA_MAX_LOADED_MODELS_SMALL_GPU
      ? { OLLAMA_MAX_LOADED_MODELS: String(s.env.OLLAMA_MAX_LOADED_MODELS_SMALL_GPU) }
      : {}),
  };
  // The recorded window is the config default (8192); the window this PC can carry is `chat.numCtx`, the field
  // the callers that start or call Ollama read (kernel/router.py keeps its own RAM caps until they do).
  return {
    forced: false,
    options: { num_ctx: s.options?.num_ctx ?? 8192 },
    keep_alive: s.keep_alive ?? "30m",
    env,
  };
}

/** Models already in Ollama as `[{ tag, weightsGb|null }]`, from tag strings or `{ name|model, size }` rows. */
function normalizeInstalled(list, cfg) {
  const known = knownRows(cfg);
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const name = typeof raw === "string" ? raw : text(raw?.name) || text(raw?.model);
    if (!name) continue;
    const tag = resolveAlias(name, cfg);
    if (seen.has(tag)) continue;
    seen.add(tag);
    const bytes = isRecord(raw) ? positive(raw.size) : null;
    const listed = known.get(tag)?.downloadGb;
    out.push({ name, tag, weightsGb: bytes !== null ? bytes / GIB : (listed ?? null) });
  }
  return out;
}

/** The chat step of the plan: the tier choice, what is installed, and what setup does about it. */
function planChat(f, deps, ctx) {
  const cfg = loadTiers(deps);
  const pick = chatModelFor(f, {
    ...(cfg ? { tiers: cfg } : {}),
    ...(deps.llamaPin !== undefined ? { llamaPin: deps.llamaPin } : {}),
    diskReserveGb: ctx.diskReserveGb,
  });
  const base = {
    runner: "ollama",
    ...pick,
    settings: ollamaSettingsFor(pick, cfg),
    installed: null,
    use: null,
  };
  if (!cfg) return { ...base, action: "none" };
  const rules = cfg.rules || {};
  const margin = num(rules.weightsMargin) ?? 1.2;
  const installed = normalizeInstalled(deps.installedModels, cfg);
  const pickQuality = pick.tag ? qualityOf(pick.tag, cfg) : null;

  // The best installed chat model that fits this PC's memory right now.
  const usable = pick.memory?.usableGb;
  const candidates = installed
    .map((m) => ({ ...m, quality: qualityOf(m.tag, cfg) }))
    .filter((m) => m.quality !== null)
    .filter(
      (m) => m.weightsGb === null || usable === undefined || m.weightsGb * margin <= usable + 1e-9,
    )
    .sort((a, b) => b.quality - a.quality);
  const best = candidates[0] || null;
  const offline = networkOf(f).online === false;
  const ratio = num(rules.upgradeOfferRatio) ?? 0.6;
  const wait = pick.tag ? waitReason(f, pick.needs.downloadGb * GIB) : "";

  if (!pick.tag) {
    return best
      ? {
          ...base,
          action: "keep",
          use: best.name,
          installed: best.name,
          reason: `${pick.reason}; the installed ${best.name} stays in use`,
        }
      : { ...base, action: "none" };
  }
  if (best && pickQuality !== null && best.quality >= pickQuality) {
    return {
      ...base,
      action: "keep",
      use: best.name,
      installed: best.name,
      reason: `${best.name} is already installed and is at least as good as ${pick.tag}; it is kept and nothing is pulled`,
    };
  }
  if (best && pickQuality !== null && best.quality >= ratio * pickQuality) {
    return {
      ...base,
      action: "offer-upgrade",
      use: best.name,
      installed: best.name,
      offer: pick.tag,
      reason: `${best.name} is installed and works on this PC; ${pick.tag} is newer and better for it (${pick.reason}); it is offered, not pulled, and ${best.name} is never deleted`,
    };
  }
  if (offline)
    return {
      ...base,
      action: best ? "keep" : "defer",
      use: best ? best.name : null,
      installed: best ? best.name : null,
      deferReason: "this PC is offline",
      reason: best
        ? `offline: the installed ${best.name} stays in use; ${pick.tag} is pulled when this PC is online`
        : `offline: ${pick.tag} is pulled when this PC is online`,
    };
  if (wait)
    return {
      ...base,
      action: "defer",
      use: best ? best.name : null,
      installed: best ? best.name : null,
      deferReason: wait,
      reason: `${pick.tag} (${pick.needs.downloadGb} GB) waits: ${wait}`,
    };
  return { ...base, action: "pull", installed: best ? best.name : null, use: pick.tag };
}

/* ------------------------------------------------------------------- llama */

/**
 * Names each step of `llama-runtime.backendChain` (which owns the order, decision D-9: CUDA, ROCm, Vulkan, the ARM64
 * CPU build, CPU last) with the release asset id it installs (`assetId`, and `runtimeAssetId` for the CUDA runtime
 * zip). CUDA 13.5 is named when the driver reports CUDA 13 (else when its version is 580 or newer), CUDA 12.4 below.
 */
function nameLlamaChain(chain, f, view) {
  const card = view.nvidia;
  const major = versionParts(card?.driver ?? f.driverVersion)?.[0] ?? 0;
  const level = (step) => step.driverCuda ?? versionParts(f.cuda?.driverCuda)?.[0] ?? null;
  return chain.map((s) => {
    if (s.backend === "cuda") {
      const known = level(s);
      const generation =
        known !== null ? (known >= 13 ? 13 : 12) : major >= CUDA13_MIN_DRIVER ? 13 : 12;
      return {
        ...s,
        assetId: generation === 13 ? "cuda-13.5-x64" : "cuda-12.4-x64",
        runtimeAssetId: generation === 13 ? "cudart-13.5-x64" : "cudart-12.4-x64",
        cudaGeneration: generation,
      };
    }
    return { ...s, assetId: s.assetId || LLAMA_ASSET_IDS[s.backend] || LLAMA_ASSET_IDS.cpu };
  });
}

/** The llama.cpp step: the pinned CPU zip, or a GPU build with a digest verified at install time, with fallbacks. */
function planLlama(f, deps) {
  const llama = require("./llama-runtime.cjs");
  const view = gpuView(f);
  // Only real devices reach the chain: an integrated part is never a reason for a GPU build.
  const chainFacts = {
    ...f,
    gpus: view.real.filter((g) => view.vulkan.includes(g) || g.vendor === "nvidia"),
  };
  const built = llama.backendChain(chainFacts);
  const chain = nameLlamaChain(built.chain, f, view);
  const skipped = built.skipped;
  const pin = pinOf(deps);
  const assets = Array.isArray(pin?.assets) ? pin.assets : [];
  const arm = /^arm/i.test(archOf(f));
  const nativeArm = arm ? assets.find((a) => ARM64_CPU_ZIP.test(String(a?.name ?? ""))) : null;
  const pinned =
    nativeArm || assets.find((a) => X64_CPU_ZIP.test(String(a?.name ?? ""))) || assets[0] || null;
  const pinnedStep = {
    backend: "cpu",
    variant: nativeArm ? "cpu-arm64" : "cpu",
    assetId: nativeArm ? "cpu-arm64" : "cpu-x64",
    source: pinned ? "pinned" : "release-api",
    digest: pinned ? "pinned-sha256" : "release-api-sha256",
    ...(pinned
      ? { asset: pinned.name, tag: pin.tag, bytes: pinned.bytes, sha256: pinned.sha256 }
      : {}),
  };
  const first = chain[0];
  const cpuVariant = nativeArm ? "cpu-arm64" : chain[chain.length - 1]?.variant || "cpu";
  const out = { chain: chain.map((s) => s.backend), cpuVariant, skipped: [...skipped] };
  if (arm && !nativeArm)
    out.skipped.push({
      backend: "cpu",
      reason: "no native ARM64 llama.cpp build is pinned: the x64 build runs by x64 emulation",
    });
  const present = deps.installed?.llama === true;
  const net = networkOf(f);

  let step = pinnedStep;
  let why = pinned
    ? `the pinned CPU build ${pinned.name} (SHA-256 pinned)`
    : "the CPU build, digest read from the official release API";
  if (first && first.backend !== "cpu") {
    const approx =
      LLAMA_GPU_APPROX_BYTES[first.assetId] || LLAMA_GPU_APPROX_BYTES[first.backend] || 0;
    const wait = waitReason(f, approx);
    if (wait || net.online === false) {
      out.skipped.push({
        backend: first.backend,
        reason: `${first.backend} build is offered later: ${wait || "this PC is offline"}`,
      });
      out.offered = { backend: first.backend, reason: wait || "this PC is offline" };
    } else if (positive(f.diskFreeGb) !== null && (approx * 1.3) / GIB > f.diskFreeGb - 1) {
      out.skipped.push({
        backend: first.backend,
        reason: "not enough free disk space for the GPU build",
      });
    } else {
      step = {
        backend: first.backend,
        variant: first.variant,
        assetId: first.assetId,
        ...(first.runtimeAssetId ? { runtimeAssetId: first.runtimeAssetId } : {}),
        source: "release-api",
        digest: "release-api-sha256",
        approxBytes: approx,
        verified:
          "the zip digest is read from the official release API at install time, SHA-256 verified, health-checked",
      };
      const label =
        first.backend === "cuda"
          ? `the CUDA ${first.cudaGeneration || 12} build`
          : first.backend === "rocm"
            ? "the ROCm build"
            : "the Vulkan build";
      why = `${label}, digest read from the official release API at install time; a build that fails its check is removed and the next step down is tried`;
      out.fallbacks = [
        ...chain
          .slice(1)
          .filter((s) => s.backend !== "cpu")
          .map((s) => s.backend),
        "cpu-pinned",
      ];
    }
  }
  const bytes = step.source === "pinned" ? Number(pinned?.bytes) || 0 : step.approxBytes || 0;
  let action = "install";
  let deferReason = "";
  if (present) action = "present";
  else if (net.online === false) {
    action = "defer";
    deferReason = "this PC is offline";
  }
  return {
    ...out,
    action,
    ...(deferReason ? { deferReason } : {}),
    install: step,
    bytes,
    reason: why,
  };
}

/* ---------------------------------------------------------------- packages */

function planPackages(f, deps, tight = false) {
  const view = gpuView(f);
  const cuda = isRecord(f.cuda) ? f.cuda : {};
  const card = view.nvidia;
  const skipped = [];
  const offered = [];
  const net = networkOf(f);

  // CUDA 12 libraries: only with an NVIDIA card whose driver reports CUDA 12 (and the compute floor the catalogue uses).
  let cudaLibs;
  const libsPresent =
    cuda.runtimeFilesFound === true ||
    f.cudaRuntimeFilesFound === true ||
    (cuda.cublas12 === true && cuda.cudnn9 === true);
  if (!card) {
    cudaLibs = {
      action: "skip",
      reason: "no NVIDIA graphics card was found, so the CUDA libraries are not installed",
    };
  } else if (f.cudaReady !== true) {
    cudaLibs = { action: "skip", reason: "the NVIDIA driver does not report CUDA 12 or newer" };
  } else if (num(card.computeCap) !== null && card.computeCap < 7.5) {
    cudaLibs = {
      action: "skip",
      reason: `compute capability ${card.computeCap} is below 7.5, which the CUDA 12 libraries here need`,
    };
  } else if (libsPresent) {
    cudaLibs = { action: "present", reason: "cuBLAS 12 and cuDNN 9 files were found on this PC" };
  } else {
    const wait = waitReason(f, CUDA_LIBS_BYTES);
    const room = positive(f.diskFreeGb);
    if (wait)
      cudaLibs = {
        action: "defer",
        deferReason: wait,
        bytes: CUDA_LIBS_BYTES,
        reason: `the CUDA libraries (${gb(CUDA_LIBS_BYTES)}) wait: ${wait}`,
      };
    else if (tight)
      cudaLibs = {
        action: "skip",
        reason:
          "the disk is tight, so the chat model comes first; the CUDA libraries wait for the Install Manager",
      };
    else if (room !== null && (CUDA_LIBS_BYTES * 1.3) / GIB > room - 1)
      cudaLibs = {
        action: "skip",
        reason: `not enough free disk space for the CUDA libraries (${gb(CUDA_LIBS_BYTES * 1.3)} needed)`,
      };
    else
      cudaLibs = {
        action: "install",
        bytes: CUDA_LIBS_BYTES,
        reason: `NVIDIA driver supports CUDA 12; cuBLAS 12 and cuDNN 9 (${gb(CUDA_LIBS_BYTES)}) are installed with pinned hashes`,
      };
  }
  if (cudaLibs.action === "skip") skipped.push({ id: "cuda-libs", reason: cudaLibs.reason });

  // The GPU stack the driver can run (engine-install.cjs gpuStackFor, decision D-8): CUDA 13 libraries with ONNX Runtime
  // 1.32.0 from driver 580, the CUDA 12.9 extras with ONNX Runtime 1.26.0 for 576 to 579, DirectML below that or when
  // the driver version is unknown. The speech libraries above (CUDA 12, for the ear) are the same on every tier.
  const stack = card
    ? require("./engine-install.cjs").gpuStackFor(card.driver ?? f.driverVersion)
    : { tier: "none", bundles: [] };
  const ortLibsId =
    stack.tier === "cuda13" ? "cuda13-libs" : stack.tier === "cuda12" ? "cuda12-ort-libs" : null;
  const ortLibsBytes = ortLibsId ? bundleBytes(ortLibsId) : 0;
  const ortLibsLabel = stack.tier === "cuda13" ? "CUDA 13" : "CUDA 12";
  let ortLibs;
  if (!ortLibsId) {
    ortLibs = {
      id: null,
      action: "skip",
      reason: card
        ? "the NVIDIA driver is older than 576 or unknown, so the CUDA ONNX Runtime libraries are not installed; DirectML is used"
        : "no NVIDIA graphics card was found",
    };
  } else if (cudaLibs.action === "skip") {
    ortLibs = { id: ortLibsId, action: "skip", reason: cudaLibs.reason };
  } else if (deps.installed?.[ortLibsId] === true) {
    ortLibs = {
      id: ortLibsId,
      action: "present",
      reason: `the ${ortLibsLabel} runtime libraries are already installed`,
    };
  } else {
    const wait = waitReason(f, ortLibsBytes);
    const room = positive(f.diskFreeGb);
    const base = { id: ortLibsId, bytes: ortLibsBytes };
    if (wait)
      ortLibs = {
        ...base,
        action: "defer",
        deferReason: wait,
        reason: `the ${ortLibsLabel} runtime libraries (${gb(ortLibsBytes)}) wait: ${wait}`,
      };
    else if (tight)
      ortLibs = {
        ...base,
        action: "skip",
        reason: `the disk is tight, so the chat model comes first; the ${ortLibsLabel} runtime libraries wait for the Install Manager`,
      };
    else if (room !== null && (ortLibsBytes * 1.3) / GIB > room - 1)
      ortLibs = {
        ...base,
        action: "skip",
        reason: `not enough free disk space for the ${ortLibsLabel} runtime libraries (${gb(ortLibsBytes * 1.3)} needed)`,
      };
    else
      ortLibs = {
        ...base,
        action: "install",
        reason: `NVIDIA driver ${stack.tier === "cuda13" ? "runs CUDA 13" : "runs CUDA 12.9"}; the ${ortLibsLabel} runtime libraries (${gb(ortLibsBytes)}) are installed with pinned hashes`,
      };
  }
  if (ortLibs.id && ortLibs.action === "skip")
    skipped.push({ id: ortLibs.id, reason: ortLibs.reason });
  const ortGpuBytes = bundleBytes(stack.tier === "cuda12" ? "ort-gpu-cu12" : "ort-gpu");

  // ONNX Runtime: setup installs the CPU wheel; a GPU variant is offered, never installed together with another.
  const libsOk = (step, actions) => actions.includes(step.action);
  const gpuOrt =
    card &&
    ortLibsId !== null &&
    libsOk(cudaLibs, ["present", "install", "defer"]) &&
    libsOk(ortLibs, ["present", "install", "defer"]);
  const directml = !gpuOrt && view.vulkan.length > 0;
  const variant = gpuOrt ? "gpu" : directml ? "directml" : "cpu";
  // The GPU build is the one to install now when the CUDA libraries are on this PC or planned in this same setup.
  const gpuNow =
    variant === "gpu" &&
    libsOk(cudaLibs, ["present", "install"]) &&
    libsOk(ortLibs, ["present", "install"]);
  const installNow = gpuNow ? "gpu" : "cpu";
  const ort = {
    variant,
    installNow,
    action: "install",
    bytes: installNow === "gpu" ? ortGpuBytes : ORT_BYTES[installNow],
    reason: gpuNow
      ? `the CUDA libraries ${cudaLibs.action === "present" ? "are on this PC" : "are installed in this setup"}, so the GPU (CUDA) build of ONNX Runtime (${mb(ortGpuBytes)}) is installed`
      : variant === "cpu"
        ? "no qualifying GPU: the CPU build of ONNX Runtime"
        : `the CPU build is installed first; the ${variant === "gpu" ? "GPU (CUDA)" : "DirectML"} build is offered (${mb(variant === "gpu" ? ortGpuBytes : ORT_BYTES[variant])}) and swapped in from the Install Manager with a hash check and a rollback`,
  };
  if (variant !== "cpu" && !gpuNow)
    offered.push({
      id: `onnxruntime-${variant}`,
      bytes: variant === "gpu" ? ortGpuBytes : ORT_BYTES[variant],
      reason: ort.reason,
    });
  if (net.online === false) ort.action = deps.installed?.onnxruntime === true ? "present" : "defer";
  else if (deps.installed?.onnxruntime === true) ort.action = "present";
  return {
    cudaLibs,
    ortLibs,
    gpuStack: { tier: stack.tier, bundles: [...stack.bundles] },
    ort,
    offered,
    skipped,
  };
}

/* ------------------------------------------------------------------- voice */

function voiceProbe(f, deps, packages) {
  if (isRecord(deps.voiceProbe)) return deps.voiceProbe;
  const view = gpuView(f);
  const card = view.nvidia;
  const cuda = isRecord(f.cuda) ? f.cuda : {};
  return {
    totalRamGb: positive(f.ramGb),
    freeRamGb: positive(f.ramFreeGb),
    cpuThreads: positive(f.cpu?.logicalCores) || positive(f.cpu?.physicalCores) || 4,
    platform: "win32",
    ...(text(f.cpuClass) ? { cpuClass: f.cpuClass } : {}),
    gpu: {
      name: card?.name || "",
      vramGb: card ? positive(card.vramGb) || 0 : 0,
      ...(card && positive(f.vramFreeGb) !== null && (!f.gpuName || f.gpuName === card.name)
        ? { vramFreeGb: positive(f.vramFreeGb) }
        : {}),
      source: "facts",
      // The CUDA libraries this same setup installs count as ready: the first setup on an NVIDIA PC picks the GPU ear.
      cudaRuntimeReady:
        deps.cudaRuntimeReady === true ||
        cuda.runtimeFilesFound === true ||
        f.cudaRuntimeFilesFound === true ||
        packages?.cudaLibs?.action === "install",
      cudaDriverReady: f.cudaReady === true && Boolean(card),
    },
  };
}

/**
 * The voice plan. `reserveBytes` is disk another part of this setup (the chat model, llama.cpp, the CUDA libraries)
 * already claims: the voice plan sees that much less free space, so its optional models yield (the essential ones
 * are never skipped for disk).
 */
function planVoice(f, deps, chat, packages, reserveBytes = 0) {
  if (!text(deps.root))
    return {
      planned: false,
      reason: "no FRIDAY folder was given, so the voice plan is not computed",
    };
  try {
    const voice = deps.voiceWeights || require("./voice-weights.cjs");
    // Only a model resident on the NVIDIA card (CUDA) takes video memory from the speech ear; the twin counts when it
    // sits on the same card.
    const llmGb =
      chat.device === "gpu" && chat.backend === "cuda" && chat.tag
        ? chat.needs.memoryGb + (chat.voice?.device === "gpu" ? chat.voice.needGb : 0)
        : 0;
    // A big optional speech download (the streaming ear) waits on a metered line, on battery or under heavy load.
    // Offline is not a reason here: the whole voice plan already waits for the network.
    const wait = networkOf(f).online === false ? "" : waitReason(f, BIG_DOWNLOAD_BYTES);
    const plan = voice.voiceInstallPlan(deps.root, voiceProbe(f, deps, packages), {
      exists: deps.exists || (() => false),
      ...(wait ? { waitReason: wait } : {}),
      ...(deps.statfs || reserveBytes > 0
        ? { statfs: reservedStatfs(deps.statfs, reserveBytes) }
        : {}),
      ...(llmGb > 0 ? { llmResidentVramGb: llmGb } : {}),
    });
    const b = plan.budget;
    // The streaming ear is one more row of the same plan when this PC carries it (voice-weights.cjs streamEarDecision),
    // then the optional language and sound models (`optionalItems`): setup fetches them as optional, so a failed fetch is
    // a notice and never a stop. Their bytes are reported apart (`optionalBytes`) and stay out of `downloadBytes`.
    const rows = [
      ...plan.items,
      ...(plan.streamEar ? [plan.streamEar] : []),
      ...(plan.optionalItems || []),
    ];
    return {
      planned: true,
      profile: b.profile,
      sttSize: b.sttSize,
      sttCompute: b.sttCompute,
      sttDevice: b.sttDevice,
      speechBudgetGb: b.speechBudgetGb,
      install: rows.filter((i) => i.state === "download").map((i) => i.id),
      onDisk: rows.filter((i) => i.state === "on-disk").map((i) => i.id),
      skipped: [
        ...rows.filter((i) => i.state === "skipped").map((i) => ({ id: i.id, reason: i.reason })),
        ...plan.blocked.map((r) => ({ id: r.id, reason: r.reason })),
      ],
      optional: [...plan.optional],
      downloadBytes: plan.downloadBytes + (plan.streamEarBytes || 0),
      optionalBytes: plan.optionalBytes || 0,
      notes: [...b.notes],
      lines: [...plan.lines],
    };
  } catch (error) {
    return {
      planned: false,
      reason: `the voice plan could not be computed: ${String(error?.message || error).slice(0, 160)}`,
    };
  }
}

/** A `statfs` that reports `reserveBytes` less free space than the disk has (never below zero). */
function reservedStatfs(statfs, reserveBytes) {
  const real = statfs || ((where) => require("node:fs").statfsSync(where));
  return (where) => {
    const stat = real(where);
    const size = Number(stat.bsize) || 1;
    return {
      ...stat,
      bavail: Math.max(0, Number(stat.bavail) - Math.ceil(Math.max(0, reserveBytes) / size)),
    };
  };
}

/* -------------------------------------------------------------------- plan */

function pcOf(f, view) {
  const card = view.nvidia || view.real[0] || null;
  const cuda = isRecord(f.cuda) ? f.cuda : {};
  const cpu = isRecord(f.cpu) ? f.cpu : {};
  const net = networkOf(f);
  const power = isRecord(f.power) ? f.power : {};
  const media = text(f.modelDrive?.media);
  return {
    ramGb: positive(f.ramGb),
    ramFreeGb: positive(f.ramFreeGb),
    diskFreeGb: positive(f.diskFreeGb),
    cpuClass: text(f.cpuClass),
    arch: archOf(f) || null,
    diskMedia: media === "ssd" || media === "hdd" || media === "scm" ? media : null,
    // Every real graphics part, for the fingerprint: vendor, label, memory and whether it shares system memory.
    gpus: view.real.map((g) => ({
      vendor: text(g.vendor),
      name: text(g.name),
      vramGb: positive(g.vramGb),
      unified: g.unifiedMemory === true,
    })),
    multiGpu: view.multiGpu,
    gpu: card
      ? {
          vendor: card.vendor || null,
          name: card.name || null,
          vramGb: positive(card.vramGb),
          vramFreeGb: positive(f.vramFreeGb),
          computeCap: num(card.computeCap),
          driver: card.driver || null,
        }
      : null,
    integratedOnly: view.integratedOnly,
    cudaDriver: f.cudaReady === true,
    cudaVersion: text(cuda.driverCuda),
    cudaLibs: cuda.runtimeFilesFound === true || f.cudaRuntimeFilesFound === true,
    vulkan: f.vulkan === true,
    avx2: cpu.avx2 === true,
    avx512: cpu.avx512 === true,
    online: net.online,
    metered: net.metered,
    onBattery: power.batteryPresent === true && power.onAc === false,
    health: isRecord(f.health) ? f.health.level || "ok" : "ok",
  };
}

/**
 * A stable hash of the hardware-bound facts of a plan (processor class and instruction sets, total RAM, graphics
 * cards by vendor, label and memory, architecture, drive type) so a changed PC is detectable. Free memory, free disk,
 * the line and the power state are not part of it: they change every minute on the same PC.
 */
function planFingerprint(plan) {
  const pc = isRecord(plan) && isRecord(plan.pc) ? plan.pc : {};
  const cards = (Array.isArray(pc.gpus) ? pc.gpus : [])
    .filter(isRecord)
    .map((g) =>
      [
        text(g.vendor) || "",
        text(g.name) || "",
        round1(positive(g.vramGb)) ?? 0,
        g.unified === true ? 1 : 0,
      ].join("|"),
    )
    .sort();
  const basis = {
    v: 1,
    cpuClass: text(pc.cpuClass),
    avx2: pc.avx2 === true,
    avx512: pc.avx512 === true,
    ramGb: round1(positive(pc.ramGb)),
    arch: text(pc.arch),
    disk: text(pc.diskMedia),
    gpus: cards,
  };
  return require("node:crypto")
    .createHash("sha256")
    .update(JSON.stringify(basis))
    .digest("hex")
    .slice(0, 32);
}

/**
 * The plan of this PC. `deps`: `installedModels` (Ollama tags or `{ name, size }`), `installed` (`{ llama, onnxruntime }`
 * booleans), `root` + `exists` + `statfs` (the voice plan), `voiceProbe`, `cudaRuntimeReady`, `tiers`, `llamaPin`,
 * `voiceWeights`. Never throws.
 */
function buildSetupPlan(facts, deps = {}) {
  const f = isRecord(facts) ? facts : {};
  const view = gpuView(f);
  const pc = pcOf(f, view);
  const skipped = [];

  // Disk is shared by this setup's downloads: llama.cpp, the CUDA libraries and the voice plan are planned first, then
  // the chat model takes what is left; on a tight disk the chat model comes before the optional speech models.
  const llama = planLlama(f, deps);
  const pass = (pk) => {
    const fixed =
      (llama.action === "install" ? llama.bytes : 0) +
      (pk.cudaLibs.action === "install" ? CUDA_LIBS_BYTES : 0) +
      (pk.ortLibs.action === "install" ? pk.ortLibs.bytes : 0) +
      (pk.ort.action === "install" ? pk.ort.bytes : 0);
    // The voice plan needs the chat memory first (a model resident on the card), so plan chat with a first disk reserve.
    const first = planChat(f, deps, { diskReserveGb: (fixed * 1.3) / GIB });
    let voicePlan = planVoice(f, deps, first, pk);
    const bytesOf = (v) => (v.planned ? v.downloadBytes : 0);
    let chatPlan = planChat(f, deps, { diskReserveGb: ((fixed + bytesOf(voicePlan)) * 1.3) / GIB });
    // When the voice plan took the room the first chat pick needed (no model, or a smaller one), plan the voice again
    // with that room held back: its optional models yield, then the chat again.
    const wanted = first.tag && first.needs ? first.needs.downloadGb : 0;
    const got = chatPlan.tag && chatPlan.needs ? chatPlan.needs.downloadGb : 0;
    if (voicePlan.planned && wanted > got) {
      const reserve = GIB * (num(loadTiers(deps)?.rules?.diskReserveGb) ?? 1);
      const squeezed = planVoice(f, deps, first, pk, (fixed + wanted * GIB) * 1.3 + reserve);
      if (squeezed.planned) {
        voicePlan = squeezed;
        chatPlan = planChat(f, deps, {
          diskReserveGb: ((fixed + bytesOf(voicePlan)) * 1.3) / GIB,
        });
      }
    }
    return { pk, voicePlan, chatPlan, first };
  };
  let run = pass(planPackages(f, deps));
  // Still no chat model although the first pick fitted: the optional GPU accelerators wait for the Install Manager too.
  if (run.chatPlan.tag === null && run.first.tag && run.pk.cudaLibs.action === "install") {
    const lean = pass(planPackages(f, deps, true));
    if (lean.chatPlan.tag !== null) run = lean;
  }
  const packages = run.pk;
  const voice = run.voicePlan;
  const chat = run.chatPlan;
  const voiceBytes = voice.planned ? voice.downloadBytes : 0;

  skipped.push(...llama.skipped.map((s) => ({ id: `llama.cpp:${s.backend}`, reason: s.reason })));
  skipped.push(...packages.skipped);
  if (chat.action === "none") skipped.push({ id: "chat-model", reason: chat.reason });
  if (voice.planned) skipped.push(...voice.skipped.map((s) => ({ id: s.id, reason: s.reason })));

  const offered = [...packages.offered];
  if (llama.offered)
    offered.push({ id: `llama.cpp-${llama.offered.backend}`, reason: llama.offered.reason });
  if (chat.action === "offer-upgrade")
    offered.push({
      id: chat.offer,
      bytes: Math.round(chat.needs.downloadGb * GIB),
      reason: chat.reason,
    });
  for (const alt of chat.alternatives || [])
    offered.push({
      id: alt.tag,
      bytes: Math.round(alt.downloadGb * GIB),
      reason: alt.note || "an alternative that fits this PC",
    });
  if (voice.planned)
    for (const id of voice.optional)
      offered.push({ id, reason: "optional speech model, on demand from the Models page" });

  const pull = chat.action === "pull" ? Math.round(chat.needs.downloadGb * GIB) : 0;
  // Offline, nothing can be fetched: every planned download waits.
  const offline = pc.online === false;
  const planned =
    (llama.action === "install" ? llama.bytes : 0) +
    (packages.cudaLibs.action === "install" ? CUDA_LIBS_BYTES : 0) +
    (packages.ortLibs.action === "install" ? packages.ortLibs.bytes : 0) +
    (packages.ort.action === "install" ? packages.ort.bytes : 0) +
    pull +
    voiceBytes;
  const downloadBytes = offline ? 0 : planned;
  const deferredBytes =
    (llama.action === "defer" ? llama.bytes : 0) +
    (packages.cudaLibs.action === "defer" ? CUDA_LIBS_BYTES : 0) +
    (packages.ortLibs.action === "defer" ? packages.ortLibs.bytes : 0) +
    (packages.ort.action === "defer" ? packages.ort.bytes : 0) +
    (chat.action === "defer" && chat.needs ? Math.round(chat.needs.downloadGb * GIB) : 0) +
    (offline ? voiceBytes : 0);

  const out = {
    schema: PLAN_SCHEMA,
    pc,
    llama,
    chat,
    packages: {
      cudaLibs: packages.cudaLibs,
      ortLibs: packages.ortLibs,
      gpuStack: packages.gpuStack,
      ort: packages.ort,
    },
    voice,
    offered,
    skipped,
    downloadBytes,
    deferredBytes,
    notes: [...(chat.notes || [])],
  };
  out.fingerprint = planFingerprint(out);
  return out;
}

/* --------------------------------------------------------------- reporting */

/** The lines setup prints in its "this PC" block. */
function describePlan(plan) {
  const p = isRecord(plan) ? plan : {};
  const pc = isRecord(p.pc) ? p.pc : {};
  const lines = [];
  const add = (line) => lines.push(`${INFO}${line}`);
  const known = (v, unit) => (v === null || v === undefined ? "unknown" : `${v} ${unit}`);

  add(
    `this PC: ${known(pc.ramGb, "GB")} RAM (${known(pc.ramFreeGb, "GB")} free), ${known(pc.diskFreeGb, "GB")} free on the model drive`,
  );
  if (pc.gpu) {
    add(
      `graphics: ${pc.gpu.name || "unnamed card"}, ${known(pc.gpu.vramGb, "GB")} video memory (${known(pc.gpu.vramFreeGb, "GB")} free)${pc.gpu.computeCap !== null ? `, compute ${pc.gpu.computeCap}` : ""}${pc.gpu.driver ? `, driver ${pc.gpu.driver}` : ""}`,
    );
  } else {
    add(
      pc.integratedOnly
        ? "graphics: integrated only (shared memory), counted as no GPU"
        : "graphics: no GPU found",
    );
  }
  add(
    `CUDA 12: driver ${pc.cudaDriver ? "yes" : "no"}, cuBLAS/cuDNN files ${pc.cudaLibs ? "found" : "not found"}; Vulkan ${pc.vulkan ? "yes" : "no"}; AVX2 ${pc.avx2 ? "yes" : "no"}${pc.avx512 ? ", AVX-512 yes" : ""}`,
  );
  add(
    `line: ${pc.online === false ? "offline" : pc.online === true ? "online" : "unknown"}${pc.metered ? ", metered" : ""}${pc.onBattery ? ", on battery" : ""}; health ${pc.health}`,
  );

  const l = p.llama;
  if (l)
    add(
      `llama.cpp: ${l.action} ${l.install?.backend || "cpu"} (${l.reason})${l.fallbacks ? `; fallbacks ${l.fallbacks.join(" > ")}` : ""}${l.deferReason ? `; waits: ${l.deferReason}` : ""}`,
    );
  const c = p.chat;
  if (c)
    add(
      c.tag
        ? `chat model: ${c.action} ${c.action === "keep" || c.action === "offer-upgrade" ? c.use : c.tag} - ${c.reason}`
        : `chat model: none - ${c.reason}`,
    );
  if (c?.tag && c.numCtx)
    add(
      `chat context: ${Math.round(c.numCtx / 1024)}k tokens${c.voice ? `; fast voice twin: ${c.voice.tag} (${c.voice.sizeGb} GB, on the ${c.voice.device === "gpu" ? "GPU" : "CPU"})` : ""}${c.estimated ? "; speed estimated" : ""}`,
    );
  if (c?.warn) add(`chat memory: ${c.warn}`);
  const pk = p.packages;
  if (pk) {
    add(`CUDA libraries: ${pk.cudaLibs.action} - ${pk.cudaLibs.reason}`);
    if (pk.ortLibs?.id) add(`${pk.ortLibs.id}: ${pk.ortLibs.action} - ${pk.ortLibs.reason}`);
    add(`ONNX Runtime: ${pk.ort.action} ${pk.ort.installNow} - ${pk.ort.reason}`);
  }
  const v = p.voice;
  if (v?.planned)
    add(
      `voice: profile ${v.profile}, ${v.sttSize} ${v.sttCompute} on the ${v.sttDevice === "cuda" ? "GPU" : "CPU"}, up to ${v.speechBudgetGb} GB of RAM; fetch ${v.install.length}, on disk ${v.onDisk.length}, skipped ${v.skipped.length}`,
    );
  else if (v) add(`voice: not planned - ${v.reason}`);
  for (const s of p.skipped || []) add(`skipped ${s.id}: ${s.reason}`);
  for (const o of p.offered || [])
    add(`offered, not installed: ${o.id}${o.bytes ? ` (${mb(o.bytes)})` : ""}`);
  if (v?.planned && v.optionalBytes)
    add(
      `optional voice models (setup goes on if one fails): ${mb(v.optionalBytes)}, not in the total below`,
    );
  add(
    `download now: ${gb(p.downloadBytes || 0)}${p.deferredBytes ? `; waiting for a better moment: ${gb(p.deferredBytes)}` : ""}`,
  );
  return lines;
}

/**
 * The single hardware-derived required set, for the Doctor: plain data, no functions, stable order. A row is
 * `required` when this PC needs it (planned install, already present or kept); skipped and offered rows are listed so
 * the Doctor never calls them missing.
 */
function toJSON(plan) {
  const p = isRecord(plan) ? plan : {};
  const required = [];
  const need = (id, kind, extra = {}) => required.push({ id, kind, ...extra });
  const wanted = (action) => ["install", "present", "keep", "pull", "defer"].includes(action);
  if (p.llama && wanted(p.llama.action))
    need("llama.cpp", "engine", {
      backend: p.llama.install?.backend,
      variant: p.llama.install?.variant,
      source: p.llama.install?.source,
      action: p.llama.action,
    });
  if (p.chat?.tag || p.chat?.use) {
    if (wanted(p.chat.action) || p.chat.action === "offer-upgrade")
      need(p.chat.use || p.chat.tag, "chat-model", { runner: "ollama", action: p.chat.action });
  }
  if (p.packages?.cudaLibs && wanted(p.packages.cudaLibs.action))
    need("cuda-libs", "runtime-pack", { action: p.packages.cudaLibs.action });
  if (p.packages?.ortLibs?.id && wanted(p.packages.ortLibs.action))
    need(p.packages.ortLibs.id, "runtime-pack", { action: p.packages.ortLibs.action });
  if (p.packages?.ort && wanted(p.packages.ort.action))
    need("onnxruntime", "runtime-pack", {
      variant: p.packages.ort.installNow,
      recommended: p.packages.ort.variant,
      action: p.packages.ort.action,
    });
  if (p.voice?.planned) {
    for (const id of p.voice.install) need(id, "voice-model", { action: "install" });
    for (const id of p.voice.onDisk) need(id, "voice-model", { action: "present" });
  }
  return JSON.parse(
    JSON.stringify({
      schema: PLAN_SCHEMA,
      fingerprint: p.fingerprint || null,
      voiceTwin: p.chat?.voice || null,
      numCtx: p.chat?.numCtx || null,
      required,
      skipped: p.skipped || [],
      offered: (p.offered || []).map((o) => o.id),
      downloadBytes: p.downloadBytes || 0,
      deferredBytes: p.deferredBytes || 0,
    }),
  );
}

module.exports = {
  PLAN_SCHEMA,
  CUDA_LIBS_BYTES,
  buildSetupPlan,
  chatModelFor,
  describePlan,
  toJSON,
  qualityOf,
  voiceModelTags,
  planFingerprint,
  ollamaSettingsFor,
  loadTiers,
  gpuView,
  waitReason,
  nameLlamaChain,
};
