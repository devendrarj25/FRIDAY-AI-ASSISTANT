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
 *              20 percent fit the usable memory (free video memory less 1 GB on a verified NVIDIA card, else free RAM less
 *              what Windows, Electron and speech keep), never a partial offload by default, and a model already installed
 *              is kept when it is at least as good (it is never deleted or re-pulled).
 *   packages   CUDA 12 libraries only with an NVIDIA GPU whose driver reports CUDA 12; the ONNX Runtime variant; heavy
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
const ORT_BYTES = Object.freeze({ cpu: 16698767, directml: 25111930, gpu: 157765830 });
/** What a GPU llama.cpp zip weighs, from the release pages (an estimate: the real size is read at install time). */
const LLAMA_GPU_APPROX_BYTES = Object.freeze({ cuda: 650 * MIB, vulkan: 60 * MIB });
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
  return { rows, real, nvidia, vulkan, integratedOnly: rows.length > 0 && real.length === 0 };
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

/** The memory plan of this PC for a chat model: a verified NVIDIA card (video memory) or the CPU (RAM). */
function memoryFor(f, cfg, view) {
  const rules = cfg.rules || {};
  const margin = num(rules.weightsMargin) ?? 1.2;
  const notes = [];
  const ramTotalKnown = positive(f.ramGb);
  const ramTotal = ramTotalKnown ?? 8;
  if (ramTotalKnown === null)
    notes.push("the memory of this PC is unknown, so it is treated as an 8 GB PC");
  const ramFree = positive(f.ramFreeGb);
  const t = Math.min(1, Math.max(0, (ramTotal - 8) / 8));
  const reserve =
    (num(rules.cpuReserveGb?.at8) ?? 4.5) * (1 - t) + (num(rules.cpuReserveGb?.at16) ?? 6) * t;
  const freeHeadroom = num(rules.cpuFreeHeadroomGb) ?? 1;
  const cpuUsable = Math.min(ramTotal - reserve, (ramFree ?? ramTotal) - freeHeadroom);

  // A verified NVIDIA card: CUDA 12 driver, the compute capability and the driver Ollama needs, memory measured.
  const card = view.nvidia;
  let gpu = null;
  let gpuWhy = "";
  if (!card)
    gpuWhy = view.integratedOnly
      ? "the only graphics part is integrated (shared memory)"
      : "no NVIDIA graphics card was found";
  else if (f.cudaReady !== true) gpuWhy = "the NVIDIA driver does not support CUDA 12";
  else if (!(positive(card.vramGb) > 0)) gpuWhy = "the card's video memory could not be measured";
  else if (
    num(card.computeCap) !== null &&
    card.computeCap < (num(rules.ollamaMinComputeCap) ?? 7.5)
  )
    gpuWhy = `compute capability ${card.computeCap} is below ${num(rules.ollamaMinComputeCap) ?? 7.5}`;
  else if (versionAtLeast(card.driver, rules.ollamaMinDriver ?? "551.61") === false)
    gpuWhy = `driver ${card.driver} is older than ${rules.ollamaMinDriver ?? "551.61"}, which Ollama needs`;
  else if (card.vramGb < (num(rules.gpuMinTotalGb) ?? 3.5))
    gpuWhy = `${card.vramGb} GB of video memory is too little for a chat model`;
  else {
    const total = card.vramGb;
    const sameCard = !f.gpuName || !card.name || f.gpuName === card.name;
    const free = sameCard ? positive(f.vramFreeGb) : null;
    gpu = {
      totalGb: total,
      freeGb: free,
      usableGb: round1(Math.min(total, free ?? total) - (num(rules.gpuHeadroomGb) ?? 1)),
    };
    if (free === null)
      notes.push("free video memory was not measured, so the card's full size is used");
  }
  return {
    margin,
    notes,
    ramTotal,
    cpu: { totalGb: ramTotal, freeGb: ramFree, usableGb: round1(cpuUsable) },
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
 * The chat model for this PC from the tier table: `{ tag, reason, alternatives, needs, ... }` (tag is null when no
 * tier fits). Pure. `options.tiers` overrides the table, `options.diskReserveGb` is disk other downloads of the same
 * setup already take (before the 1.3 factor).
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
    };
  const rules = cfg.rules || {};
  const view = gpuView(f);
  const mem = memoryFor(f, cfg, view);
  const diskFactor = num(rules.diskFactor) ?? 1.3;
  const diskFree = positive(f.diskFreeGb);
  const diskAvail =
    diskFree === null
      ? Infinity
      : diskFree - (num(rules.diskReserveGb) ?? 1) - Math.max(0, num(options.diskReserveGb) ?? 0);
  const fits = (tier, usable) =>
    tier.downloadGb * mem.margin <= usable + 1e-9 &&
    tier.downloadGb * diskFactor <= diskAvail + 1e-9;
  const byDevice = (device) =>
    cfg.tiers
      .filter((t) => t.device === device)
      .sort((a, b) => num(b.minTotalGb) - num(a.minTotalGb) || b.downloadGb - a.downloadGb);

  let chosen = null;
  let device = null;
  let gpuNote = "";
  if (mem.gpu) {
    chosen =
      byDevice("gpu").find((t) => mem.gpu.totalGb >= t.minTotalGb && fits(t, mem.gpu.usableGb)) ||
      null;
    device = chosen ? "gpu" : null;
    // A card too small to carry a worthwhile model lets the CPU run a small one (only tiers marked for that).
    const cpuTier =
      byDevice("cpu").find(
        (t) =>
          t.gpuPcCpuFallback === true && mem.ramTotal >= t.minTotalGb && fits(t, mem.cpu.usableGb),
      ) || null;
    if (cpuTier && (!chosen || chosen.downloadGb < cpuTier.downloadGb)) {
      gpuNote = `the card's usable video memory (${mem.gpu.usableGb} GB) is too small for a model worth running on it, so the CPU runs it`;
      chosen = cpuTier;
      device = "cpu";
    }
  } else {
    chosen =
      byDevice("cpu").find((t) => mem.ramTotal >= t.minTotalGb && fits(t, mem.cpu.usableGb)) ||
      null;
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
      memory: {
        mode: mem.gpu ? "gpu" : "cpu",
        usableGb: mem.gpu ? mem.gpu.usableGb : mem.cpu.usableGb,
      },
      notes: [...mem.notes, ...(mem.gpu ? [] : [`no GPU is used for chat: ${mem.gpuWhy}`])],
    };
  }

  const usable = device === "gpu" ? mem.gpu.usableGb : mem.cpu.usableGb;
  const need = round1(chosen.downloadGb * mem.margin);
  const spare = round1(usable - need);
  const judged = judgeAlternatives(chosen, mem, device, rules, diskAvail);
  const where =
    device === "gpu" ? `${memoryLine(usable, "video memory")}` : `${memoryLine(usable, "RAM")}`;
  return {
    tag: chosen.tag,
    tier: chosen.id,
    device,
    reason: `${chosen.label}: ${chosen.tag} (${chosen.downloadGb} GB download, about ${need} GB in memory) fits in ${where}${gpuNote ? `; ${gpuNote}` : ""}${device === "cpu" && mem.gpuWhy && !gpuNote ? `; the GPU is not used for chat: ${mem.gpuWhy}` : ""}`,
    ...judged,
    needs: {
      downloadGb: chosen.downloadGb,
      diskGb: round1(chosen.downloadGb * diskFactor),
      memoryGb: need,
      memoryKind: device === "gpu" ? "vram" : "ram",
      runner: "ollama",
    },
    contextK: chosen.contextK,
    capabilities: [...(chosen.capabilities || [])],
    licence: chosen.licence || null,
    memory: { mode: device, usableGb: usable, needGb: need, spareGb: spare },
    tight: spare < 1,
    unverified: chosen.unverified || "memory and speed are estimates",
    notes: [...mem.notes, ...(gpuNote ? [gpuNote] : [])],
  };
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

/** The llama.cpp step: the pinned CPU zip, or a GPU build with a digest verified at install time, with fallbacks. */
function planLlama(f, deps) {
  const llama = require("./llama-runtime.cjs");
  const view = gpuView(f);
  // Only real devices reach the chain: an integrated part is never a reason for a GPU build.
  const chainFacts = {
    ...f,
    gpus: view.real.filter((g) => view.vulkan.includes(g) || g.vendor === "nvidia"),
  };
  const { chain, skipped } = llama.backendChain(chainFacts);
  const pin = pinOf(deps);
  const pinned = pin?.assets?.[0] || null;
  const pinnedStep = {
    backend: "cpu",
    variant: "cpu",
    source: pinned ? "pinned" : "release-api",
    digest: pinned ? "pinned-sha256" : "release-api-sha256",
    ...(pinned
      ? { asset: pinned.name, tag: pin.tag, bytes: pinned.bytes, sha256: pinned.sha256 }
      : {}),
  };
  const first = chain[0];
  const cpuVariant = chain[chain.length - 1]?.variant || "cpu";
  const out = { chain: chain.map((s) => s.backend), cpuVariant, skipped: [...skipped] };
  const present = deps.installed?.llama === true;
  const net = networkOf(f);

  let step = pinnedStep;
  let why = pinned
    ? `the pinned CPU build ${pinned.name} (SHA-256 pinned)`
    : "the CPU build, digest read from the official release API";
  if (first && first.backend !== "cpu") {
    const approx = LLAMA_GPU_APPROX_BYTES[first.backend] || 0;
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
        source: "release-api",
        digest: "release-api-sha256",
        approxBytes: approx,
        verified:
          "the zip digest is read from the official release API at install time, SHA-256 verified, health-checked",
      };
      why = `${first.backend === "cuda" ? "the CUDA 12 build" : "the Vulkan build"}, digest read from the official release API at install time; a build that fails its check is removed and the next step down is tried`;
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

function planPackages(f, deps) {
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

  // ONNX Runtime: setup installs the CPU wheel; a GPU variant is offered, never installed together with another.
  const gpuOrt =
    card &&
    (cudaLibs.action === "present" || cudaLibs.action === "install" || cudaLibs.action === "defer");
  const directml = !gpuOrt && view.vulkan.length > 0;
  const variant = gpuOrt ? "gpu" : directml ? "directml" : "cpu";
  const ort = {
    variant,
    installNow: "cpu",
    action: "install",
    bytes: ORT_BYTES.cpu,
    reason:
      variant === "cpu"
        ? "no qualifying GPU: the CPU build of ONNX Runtime"
        : `the CPU build is installed first; the ${variant === "gpu" ? "GPU (CUDA)" : "DirectML"} build is offered (${mb(ORT_BYTES[variant])}) and swapped in from the Install Manager with a hash check and a rollback`,
  };
  if (variant !== "cpu")
    offered.push({ id: `onnxruntime-${variant}`, bytes: ORT_BYTES[variant], reason: ort.reason });
  if (net.online === false) ort.action = deps.installed?.onnxruntime === true ? "present" : "defer";
  else if (deps.installed?.onnxruntime === true) ort.action = "present";
  return { cudaLibs, ort, offered, skipped };
}

/* ------------------------------------------------------------------- voice */

function voiceProbe(f, deps) {
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
      cudaRuntimeReady:
        deps.cudaRuntimeReady === true ||
        cuda.runtimeFilesFound === true ||
        f.cudaRuntimeFilesFound === true,
      cudaDriverReady: f.cudaReady === true && Boolean(card),
    },
  };
}

function planVoice(f, deps, chat) {
  if (!text(deps.root))
    return {
      planned: false,
      reason: "no FRIDAY folder was given, so the voice plan is not computed",
    };
  try {
    const voice = deps.voiceWeights || require("./voice-weights.cjs");
    const llmGb = chat.device === "gpu" && chat.tag ? chat.needs.memoryGb : 0;
    const plan = voice.voiceInstallPlan(deps.root, voiceProbe(f, deps), {
      exists: deps.exists || (() => false),
      ...(deps.statfs ? { statfs: deps.statfs } : {}),
      ...(llmGb > 0 ? { llmResidentVramGb: llmGb } : {}),
    });
    const b = plan.budget;
    return {
      planned: true,
      profile: b.profile,
      sttSize: b.sttSize,
      sttCompute: b.sttCompute,
      sttDevice: b.sttDevice,
      speechBudgetGb: b.speechBudgetGb,
      install: plan.items.filter((i) => i.state === "download").map((i) => i.id),
      onDisk: plan.items.filter((i) => i.state === "on-disk").map((i) => i.id),
      skipped: [
        ...plan.items
          .filter((i) => i.state === "skipped")
          .map((i) => ({ id: i.id, reason: i.reason })),
        ...plan.blocked.map((r) => ({ id: r.id, reason: r.reason })),
      ],
      optional: [...plan.optional],
      downloadBytes: plan.downloadBytes,
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

/* -------------------------------------------------------------------- plan */

function pcOf(f, view) {
  const card = view.nvidia || view.real[0] || null;
  const cuda = isRecord(f.cuda) ? f.cuda : {};
  const cpu = isRecord(f.cpu) ? f.cpu : {};
  const net = networkOf(f);
  const power = isRecord(f.power) ? f.power : {};
  return {
    ramGb: positive(f.ramGb),
    ramFreeGb: positive(f.ramFreeGb),
    diskFreeGb: positive(f.diskFreeGb),
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
 * The plan of this PC. `deps`: `installedModels` (Ollama tags or `{ name, size }`), `installed` (`{ llama, onnxruntime }`
 * booleans), `root` + `exists` + `statfs` (the voice plan), `voiceProbe`, `cudaRuntimeReady`, `tiers`, `llamaPin`,
 * `voiceWeights`. Never throws.
 */
function buildSetupPlan(facts, deps = {}) {
  const f = isRecord(facts) ? facts : {};
  const view = gpuView(f);
  const pc = pcOf(f, view);
  const skipped = [];

  // Disk is shared by this setup's downloads: voice first, then llama.cpp, the CUDA libraries, then the chat model.
  const llama = planLlama(f, deps);
  const packages = planPackages(f, deps);
  // The voice plan needs the chat memory first (a model resident on the card), so plan chat with a first disk reserve.
  const fixedBytes =
    (llama.action === "install" ? llama.bytes : 0) +
    (packages.cudaLibs.action === "install" ? CUDA_LIBS_BYTES : 0) +
    (packages.ort.action === "install" ? ORT_BYTES.cpu : 0);
  const chatFirst = planChat(f, deps, { diskReserveGb: (fixedBytes * 1.3) / GIB });
  const voice = planVoice(f, deps, chatFirst);
  const voiceBytes = voice.planned ? voice.downloadBytes : 0;
  const chat = planChat(f, deps, { diskReserveGb: ((fixedBytes + voiceBytes) * 1.3) / GIB });

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
    (packages.ort.action === "install" ? ORT_BYTES.cpu : 0) +
    pull +
    voiceBytes;
  const downloadBytes = offline ? 0 : planned;
  const deferredBytes =
    (llama.action === "defer" ? llama.bytes : 0) +
    (packages.cudaLibs.action === "defer" ? CUDA_LIBS_BYTES : 0) +
    (packages.ort.action === "defer" ? ORT_BYTES.cpu : 0) +
    (chat.action === "defer" && chat.needs ? Math.round(chat.needs.downloadGb * GIB) : 0) +
    (offline ? voiceBytes : 0);

  return {
    schema: PLAN_SCHEMA,
    pc,
    llama,
    chat,
    packages: { cudaLibs: packages.cudaLibs, ort: packages.ort },
    voice,
    offered,
    skipped,
    downloadBytes,
    deferredBytes,
    notes: [...(chat.notes || [])],
  };
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
  const pk = p.packages;
  if (pk) {
    add(`CUDA libraries: ${pk.cudaLibs.action} - ${pk.cudaLibs.reason}`);
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
  ollamaSettingsFor,
  loadTiers,
  gpuView,
  waitReason,
};
