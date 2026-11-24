/**
 * Engine fit: can THIS PC run or install one Install Manager row, and what is the honest answer when it cannot?
 *
 * `classify(row, facts)` is pure: it reads the measured facts (electron/hardware.cjs `hardwareFacts`) and the
 * row's requirements, and never probes, never throws and never branches on a graphics card's marketing name.
 *
 *   supported    every requirement that could be checked is met
 *   limited      it works with a caveat (tight memory, busy GPU, metered line, battery, or a fact not measured yet)
 *   unsupported  a MEASURED fact makes it impossible (no NVIDIA GPU for a CUDA row, a driver below the floor, less
 *                video memory than the minimum with no CPU path, a disk too full to hold it)
 *
 * An unknown requirement never blocks. An unknown fact never produces `unsupported`: it says so in a reason and
 * the state is `limited`. The requirement vocabulary is generic, so tools, runtime packs, models and voice models
 * all use it. The voice manifest (electron/voice-pins.cjs FACTS: minRamGb, recommendedRamGb, minVramGb, cpuOk,
 * gpuOk, diskBytes) is read as it is; a row may also carry a `requirements` object:
 *
 *   ramGb, ramRecommendedGb   system memory in GB
 *   vramGb                    video memory in GB (with `gpu`, the card must have it; without, it is the GPU path)
 *   diskBytes / diskGb        what the install writes (the model drive needs 1.3 times that, like the downloader)
 *   downloadBytes             what crosses the network (defaults to diskBytes)
 *   gpu                       "nvidia" (a CUDA card) | "any" (any GPU, DirectML) | null
 *   cudaMin                   lowest CUDA the NVIDIA driver must support, as "12" or "12.4"
 *   cudaLibs                  cuBLAS 12 and cuDNN 9 must be installed (their own rows install them)
 *   computeCapMin             lowest CUDA compute capability, e.g. 7.5
 *   vulkan, avx2              the CPU or GPU feature the build needs
 *   cpuOk, gpuOk              voice manifest: keeps up on a CPU / has a GPU path
 *   heavyGpu                  a long GPU load that a battery should not carry
 *   alternative               the row to use instead when this one does not fit
 *   fallbackPriority          voice manifest: primary, lightweight, accuracy, experimental
 *   recommended               false keeps an optional row from ever being highlighted
 */
"use strict";

const STATES = Object.freeze(["supported", "limited", "unsupported"]);

const GIB = 1024 ** 3;
/** The downloader refuses a file unless the drive has this many times its size free (model-download.cjs). */
const DISK_FACTOR = 1.3;
/** A download this big on a metered connection is flagged. */
const BIG_DOWNLOAD_BYTES = 500 * 1024 * 1024;

/** NVIDIA's Windows display driver floor per CUDA 12.x minor release (CUDA release notes, read 2026-11-23). */
const CUDA_DRIVER_MIN = Object.freeze({
  12.0: "527.41",
  12.4: "551.61",
  12.6: "560.76",
  12.8: "570.65",
  12.9: "576.57",
});

const num = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const positive = (value) => {
  const n = num(value);
  return n !== null && n > 0 ? n : null;
};
const round1 = (n) => (n === null ? null : Math.round(n * 10) / 10);
const isRecord = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** "12.4" -> 12.4, "12" -> 12, anything else -> null. */
function cudaNumber(text) {
  const m = /^(\d+)(?:\.(\d+))?/.exec(String(text ?? "").trim());
  if (!m) return null;
  return Number(`${m[1]}.${m[2] ?? "0"}`);
}

/** The driver version a CUDA level needs, as the table has it (rounded up to the next listed level). */
function driverMinFor(cudaMin) {
  const want = cudaNumber(cudaMin);
  if (want === null) return null;
  const levels = Object.keys(CUDA_DRIVER_MIN)
    .map(Number)
    .sort((a, b) => a - b);
  const level = levels.find((l) => l >= want) ?? levels[levels.length - 1];
  return CUDA_DRIVER_MIN[level] ?? null;
}

/** Version text "551.61" -> [551, 61] for comparison; null when it is not a version. */
function versionParts(text) {
  const m = /^(\d+)(?:\.(\d+))?/.exec(String(text ?? "").trim());
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : null;
}
const atLeast = (have, need) => have[0] > need[0] || (have[0] === need[0] && have[1] >= need[1]);

/** The row's requirements in one fixed shape, from `requirements`, `facts` or the row itself. */
function requirementsOf(row) {
  const r = isRecord(row) ? row : {};
  const own = isRecord(r.requirements) ? r.requirements : {};
  const facts = isRecord(r.facts) ? r.facts : {};
  const pick = (...keys) => {
    for (const source of [own, facts, r]) {
      for (const key of keys) {
        const v = positive(source[key]);
        if (v !== null) return v;
      }
    }
    return null;
  };
  const flag = (key) => {
    for (const source of [own, facts]) {
      if (typeof source[key] === "boolean") return source[key];
    }
    return null;
  };
  const text = (key) => {
    const v = own[key] ?? facts[key];
    return typeof v === "string" && v ? v : null;
  };
  const diskBytes =
    positive(own.diskBytes) ??
    positive(facts.diskBytes) ??
    positive(r.diskBytes) ??
    positive(r.needBytes) ??
    (positive(own.diskGb) ?? positive(facts.diskGb) ?? 0) * GIB;
  const downloadBytes = positive(own.downloadBytes) ?? positive(r.bytes) ?? diskBytes;
  return {
    ramGb: pick("ramGb", "minRamGb"),
    ramRecommendedGb: pick("ramRecommendedGb", "recommendedRamGb"),
    vramGb: pick("vramGb", "minVramGb"),
    diskBytes: diskBytes || null,
    downloadBytes: downloadBytes || null,
    gpu: text("gpu"),
    cudaMin: text("cudaMin"),
    cudaLibs: flag("cudaLibs") === true,
    computeCapMin: positive(own.computeCapMin ?? facts.computeCapMin),
    vulkan: flag("vulkan") === true,
    avx2: flag("avx2") === true,
    cpuOk: flag("cpuOk"),
    gpuOk: flag("gpuOk"),
    heavyGpu: flag("heavyGpu") === true,
    alternative: text("alternative") ?? (typeof r.alternative === "string" ? r.alternative : null),
    fallbackPriority: text("fallbackPriority"),
    recommendable: flag("recommended") !== false,
  };
}

/** The `needs` block of the verdict: what the row asks of the PC, in the units the UI shows. */
function needsOf(req) {
  return {
    ramGb: round1(req.ramGb),
    vramGb: round1(req.vramGb),
    diskGb: req.diskBytes ? round1((req.diskBytes * DISK_FACTOR) / GIB) : null,
    cuda: Boolean(req.cudaMin || req.cudaLibs || req.gpu === "nvidia"),
    driverMin: req.cudaMin ? driverMinFor(req.cudaMin) : null,
    vulkan: req.vulkan,
    avx2: req.avx2,
    network: Boolean(req.downloadBytes),
    downloadGb: req.downloadBytes ? round1(req.downloadBytes / GIB) : null,
  };
}

/** What the facts say about the GPUs, without guessing: `known` is false until some probe answered. */
function gpuView(f) {
  const list = (Array.isArray(f.gpus) ? f.gpus : []).filter(isRecord);
  const probed = Array.isArray(f.sources) ? f.sources.length > 0 : false;
  const known = list.length > 0 || probed;
  const nvidia = list.find((g) => g.vendor === "nvidia") || null;
  return { list, known, nvidia, any: list.length > 0 };
}

/**
 * Verdict for one row on one PC.
 *
 * @param row     a catalogue row: `{ id, requirements?, facts?, diskBytes?, installed? }`
 * @param facts   `hardwareFacts(...)`; null or partial is fine (everything unmeasured reads as unknown)
 * @param options `{ installed }` overrides `row.installed` (an installed row needs no disk or network)
 */
function classify(row, facts, options = {}) {
  const reasons = [];
  const add = (level, code, text) => reasons.push({ code, text, level });
  let req;
  try {
    req = requirementsOf(row);
  } catch {
    req = requirementsOf({});
  }
  const f = isRecord(facts) ? facts : {};
  const installed = options.installed ?? row?.installed === true;
  const needs = needsOf(req);
  try {
    check(req, f, installed, add);
  } catch {
    add(
      "limit",
      "facts-unreadable",
      "The measured facts could not be read, so the fit is unknown.",
    );
  }

  const blocks = reasons.filter((r) => r.level === "block");
  const limits = reasons.filter((r) => r.level === "limit");
  const state = blocks.length ? "unsupported" : limits.length ? "limited" : "supported";
  const out = {
    state,
    reasons: reasons.map(({ code, text, level }) => ({ code, text, level })),
    needs,
    recommended: false,
  };
  out.recommended = state === "supported" && isRecommended(req, f);
  if (state !== "supported" && req.alternative) out.alternative = req.alternative;
  return out;
}

function isRecommended(req, f) {
  if (!req.recommendable) return false;
  const ram = positive(f.ramGb);
  switch (req.fallbackPriority) {
    case "experimental":
      return false;
    case "lightweight":
      // The small model is the pick only where the bigger ones are tight.
      return ram !== null && ram < 6;
    case "accuracy": {
      const gpu = gpuView(f);
      const vram = positive(gpu.nvidia?.vramGb ?? f.vramGb);
      const roomy = req.ramRecommendedGb === null || (ram !== null && ram >= req.ramRecommendedGb);
      return roomy && (req.vramGb === null || (vram !== null && vram >= req.vramGb));
    }
    default:
      return true;
  }
}

function check(req, f, installed, add) {
  const gpu = gpuView(f);
  const os = isRecord(f.os) ? f.os : {};
  const cpu = isRecord(f.cpu) ? f.cpu : {};
  const cuda = isRecord(f.cuda) ? f.cuda : {};
  const net = isRecord(f.network) ? f.network : {};
  const power = isRecord(f.power) ? f.power : {};

  // 64-bit Windows: every engine here is x64.
  if (os.is64Bit === false) add("block", "os-32bit", "This engine needs 64-bit Windows.");

  // ---- memory
  const ram = positive(f.ramGb);
  if (req.ramGb !== null) {
    if (ram === null) add("limit", "ram-unknown", "System memory has not been measured yet.");
    else if (ram < req.ramGb)
      add("block", "ram-too-small", `Needs ${req.ramGb} GB of memory; this PC has ${ram} GB.`);
    else if (req.ramRecommendedGb !== null && ram < req.ramRecommendedGb)
      add(
        "limit",
        "ram-tight",
        `Runs, but ${req.ramRecommendedGb} GB of memory is better; this PC has ${ram} GB.`,
      );
    else {
      const free = positive(f.ramFreeGb);
      if (free !== null && free < req.ramGb)
        add(
          "limit",
          "ram-busy",
          `Only ${free} GB of memory is free right now; it needs ${req.ramGb} GB.`,
        );
    }
  }
  if (f.memory?.pressure === "critical" && req.ramGb !== null && !installed)
    add("limit", "ram-pressure", "Memory is almost full right now; free some before loading it.");

  // ---- GPU path
  const needsNvidia = req.gpu === "nvidia" || req.cudaMin !== null || req.cudaLibs;
  if (needsNvidia) {
    if (!gpu.known) add("limit", "gpu-unknown", "The graphics card has not been detected yet.");
    else if (!gpu.nvidia)
      add("block", "no-nvidia-gpu", "Needs an NVIDIA graphics card; none was found.");
    else nvidiaChecks(req, f, gpu, cuda, add);
  } else if (req.gpu === "any") {
    if (!gpu.known) add("limit", "gpu-unknown", "The graphics card has not been detected yet.");
    else if (!gpu.any)
      add("block", "no-gpu", "Needs a graphics card with DirectX 12; none was found.");
    else if (positive(os.build) !== null && positive(os.build) < 18362)
      add("block", "os-too-old", "DirectML needs Windows 10 version 1903 or newer.");
  } else if (req.vramGb !== null) {
    // An optional GPU path (voice models, GGUF files): the CPU runs it unless the row says it cannot.
    const vram = positive(gpu.nvidia?.vramGb ?? f.vramGb);
    const enough = vram !== null && vram >= req.vramGb;
    if (!enough && req.cpuOk === false) {
      if (!gpu.known) add("limit", "gpu-unknown", "The graphics card has not been detected yet.");
      else if (vram === null && gpu.any)
        add(
          "limit",
          "vram-unknown",
          `Needs ${req.vramGb} GB of video memory; this card's size is unknown.`,
        );
      else
        add(
          "block",
          "gpu-required",
          `Too heavy for a CPU; needs a graphics card with ${req.vramGb} GB of video memory.`,
        );
    }
  }

  // ---- CPU features and Vulkan
  if (req.avx2) {
    if (cpu.avx2 === false)
      add("block", "no-avx2", "This processor has no AVX2; use the plain CPU build.");
    else if (cpu.avx2 !== true)
      add("limit", "cpu-flags-unknown", "The processor's AVX2 support is unknown.");
  }
  if (req.vulkan) {
    if (f.vulkan === false) add("block", "no-vulkan", "No Vulkan driver was found on this PC.");
    else if (f.vulkan !== true)
      add("limit", "vulkan-unknown", "Vulkan support has not been measured yet.");
  }

  // ---- disk and network only matter before the install exists
  if (!installed) {
    const drive = isRecord(f.modelDrive) ? f.modelDrive : null;
    const free = num(drive?.freeGb) ?? num(f.diskFreeGb);
    if (req.diskBytes !== null) {
      const raw = req.diskBytes / GIB;
      if (free === null) add("limit", "disk-unknown", "Free disk space has not been measured yet.");
      else if (free < raw)
        add(
          "block",
          "disk-full",
          `Needs ${round1(raw)} GB of disk; ${round1(free)} GB is free on the model drive.`,
        );
      else if (free < raw * DISK_FACTOR)
        add(
          "limit",
          "disk-tight",
          `Fits, but the downloader wants ${round1(raw * DISK_FACTOR)} GB free; ${round1(free)} GB is.`,
        );
    }
    if (req.downloadBytes !== null) {
      if (net.online === false)
        add("limit", "offline", "This PC is offline; the download will wait.");
      else if (
        (net.metered === true || net.roaming === true) &&
        req.downloadBytes >= BIG_DOWNLOAD_BYTES
      )
        add(
          "limit",
          "metered-network",
          `A ${round1(req.downloadBytes / GIB)} GB download on a metered connection.`,
        );
    }
  }

  // ---- power
  if (req.heavyGpu) {
    if (power.onAc === false)
      add("limit", "on-battery", "On battery; a heavy GPU load will drain it.");
    else if (power.batterySaver === true)
      add("limit", "battery-saver", "Battery saver is on; a heavy GPU load will fight it.");
  }
}

function nvidiaChecks(req, f, gpu, cuda, add) {
  const card = gpu.nvidia;
  // driver
  if (req.cudaMin !== null) {
    const wantLevel = cudaNumber(req.cudaMin);
    const have = cudaNumber(cuda.driverCuda);
    const driver = versionParts(card.driver ?? f.driverVersion);
    const floor = versionParts(driverMinFor(req.cudaMin));
    if (have !== null && wantLevel !== null) {
      if (have < wantLevel)
        add(
          "block",
          "driver-too-old",
          `The NVIDIA driver supports CUDA ${have}; this needs CUDA ${req.cudaMin} (driver ${driverMinFor(req.cudaMin) ?? "newer"} or newer).`,
        );
    } else if (driver && floor) {
      if (!atLeast(driver, floor))
        add(
          "block",
          "driver-too-old",
          `NVIDIA driver ${card.driver ?? f.driverVersion} is older than ${driverMinFor(req.cudaMin)}, which CUDA ${req.cudaMin} needs.`,
        );
    } else add("limit", "driver-unknown", "The NVIDIA driver version could not be read.");
  }
  // compute capability, only when a probe supplied it (hardwareFacts carries it as gpus[].computeCap)
  if (req.computeCapMin !== null) {
    const cap = positive(card.computeCap ?? f.computeCap);
    if (cap !== null && cap < req.computeCapMin)
      add(
        "block",
        "compute-too-old",
        `This card is compute capability ${cap}; ${req.computeCapMin} or newer is needed.`,
      );
  }
  // video memory on the card itself
  if (req.vramGb !== null) {
    const total = positive(card.vramGb);
    const free = positive(f.gpuFreeGb ?? (f.gpuVendor === "nvidia" ? f.vramFreeGb : null));
    if (total === null)
      add("limit", "vram-unknown", "This card's video memory could not be measured.");
    else if (total < req.vramGb)
      add(
        "block",
        "vram-too-small",
        `Needs ${req.vramGb} GB of video memory; this card has ${total} GB.`,
      );
    else if (free !== null && free < req.vramGb)
      add(
        "limit",
        "vram-busy",
        `Only ${free} GB of video memory is free right now; it needs ${req.vramGb} GB.`,
      );
  }
  // the CUDA libraries themselves are installable, so a missing pair is a caveat that names its own fix
  if (req.cudaLibs) {
    if (cuda.runtimeFilesFound === true || (cuda.cublas12 === true && cuda.cudnn9 === true)) return;
    if (cuda.cublas12 === null && cuda.cudnn9 === null && cuda.runtimeFilesFound === null)
      add("limit", "cuda-libs-unknown", "cuBLAS 12 and cuDNN 9 have not been looked for yet.");
    else {
      const missing = [
        cuda.cublas12 === false ? "cuBLAS 12" : null,
        cuda.cudnn9 === false ? "cuDNN 9" : null,
      ]
        .filter(Boolean)
        .join(" and ");
      add(
        "limit",
        "cuda-libs-missing",
        `${missing || "cuBLAS 12 and cuDNN 9"} not installed; install the CUDA runtime libraries first.`,
      );
    }
  }
}

/** The catalogue split for the UI: row ids by state, in the order given. */
function splitByState(rows) {
  const out = { supported: [], limited: [], unsupported: [] };
  for (const row of Array.isArray(rows) ? rows : []) {
    const state = row?.fit?.state;
    if (STATES.includes(state)) out[state].push(row.id);
  }
  return out;
}

module.exports = {
  STATES,
  DISK_FACTOR,
  BIG_DOWNLOAD_BYTES,
  CUDA_DRIVER_MIN,
  classify,
  requirementsOf,
  needsOf,
  driverMinFor,
  splitByState,
};
