/**
 * FRIDAY · performance profile for the voice stack.
 *
 * Takes what the machine reports (nothing is assumed about a CPU or GPU model) and chooses Lite, Balanced or
 * Quality with the engines and sizes to use. Rules that hold for every profile:
 *   · one heavy local speech model at a time;
 *   · a GPU with less than 8 GB serves the language model OR speech recognition, never both;
 *   · with no usable GPU every essential voice feature runs on the CPU;
 *   · a model that is not on disk is listed as a download that needs the owner's yes; nothing is fetched here.
 */

import { STT_SIZE_MODEL, packMembers, voiceModelFacts, voicePackById } from "../model-catalog";

export type HardwareFacts = {
  cpuModel?: string;
  cpuThreads: number;
  ramTotalGb: number;
  ramAvailableGb: number;
  gpuName?: string;
  vramGb?: number;
  cuda?: boolean;
  diskFreeGb?: number;
};

export type ProfileName = "lite" | "balanced" | "quality";

export type VoiceProfile = {
  name: ProfileName;
  stt: {
    engine: "faster-whisper";
    model: "base" | "small" | "medium" | "large-v3-turbo";
    device: "cpu" | "cuda";
    computeType: "int8" | "float16";
    threads: number;
    beam: number;
  };
  llm: { model: string; device: "cpu" | "gpu"; context: number };
  tts: { engine: "supertonic"; device: "cpu" };
  vad: { engine: "silero-onnx"; device: "cpu" };
  maxBackgroundWorkers: number;
  reasons: string[];
  /** Models this profile would use that may not be on disk; each needs the owner's approval to download. */
  downloadsNeedApproval: boolean;
};

export type ModelOnDisk = { stt?: string[]; llm?: string[] };

export function selectProfile(facts: HardwareFacts, requested?: ProfileName): VoiceProfile {
  const reasons: string[] = [];
  const threads = Math.max(1, Math.floor(facts.cpuThreads || 1));
  const ram = Math.max(0, facts.ramAvailableGb);
  const vram = facts.cuda && facts.vramGb ? facts.vramGb : 0;
  const gpuUsable = vram >= 3;

  let name: ProfileName = "balanced";
  if (ram < 6 || threads < 4 || facts.ramTotalGb < 8) {
    name = "lite";
    reasons.push("low memory or few CPU threads");
  } else if (vram >= 8 && ram >= 12 && threads >= 8) {
    name = "quality";
    reasons.push("8 GB or more of video memory with enough RAM");
  } else reasons.push("a mid-range machine");
  if (requested) {
    // The owner may ask for a lighter profile any time; a heavier one only when the machine can carry it.
    const rank: Record<ProfileName, number> = { lite: 0, balanced: 1, quality: 2 };
    if (rank[requested] <= rank[name]) {
      name = requested;
      reasons.push(`the owner chose ${requested}`);
    } else reasons.push(`${requested} was asked for but this machine fits ${name}`);
  }

  // The same rule as the CPU speech engine (`cpu_threads` in kernel/stt.py): about half the logical processors,
  // 4 to 8, and never more than the PC has.
  const sttThreads = Math.min(threads, Math.max(4, Math.min(8, Math.floor(threads / 2))));
  const llmOnGpu = gpuUsable && name !== "lite";
  const sttOnGpu = name === "quality" && vram >= 12;
  if (!gpuUsable) reasons.push("no usable GPU: everything runs on the CPU");
  else if (!sttOnGpu)
    reasons.push("the GPU is kept for the language model; speech recognition stays on the CPU");

  const stt: VoiceProfile["stt"] = {
    engine: "faster-whisper",
    // The big turbo size only where the video memory carries it; a quality PC without that keeps medium.
    model:
      name === "lite"
        ? "base"
        : name === "quality" && ram >= 16
          ? vram >= 8
            ? "large-v3-turbo"
            : "medium"
          : "small",
    device: sttOnGpu ? "cuda" : "cpu",
    computeType: sttOnGpu ? "float16" : "int8",
    threads: sttThreads,
    beam: name === "quality" ? 2 : 1,
  };
  const llm: VoiceProfile["llm"] = {
    model: name === "lite" ? "qwen3:1.7b" : vram >= 6 || ram >= 14 ? "qwen3:4b" : "qwen3:1.7b",
    device: llmOnGpu ? "gpu" : "cpu",
    context: name === "lite" ? 2048 : 4096,
  };
  return {
    name,
    stt,
    llm,
    tts: { engine: "supertonic", device: "cpu" },
    vad: { engine: "silero-onnx", device: "cpu" },
    maxBackgroundWorkers: 1,
    reasons,
    downloadsNeedApproval: true,
  };
}

/** Models the profile wants that are not on disk. Nothing is downloaded; the list goes to the owner. */
export function missingModels(profile: VoiceProfile, onDisk: ModelOnDisk): string[] {
  const out: string[] = [];
  if (!(onDisk.stt ?? []).includes(profile.stt.model))
    out.push(`faster-whisper ${profile.stt.model}`);
  if (!(onDisk.llm ?? []).includes(profile.llm.model)) out.push(`ollama ${profile.llm.model}`);
  return out;
}

export type ModelNeeds = { name: string; ramGb: number; vramGb?: number; diskGb: number };

export type ModelFit = { ok: boolean; level: "fits" | "tight" | "too-big"; reasons: string[] };

/**
 * Whether a model fits this machine, with the reason. RAM and video memory are compared with what is free now,
 * keeping a margin for the system and for the other voice parts. "tight" runs but will be slow or may swap.
 */
export function checkModelFits(
  model: ModelNeeds,
  facts: HardwareFacts,
  target: "cpu" | "gpu" = "cpu",
): ModelFit {
  const reasons: string[] = [];
  const marginGb = 2;
  const rank: Record<ModelFit["level"], number> = { fits: 0, tight: 1, "too-big": 2 };
  const found: ModelFit["level"][] = [];
  const raise = (to: ModelFit["level"]) => void found.push(to);
  if (facts.diskFreeGb !== undefined && facts.diskFreeGb < model.diskGb * 1.2) {
    reasons.push(`needs about ${model.diskGb} GB of disk, ${facts.diskFreeGb} GB free`);
    raise("too-big");
  }
  if (model.ramGb + marginGb > facts.ramAvailableGb) {
    reasons.push(`needs about ${model.ramGb} GB of RAM, ${facts.ramAvailableGb} GB free`);
    raise(model.ramGb > facts.ramAvailableGb ? "too-big" : "tight");
  }
  if (target === "gpu") {
    const vram = facts.cuda && facts.vramGb ? facts.vramGb : 0;
    if (!vram) {
      reasons.push("no usable GPU; it would run on the CPU");
      raise("tight");
    } else if ((model.vramGb ?? model.ramGb) > vram) {
      reasons.push(
        `needs about ${model.vramGb ?? model.ramGb} GB of video memory, ${vram} GB present`,
      );
      raise("too-big");
    } else if ((model.vramGb ?? model.ramGb) + 0.5 > vram) {
      reasons.push("almost fills the video memory");
      raise("tight");
    }
  }
  const level = found.reduce<ModelFit["level"]>(
    (worst, next) => (rank[next] > rank[worst] ? next : worst),
    "fits",
  );
  return { ok: level !== "too-big", level, reasons };
}

/* ------------------------------------------------------------------ the 16 GB voice budget
 * The owner's memory policy: Windows, Electron and FRIDAY keep about 4 to 6 GB, active speech uses 2 to 4 GB and 1 to
 * 2 GB stay free (the low end applies to an 8 GB PC, the high end from 16 GB). Speech never gets more than 4 GB, only one
 * recogniser and one voice are resident, and a GPU counts only after the kernel's runtime check (kernel/stt.py
 * `cuda_runtime_ready`) has passed. This is the same table as `budgetFor` in electron/voice-weights.cjs, which setup and
 * Doctor call; core/__tests__/voice-hardware-budget.test.ts keeps the two equal.
 */

export type BudgetGpu = { name?: string; vramGb?: number; cudaRuntimeReady?: boolean };

export type VoiceBudget = {
  profile: ProfileName;
  sttSize: string;
  sttDevice: "cpu" | "cuda";
  sttCompute: "int8" | "float16";
  ttsEngine: "supertonic";
  packs: {
    id: string;
    install: string[];
    optional: string[];
    skipped: { id: string; reason: string }[];
  }[];
  /** Catalog ids a fresh setup fetches, in install order. */
  install: string[];
  /** Speech sizes this machine may load on its own, smallest first. */
  allowedSizes: string[];
  maxResidentModels: 2;
  idleUnloadMs: number;
  threads: number;
  speechBudgetGb: number;
  notes: string[];
};

const SPEECH_CAP_GB = 4;
const IDLE_UNLOAD_MS: Record<ProfileName, number> = {
  lite: 180_000,
  balanced: 600_000,
  quality: 900_000,
};
const LANGUAGE_PACKS = ["voice-pack-english", "voice-pack-hindi", "voice-pack-hinglish"];
const LADDER = ["tiny", "base", "small", "medium", "large-v3-turbo"];
const round1 = (value: number) => Math.round(value * 10) / 10;
const minRam = (id: string) => voiceModelFacts[id]?.minRamGb ?? 0;

/** Resident memory a speech size needs with the voice and the two helpers loaded beside it. */
function residentNeedGb(size: string): number {
  return round1(
    minRam(STT_SIZE_MODEL[size] ?? "") +
      minRam("supertonic-3") +
      minRam("silero-vad") +
      minRam("smart-turn"),
  );
}

export function budgetFor(
  totalRamGb: number,
  freeRamGb: number,
  vramGb: number,
  gpuInfo: BudgetGpu = {},
  options: { cpuThreads?: number } = {},
): VoiceBudget {
  const notes: string[] = [];
  let total = Number(totalRamGb);
  if (!(total > 0)) {
    total = 8;
    notes.push("the memory of this PC is unknown, so it is treated as an 8 GB PC");
  }
  const freeKnown = Number.isFinite(Number(freeRamGb)) && Number(freeRamGb) > 0;
  const free = freeKnown ? Math.min(Number(freeRamGb), total) : Infinity;
  if (!freeKnown) notes.push("free memory is unknown; only the total is used");
  const cpuThreads = Math.max(1, Math.floor(Number(options.cpuThreads) || 4));
  const t = Math.min(1, Math.max(0, (total - 8) / 8));
  const baselineGb = 4 + 2 * t;
  const headroomGb = 1 + t;
  const byTotal = Math.max(0, total - baselineGb - headroomGb);
  const byFree = free === Infinity ? Infinity : Math.max(0, free - headroomGb);
  const speechBudgetGb = round1(Math.min(SPEECH_CAP_GB, byTotal, byFree));
  notes.push(
    `memory policy: about ${round1(baselineGb)} GB for Windows, Electron and FRIDAY, up to ${SPEECH_CAP_GB} GB for speech (${speechBudgetGb} GB here), ${round1(headroomGb)} GB kept free`,
  );

  const vram =
    Number(vramGb) > 0 ? Number(vramGb) : Number(gpuInfo.vramGb) > 0 ? Number(gpuInfo.vramGb) : 0;
  const verified = gpuInfo.cudaRuntimeReady === true;
  let device: "cpu" | "cuda" = "cpu";
  let size: string;
  if (verified && vram >= 4 && total >= 16 && byFree >= 4) {
    device = "cuda";
    size = vram >= 8 ? "large-v3-turbo" : "medium";
  } else {
    if (speechBudgetGb >= residentNeedGb("small")) size = "small";
    else if (total >= 4 && !(freeKnown && byFree < 0.9)) size = "base";
    else size = "tiny";
    if (verified && vram >= 3) device = "cuda";
  }
  if (!verified && (vram > 0 || gpuInfo.name)) {
    notes.push(
      `${gpuInfo.name || "a GPU"} was found but the CUDA 12 libraries (cuBLAS 12, cuDNN 9) are not verified, so speech stays on the CPU in int8; FRIDAY never downloads CUDA libraries from third parties`,
    );
  } else if (device === "cuda") {
    notes.push(
      `GPU speech: the CUDA 12 libraries are verified and ${vram} GB of video memory is present`,
    );
  } else if (verified) {
    notes.push(
      `the GPU has ${vram} GB of video memory, too little for speech, so it stays on the CPU`,
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

  const allowedSizes = LADDER.slice(0, LADDER.indexOf(size) + 1);
  const profile: ProfileName =
    device === "cuda" && size !== "small" ? "quality" : size === "small" ? "balanced" : "lite";
  const ear = STT_SIZE_MODEL[size] ?? "faster-whisper-small";
  const wanted = [
    "silero-vad",
    "smart-turn",
    ear,
    "supertonic-3",
    "hindi-ear",
    ...(size !== "tiny" && profile !== "lite" ? ["hindi-punct"] : []),
  ];
  const install = wanted.filter((id, at) => wanted.indexOf(id) === at);
  const packs = LANGUAGE_PACKS.flatMap((id) => {
    const pack = voicePackById.get(id);
    if (!pack) return [];
    const members = packMembers(pack, { sttSize: size }).map((member) => member.id);
    return [
      {
        id,
        install: members.filter((member) => install.includes(member)),
        optional: members.filter((member) => !install.includes(member)),
        skipped: [],
      },
    ];
  });
  return {
    profile,
    sttSize: size,
    sttDevice: device,
    sttCompute: device === "cuda" ? "float16" : "int8",
    ttsEngine: "supertonic",
    packs,
    install,
    allowedSizes,
    maxResidentModels: 2,
    idleUnloadMs: IDLE_UNLOAD_MS[profile],
    threads: Math.min(cpuThreads, Math.max(4, Math.min(8, Math.floor(cpuThreads / 2)))),
    speechBudgetGb,
    notes,
  };
}
