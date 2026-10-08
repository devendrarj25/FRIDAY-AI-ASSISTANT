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

export function sttQualityLabel(engine: SttEngine): string {
  if (engine === "command") return "keyword fallback, not a full transcriber";
  if (engine === "whisper.cpp") return "pretrained base model, not a from-scratch model";
  if (engine === "cloud") return "cloud engine, off unless the owner turned it on";
  return "optional pretrained engine";
}
