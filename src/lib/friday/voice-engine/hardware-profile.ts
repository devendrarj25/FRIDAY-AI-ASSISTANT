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
    model: "base" | "small" | "medium";
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

  const sttThreads = Math.min(4, Math.max(1, threads - 2));
  const llmOnGpu = gpuUsable && name !== "lite";
  const sttOnGpu = name === "quality" && vram >= 12;
  if (!gpuUsable) reasons.push("no usable GPU: everything runs on the CPU");
  else if (!sttOnGpu)
    reasons.push("the GPU is kept for the language model; speech recognition stays on the CPU");

  const stt: VoiceProfile["stt"] = {
    engine: "faster-whisper",
    model: name === "lite" ? "base" : name === "quality" && ram >= 16 ? "medium" : "small",
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
