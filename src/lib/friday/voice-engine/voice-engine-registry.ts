/**
 * FRIDAY · the voice engine registry: ONE table of every speech engine FRIDAY uses or may use.
 *
 * Roles: speech to text, text to speech, voice activity, turn end, wake word, speaker, language ID, denoise and Hindi
 * punctuation. Each row carries what the Capability Registry asks of a voice engine (docs/FRIDAY_MASTER_ROADMAP.md 3.3):
 * Hindi named yes or no, the licence of the code and of the weights apart, the runtime and whether it is torch-free,
 * the files with their sizes, memory, CPU or GPU, streaming, a latency class, the status and the owner-decision flags.
 * The rows are data (`voice-engine-table.ts`); this file holds the types and the rules that read them.
 *
 * Honesty rules, each pinned by a test:
 *  - a pinned engine's memory, disk and CPU or GPU numbers are the model catalogue's `voiceModelFacts`, which a test
 *    keeps equal to `FACTS` in electron/voice-pins.cjs; the table repeats none of them;
 *  - an engine is `usable` only with a live wrapper (a file of this repository that runs it) AND a self-test, and
 *    never while its status is `candidate-runtime-missing`; a candidate is listed so the Models page and the Install
 *    Manager can say "not installable yet" and why, never offered as a working choice;
 *  - the fallback chain per role and language is explicit data, then trimmed by detected facts (`budgetFor`, the same
 *    `checkModelFits`), never by a GPU name; it names every engine it left out and why, and changes no audible default.
 * Pure: no file, network, clock or model.
 */
import { voiceModelFacts } from "../model-catalog";
import { budgetFor, checkModelFits, type BudgetGpu, type HardwareFacts } from "./hardware-profile";
import { VOICE_ENGINE_TABLE, VOICE_CHAINS } from "./voice-engine-table";

export type VoiceRole =
  "stt" | "tts" | "vad" | "turn" | "wake" | "speaker" | "langid" | "denoise" | "punct";
export type VoiceLang = "hi" | "en" | "hinglish";
export const VOICE_LANGS: readonly VoiceLang[] = ["hi", "en", "hinglish"];
/** `unverified`: nobody measured it for FRIDAY; the engine stays eligible only where it was eligible before. */
export type LangSupport = "yes" | "no" | "unverified";
export type EngineRuntime =
  "onnxruntime" | "ctranslate2" | "gguf" | "python-package" | "system" | "cloud" | "rules";
export type LatencyClass = "streaming" | "fast" | "batch" | "heavy" | "cloud" | "instant";
/**
 * `installed-by-default`: part of what a fresh setup fetches or what the app ships, and it has a wrapper and a self-test.
 * `optional-pinned`: pinned by revision and SHA-256, installable from the Install Manager; whether it is used is `usable`.
 * `candidate-runtime-missing`: not installable, because no pin or no wrapper exists; the row says what is missing.
 */
export type EngineStatus = "installed-by-default" | "optional-pinned" | "candidate-runtime-missing";
/** What the owner must decide before the engine may be installed or become a default. */
export type OwnerFlag =
  | "openrail-m"
  | "cc-by-credit"
  | "cc-by-nc"
  | "gated"
  | "gpl-separate-process"
  | "community-conversion";

export type EngineFile = { name: string; bytes: number; sha256: string | null };
export type EngineFacts = {
  minRamGb: number;
  recommendedRamGb: number;
  minVramGb: number;
  diskBytes: number;
  cpuOk: boolean;
  gpuOk: boolean;
  /** `measured`: peak memory read on a run; `estimated`: taken from the file sizes or a model of the same kind. */
  basis: "measured" | "estimated";
};

export type VoiceEngine = {
  id: string;
  label: string;
  role: VoiceRole;
  /** The id the TTS ladder uses for this engine when it differs from `id`. */
  ladderId?: string;
  /** Upstream Hugging Face repository, or null. */
  repo: string | null;
  /** The key of this engine's pin in electron/voice-pins.cjs `PINS`, or null when it is not pinned. */
  pinRepo: string | null;
  languages: Record<VoiceLang, LangSupport>;
  codeLicence: string;
  weightLicence: string;
  runtime: EngineRuntime;
  /** No torch, vLLM, vosk, piper-tts, kokoro-onnx, sherpa-onnx or silero-vad pip in the path. */
  torchFree: boolean;
  /** Exact files of a candidate that is not pinned; null for a pinned engine (the pin lists them) or a built-in. */
  files: EngineFile[] | null;
  /** Numbers of an engine that is not pinned; a pinned engine reads `voiceModelFacts`. */
  facts: EngineFacts | null;
  streaming: boolean;
  latency: LatencyClass;
  status: EngineStatus;
  flags: OwnerFlag[];
  /** The repository file that runs this engine in the live path, or null when none does yet. */
  wrapper: string | null;
  /** A self-test exists (Doctor row) that opens the engine, not only hashes its files. */
  selfTest: boolean;
  /** For a candidate: what is missing, in one sentence. */
  blockedBy: string;
  /** The publisher's own numbers (not measured by FRIDAY), each with its dataset. */
  publishedWer?: { dataset: string; wer: number }[];
  /** The speech size this row stands for, for the Whisper ladder (tiny = 0). */
  sizeRank?: number;
  evidence: string[];
};

export const VOICE_ENGINES: readonly VoiceEngine[] = VOICE_ENGINE_TABLE;
export const voiceEngineById: ReadonlyMap<string, VoiceEngine> = new Map(
  VOICE_ENGINES.map((engine) => [engine.id, engine] as const),
);

/** The memory, disk and CPU or GPU numbers of one engine: the catalogue's facts when pinned, else the row's own. */
export function engineFacts(engine: VoiceEngine): EngineFacts | null {
  if (engine.pinRepo) {
    const pinned = voiceModelFacts[engine.id];
    if (!pinned) return null;
    return {
      minRamGb: pinned.minRamGb,
      recommendedRamGb: pinned.recommendedRamGb,
      minVramGb: pinned.minVramGb,
      diskBytes: pinned.diskBytes,
      cpuOk: pinned.cpuOk,
      gpuOk: pinned.gpuOk,
      basis: pinned.basis,
    };
  }
  return engine.facts;
}

/** Why an engine may not be used now, or "" when it may. The one definition of "usable". */
export function unusableReason(engine: VoiceEngine): string {
  if (engine.status === "candidate-runtime-missing") {
    return engine.blockedBy || "its runtime is not built in FRIDAY";
  }
  if (!engine.wrapper) return engine.blockedBy || "no live wrapper runs it yet";
  if (!engine.selfTest) return "it has no self-test yet";
  return "";
}
export const isUsable = (engine: VoiceEngine): boolean => unusableReason(engine) === "";

/** Only these may be named "installed by default": a wrapper and a self-test are part of the promise. */
export const defaultEngines = (): VoiceEngine[] =>
  VOICE_ENGINES.filter((engine) => engine.status === "installed-by-default");

export type ChainEntry = {
  id: string;
  label: string;
  /** The Hindi, English or Hinglish verdict for this engine: "unverified" is shown, not hidden. */
  languageSupport: LangSupport;
  fit: "fits" | "tight" | "not-checked";
};
export type ChainResult = {
  role: VoiceRole;
  lang: VoiceLang;
  /** Engines that may speak or listen, best first. The first is what a fresh PC with these facts would try first. */
  order: ChainEntry[];
  /** Everything left out, each with one honest reason. */
  blocked: { id: string; why: string }[];
};

export type ChainFacts = {
  hardware: HardwareFacts;
  /** The kernel's verdict that CUDA 12 libraries are there; without it no GPU speech size is allowed. */
  cudaRuntimeReady?: boolean;
  /** Catalog ids on disk. When given, an engine that is not installed is `blocked` ("not installed") unless it ships built in. */
  installed?: ReadonlySet<string>;
};

const BUILT_IN: ReadonlySet<EngineRuntime> = new Set<EngineRuntime>(["system", "rules", "cloud"]);

/** Whisper sizes this PC may load on its own, from `budgetFor` (the same table setup uses). */
export function allowedSpeechSizes(facts: ChainFacts): string[] {
  const hw = facts.hardware;
  const gpu: BudgetGpu = {
    ...(hw.gpuName ? { name: hw.gpuName } : {}),
    ...(hw.vramGb ? { vramGb: hw.vramGb } : {}),
    ...(facts.cudaRuntimeReady === true ? { cudaRuntimeReady: true } : {}),
  };
  return budgetFor(hw.ramTotalGb, hw.ramAvailableGb, hw.vramGb ?? 0, gpu, {
    cpuThreads: hw.cpuThreads,
  }).allowedSizes;
}

const SIZE_NAMES = ["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo"] as const;

/**
 * The fallback chain for one role and language on this PC. The order is the table's (`VOICE_CHAINS`); then each
 * engine is kept only when it is usable, speaks the language, is installed (when the caller knows), and fits: a
 * speech size must be one `budgetFor` allows, and any other engine must pass `checkModelFits`. No GPU name is read.
 */
export function chainFor(role: VoiceRole, lang: VoiceLang, facts: ChainFacts): ChainResult {
  const ids = VOICE_CHAINS[role]?.[lang] ?? [];
  const allowed = new Set(allowedSpeechSizes(facts));
  const order: ChainEntry[] = [];
  const blocked: { id: string; why: string }[] = [];
  for (const id of ids) {
    const engine = voiceEngineById.get(id);
    if (!engine) {
      blocked.push({ id, why: "not in the registry" });
      continue;
    }
    const why = refusal(engine);
    if (why.reason) blocked.push({ id, why: why.reason });
    else
      order.push({
        id,
        label: engine.label,
        languageSupport: engine.languages[lang],
        fit: why.fit,
      });
  }
  return { role, lang, order, blocked };

  function refusal(engine: VoiceEngine): { reason: string; fit: ChainEntry["fit"] } {
    const bad = unusableReason(engine);
    if (bad) return { reason: bad, fit: "not-checked" };
    if (engine.languages[lang] === "no") {
      return { reason: `it does not speak ${lang === "hi" ? "Hindi" : lang}`, fit: "not-checked" };
    }
    if (facts.installed && !BUILT_IN.has(engine.runtime) && !facts.installed.has(engine.id)) {
      return { reason: "not installed", fit: "not-checked" };
    }
    if (engine.sizeRank !== undefined) {
      const size = SIZE_NAMES[engine.sizeRank];
      if (size === "large-v3") {
        return {
          reason:
            "chosen only when the owner locks it (the automatic choice stops at large-v3-turbo)",
          fit: "not-checked",
        };
      }
      if (size && !allowed.has(size)) {
        return { reason: "too big for this PC (the speech budget)", fit: "not-checked" };
      }
    }
    const numbers = engineFacts(engine);
    if (!numbers) return { reason: "", fit: "not-checked" };
    const onGpu =
      engine.sizeRank !== undefined && facts.cudaRuntimeReady === true && !numbers.cpuOk;
    const verdict = checkModelFits(
      {
        name: engine.id,
        ramGb: numbers.minRamGb,
        ...(onGpu ? { vramGb: numbers.minVramGb } : {}),
        diskGb: numbers.diskBytes / 1e9,
      },
      facts.hardware,
      onGpu ? "gpu" : "cpu",
    );
    if (!verdict.ok)
      return { reason: verdict.reasons.join("; ") || "it does not fit", fit: "not-checked" };
    return { reason: "", fit: verdict.level === "tight" ? "tight" : "fits" };
  }
}

/** The ids the TTS ladder walks, in order: the Hindi chain's usable engines that have a ladder id. */
export function ttsLadderOrder(): string[] {
  const out: string[] = [];
  for (const id of VOICE_CHAINS.tts?.hi ?? []) {
    const engine = voiceEngineById.get(id);
    if (engine && isUsable(engine) && engine.ladderId) out.push(engine.ladderId);
  }
  return out;
}

/** The Whisper sizes in order, smallest first, from the rows that carry a `sizeRank`. */
export function speechSizeLadder(): string[] {
  return VOICE_ENGINES.filter((engine) => engine.sizeRank !== undefined)
    .sort((a, b) => (a.sizeRank ?? 0) - (b.sizeRank ?? 0))
    .map((engine) => SIZE_NAMES[engine.sizeRank ?? 0] ?? "");
}

/**
 * The rows for the Models page and the Install Manager: every engine that is not yet usable, with what it is and why it
 * cannot be installed or used yet, so the list is honest ("not installable yet") and no unusable engine looks working.
 */
export function notYetUsable(): {
  id: string;
  label: string;
  status: EngineStatus;
  why: string;
  flags: OwnerFlag[];
}[] {
  return VOICE_ENGINES.filter((engine) => !isUsable(engine)).map((engine) => ({
    id: engine.id,
    label: engine.label,
    status: engine.status,
    why: unusableReason(engine),
    flags: engine.flags,
  }));
}

/** The decisions only the owner can make, one line each, for every engine that carries a flag. */
export function ownerDecisions(): { id: string; flags: OwnerFlag[]; note: string }[] {
  return VOICE_ENGINES.filter((engine) => engine.flags.length).map((engine) => ({
    id: engine.id,
    flags: engine.flags,
    note: `${engine.label}: code ${engine.codeLicence}, weights ${engine.weightLicence}`,
  }));
}
