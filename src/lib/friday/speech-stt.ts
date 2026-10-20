export type SttEngine = "whisper.cpp" | "faster-whisper" | "moonshine" | "cloud" | "command";

export type SttChoice = {
  engine: SttEngine;
  quality:
    | "pretrained-base"
    | "pretrained-optional"
    | "english-stream"
    | "cloud-opt-in"
    | "fallback-keywords";
  localFilesOnly: true;
  downloads: false;
  argv: string[];
};

const memory = new Map<string, number>();

export function resetSttMemory(): void {
  memory.clear();
}

export function rememberBenchmark(engine: SttEngine, ms: number): void {
  const previous = memory.get(engine);
  memory.set(engine, previous === undefined ? ms : Math.min(previous, ms));
}

export function chooseStt(input: {
  whisperCpp: boolean;
  modelReady: boolean;
  fasterWhisper: boolean;
  moonshine: boolean;
  english: boolean;
  cloudAllowed: boolean;
  network: boolean;
  cli: string;
  model: string;
  wav: string;
}): SttChoice {
  const ranked = [...memory.entries()].sort((a, b) => a[1] - b[1]);
  const fastest = ranked[0]?.[0];
  const local = (engine: SttEngine, quality: SttChoice["quality"], argv: string[]): SttChoice => ({
    engine,
    quality,
    localFilesOnly: true,
    downloads: false,
    argv,
  });
  if (fastest === "whisper.cpp" && input.whisperCpp && input.modelReady) {
    return local("whisper.cpp", "pretrained-base", [
      input.cli,
      "-m",
      input.model,
      "-f",
      input.wav,
      "--no-prints",
    ]);
  }
  if (input.whisperCpp && input.modelReady) {
    return local("whisper.cpp", "pretrained-base", [
      input.cli,
      "-m",
      input.model,
      "-f",
      input.wav,
      "--no-prints",
    ]);
  }
  if (fastest === "faster-whisper" && input.fasterWhisper) {
    return local("faster-whisper", "pretrained-optional", []);
  }
  if (input.fasterWhisper) return local("faster-whisper", "pretrained-optional", []);
  if (input.moonshine && input.english) return local("moonshine", "english-stream", []);
  if (input.cloudAllowed && input.network) return local("cloud", "cloud-opt-in", []);
  return local("command", "fallback-keywords", []);
}

/** Hold the last word until a later partial repeats it. */
export function whisperMutePlan(muted: boolean): { stop: boolean } {
  return { stop: muted };
}

export function holdUnstable(partial: string, priorHeld = ""): { stable: string; held: string } {
  const words = partial.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { stable: "", held: "" };
  const held = words[words.length - 1] ?? "";
  if (priorHeld && held === priorHeld) return { stable: words.join(" "), held: "" };
  if (words.length === 1) return { stable: "", held };
  return { stable: words.slice(0, -1).join(" "), held };
}

export type LiveSttEngine = "faster-whisper" | "moonshine" | "windows-speech" | "none";

export type LiveSttStatus = "ready" | "downloading" | "blocked" | "missing";

/**
 * The live ladder. faster-whisper, then Moonshine when English weights are
 * already on disk, then Windows speech when that language pack is installed.
 * Privacy mode stays on this list. Nothing here is a cloud engine.
 */
export function planLiveStt(input: {
  whisperReady: boolean;
  weightsReady: boolean;
  downloading?: boolean;
  percent?: number;
  blocked?: boolean;
  blockReason?: string;
  size?: string;
  sizeReason?: string;
  english: boolean;
  moonshineReady: boolean;
  windowsSpeech: boolean;
  privacy?: boolean;
}): {
  engine: LiveSttEngine;
  status: LiveSttStatus;
  reason: string;
  local: true;
} {
  void input.privacy;
  if (input.whisperReady && input.weightsReady) {
    const size = input.size || "base";
    return {
      engine: "faster-whisper",
      status: "ready",
      reason: input.sizeReason || `faster-whisper ${size}`,
      local: true,
    };
  }
  if (input.downloading) {
    const pct = Number(input.percent);
    const mark = Number.isFinite(pct) && pct > 0 ? ` ${Math.round(pct)}%` : "";
    return {
      engine: "faster-whisper",
      status: "downloading",
      reason: `downloading${mark}`,
      local: true,
    };
  }
  const blocked = input.blocked
    ? {
        engine: "faster-whisper" as const,
        status: "blocked" as const,
        reason: input.blockReason || "blocked",
        local: true as const,
      }
    : null;
  if (input.english && input.moonshineReady) {
    return {
      engine: "moonshine",
      status: "ready",
      reason: "Moonshine English weights are on disk",
      local: true,
    };
  }
  if (input.windowsSpeech) {
    return {
      engine: "windows-speech",
      status: "ready",
      reason: "Windows speech language pack is installed",
      local: true,
    };
  }
  if (blocked) return blocked;
  return {
    engine: "none",
    status: "missing",
    reason: "Install a local speech model, or add a Windows speech language pack.",
    local: true,
  };
}

export type LiveSttFacts = {
  available?: boolean;
  ready?: boolean;
  engine?: string;
  reason?: string | null | undefined;
  dependency?: string;
  moonshineReady?: boolean;
  windowsSpeech?: boolean;
  downloading?: boolean;
};

/** The same ladder Auto mode uses, fed by a kernel status payload. */
export function liveSttFromStatus(
  state: LiveSttFacts,
  lang: string,
  privacy = false,
): ReturnType<typeof planLiveStt> {
  const reason = state.reason || "";
  return planLiveStt({
    whisperReady: state.engine === "faster-whisper" && Boolean(state.available),
    weightsReady: Boolean(state.ready),
    downloading: Boolean(state.downloading) || /download/i.test(reason),
    blocked: /blocked:|not allowlisted/i.test(reason),
    blockReason: reason,
    english: /^en/i.test(lang),
    moonshineReady: Boolean(state.moonshineReady),
    windowsSpeech: Boolean(state.windowsSpeech),
    privacy,
  });
}

let remembered: ReturnType<typeof planLiveStt> | null = null;

export function rememberLiveStt(plan: ReturnType<typeof planLiveStt> | null): void {
  remembered = plan;
}

export function rememberedLiveStt(): ReturnType<typeof planLiveStt> | null {
  return remembered;
}

export function sttLadderDoctor(plan: ReturnType<typeof planLiveStt>): {
  id: string;
  label: string;
  group: string;
  status: "Ready" | "Warning";
  detail: string;
  fixable: false;
} {
  return {
    id: "stt:ladder",
    label: "Speech engine",
    group: "Voice",
    status: plan.status === "ready" ? "Ready" : "Warning",
    detail: `${plan.engine}: ${plan.reason}`,
    fixable: false,
  };
}

export function sttQualityLabel(engine: SttEngine): string {
  if (engine === "command") return "keyword fallback, not a full transcriber";
  if (engine === "whisper.cpp") return "pretrained base model, not a from-scratch model";
  if (engine === "cloud") return "cloud engine, off unless the owner turned it on";
  return "optional pretrained engine";
}
