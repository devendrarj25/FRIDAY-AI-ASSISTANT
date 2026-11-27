/**
 * FRIDAY preferences — the single canonical settings store.
 *
 * Everything the Settings page exposes lives here. The store hydrates once
 * from the desktop bridge (`config/friday-preferences.json` inside the
 * workspace, written by the main process) and falls back to localStorage in
 * the browser preview, so FRIDAY never resets after a restart.
 *
 * Writes are merged and debounced: flipping ten toggles costs one disk write.
 */
import { upgradeVoiceDefaults } from "./voice-presets";
import {
  DEFAULT_VOICE_CLOUD_PREFS,
  type VoiceCloudPrefs,
} from "./voice-engine/voice-cloud-settings";
import {
  DEFAULT_INTERRUPT_GATE,
  sanitizeInterruptGate,
  type InterruptGatePrefs,
} from "./voice-engine/interruption-controller";
import { normalizePttTailMs, PTT_TAIL_DEFAULT_MS } from "./push-to-talk";
import { normalizeWakeGuardConfig, WAKE_GUARD_DEFAULTS, type WakeGuardConfig } from "./wake-guard";
import { registerFlush } from "./persist";

/** How the voice task desk behaves while the owner keeps talking. Read by the voice conductor; stored in `voice.tasks`. */
export type VoiceTaskPrefs = {
  /** Tasks that may run at once (1 to 3). The settings page holds it at 1 until parallel lanes exist. */
  maxParallel: number;
  /** How much she says about a running task. */
  narration: "quiet" | "normal" | "chatty";
  /** Most spoken progress lines in one minute (0 to 6). */
  progressLinesPerMinute: number;
  /** Say a short line when a task is done. */
  speakDone: boolean;
  /** After a restart, ask before resuming tasks that were running; "auto" resumes read-only tasks under Full autonomy only. */
  resumeAfterRestart: "ask" | "auto";
  /** A quick question asked while a task runs is answered at once, beside the task. */
  sideQuestionLane: boolean;
};

export const DEFAULT_VOICE_TASK_PREFS: VoiceTaskPrefs = {
  maxParallel: 1,
  narration: "normal",
  progressLinesPerMinute: 3,
  speakDone: true,
  resumeAfterRestart: "ask",
  sideQuestionLane: true,
};

const wholeIn = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback;

/** How often she asks yes or no before a spoken order: only when it cannot be undone, also when cautious, or every time. */
export const CONFIRM_LEVELS = ["rare", "normal", "always"] as const;
export type VoiceConfirmLevel = (typeof CONFIRM_LEVELS)[number];

/** An unknown or missing word (an old stored shape) reads `rare`. */
export function sanitizeConfirmLevel(value: unknown): VoiceConfirmLevel {
  return (CONFIRM_LEVELS as readonly unknown[]).includes(value)
    ? (value as VoiceConfirmLevel)
    : "rare";
}

/**
 * The local voice styles the speech worker understands: "" and "friday" are FRIDAY's own default voice (sweet and
 * warm), "friday-bright" and "friday-calm" are its two variants, F1 to F5 and M1, M2 are the bundled presets.
 * An id outside this list (an old, odd or hand-edited stored value) is never sent to the engine.
 */
export const LOCAL_VOICE_STYLES = [
  "",
  "friday",
  "friday-bright",
  "friday-calm",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "M1",
  "M2",
] as const;
export type LocalVoiceStyle = (typeof LOCAL_VOICE_STYLES)[number];

/** A stored value that is not on the list reads "" (the FRIDAY voice); an explicit old F1 to F5 stays as chosen. */
export function sanitizeLocalVoiceStyle(value: unknown): LocalVoiceStyle {
  return (LOCAL_VOICE_STYLES as readonly unknown[]).includes(value)
    ? (value as LocalVoiceStyle)
    : "";
}

/** The engines the owner may pin; the names are the ones `rankTtsProviders` takes as `prefer`. */
export const TTS_ENGINE_PICKS = ["auto", "supertonic", "sapi"] as const;
export type TtsEnginePick = (typeof TTS_ENGINE_PICKS)[number];

/** An unknown or missing word (an old stored shape) reads `auto`, today's order. */
export function sanitizeTtsEngine(value: unknown): TtsEnginePick {
  return (TTS_ENGINE_PICKS as readonly unknown[]).includes(value)
    ? (value as TtsEnginePick)
    : "auto";
}

export const STT_SIZE_PICKS = [
  "auto",
  "tiny",
  "base",
  "small",
  "medium",
  "large-v3-turbo",
  "large-v3",
] as const;
export type SttSizePick = (typeof STT_SIZE_PICKS)[number];

/** An unknown or missing size reads `auto`, the size measured for this PC. */
export const HINGLISH_EAR_PICKS = ["off", "trelis"] as const;
export type HinglishEarPick = (typeof HINGLISH_EAR_PICKS)[number];

/** An unknown or missing word reads "off": the large Hinglish ear never runs unless the owner chose it. */
export function sanitizeHinglishEar(value: unknown): HinglishEarPick {
  return (HINGLISH_EAR_PICKS as readonly unknown[]).includes(value)
    ? (value as HinglishEarPick)
    : "off";
}

export function sanitizeSttSize(value: unknown): SttSizePick {
  return (STT_SIZE_PICKS as readonly unknown[]).includes(value) ? (value as SttSizePick) : "auto";
}

/** FRIDAY's own streaming ear: `off` (the shipped default) keeps the ordinary listening path. */
export const STREAM_ENGINE_PICKS = ["off", "auto", "nemotron", "stream-ear-nemotron"] as const;
export type StreamEnginePick = (typeof STREAM_ENGINE_PICKS)[number];

/** An unknown or missing word (an old stored shape) reads `off`. */
export function sanitizeStreamEngine(value: unknown): StreamEnginePick {
  return (STREAM_ENGINE_PICKS as readonly unknown[]).includes(value)
    ? (value as StreamEnginePick)
    : "off";
}

/** A device id is a short string; anything else (an old or hand-edited shape) reads the system default. */
export function sanitizeDeviceId(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 400) : "";
}

/** Days a kept utterance clip stays: a whole number from 1 to 90; anything else reads 7. */
export function sanitizeWavDays(value: unknown): number {
  const n = typeof value === "number" ? Math.round(value) : Number.NaN;
  return Number.isFinite(n) ? Math.min(90, Math.max(1, n)) : 7;
}

export const VOICE_TURN_CLASSIFIER_PICKS = ["off", "shadow", "live"] as const;

/** Turn-taking tuning (version 1). The end-of-turn classifier starts in shadow: it scores, it never acts. */
export type VoiceTurnPrefs = {
  v: 1;
  /** Learn the owner's own pause length from past turns. Off until tried on this PC. */
  calibrate: boolean;
  /** Use the sentence-final prior when deciding a turn has ended. */
  eotPrior: boolean;
  /** off: not run; shadow: scored and logged only; live: stored, but it still acts as shadow until its gates are met on this PC. */
  classifier: (typeof VOICE_TURN_CLASSIFIER_PICKS)[number];
  /** The longest wait for more speech before a turn is closed (1200 to 4000 ms). */
  maxWaitMs: number;
};

export const DEFAULT_VOICE_TURN: VoiceTurnPrefs = {
  v: 1,
  calibrate: false,
  eotPrior: true,
  classifier: "shadow",
  maxWaitMs: 2400,
};

/** A missing, partial or hand-edited `voice.turn` reads the defaults key by key; unknown words fall back, numbers clamp. */
export function sanitizeVoiceTurn(input: unknown): VoiceTurnPrefs {
  const src = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as {
    [K in keyof VoiceTurnPrefs]?: unknown;
  };
  const d = DEFAULT_VOICE_TURN;
  return {
    v: 1,
    calibrate: src.calibrate === true,
    eotPrior: typeof src.eotPrior === "boolean" ? src.eotPrior : d.eotPrior,
    classifier: pick(VOICE_TURN_CLASSIFIER_PICKS, src.classifier, d.classifier),
    maxWaitMs: wholeIn(src.maxWaitMs, 1200, 4000, d.maxWaitMs),
  };
}

export const VOICE_LEXICON_FIX_PICKS = ["off", "hints", "apply"] as const;

/** How well she understands (version 1): self-repair of a restarted phrase, the short command lane, the lexicon fix. */
export type VoiceUnderstandingPrefs = {
  v: 1;
  /** "no, I mean ..." and a restarted phrase keep only the last version. */
  selfRepair: boolean;
  /** A short known command skips the full brain turn. */
  commandLane: boolean;
  /** Lexicon corrections of heard words: off, hints (a hint to the brain) or apply (the words are rewritten). */
  lexiconFix: (typeof VOICE_LEXICON_FIX_PICKS)[number];
};

export const DEFAULT_VOICE_UNDERSTANDING: VoiceUnderstandingPrefs = {
  v: 1,
  selfRepair: true,
  commandLane: true,
  lexiconFix: "hints",
};

/** A missing, partial or hand-edited `voice.understanding` reads the defaults key by key. */
export function sanitizeVoiceUnderstanding(input: unknown): VoiceUnderstandingPrefs {
  const src = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as {
    [K in keyof VoiceUnderstandingPrefs]?: unknown;
  };
  const d = DEFAULT_VOICE_UNDERSTANDING;
  return {
    v: 1,
    selfRepair: typeof src.selfRepair === "boolean" ? src.selfRepair : d.selfRepair,
    commandLane: typeof src.commandLane === "boolean" ? src.commandLane : d.commandLane,
    lexiconFix: pick(VOICE_LEXICON_FIX_PICKS, src.lexiconFix, d.lexiconFix),
  };
}

/** Seconds a spoken yes stays valid: a whole number from 10 to 60; anything else reads 30. */
export function sanitizeApprovalTtlSec(value: unknown): number {
  return wholeIn(value, 10, 60, 30);
}

export const EARS_AGC_PICKS = ["browser", "own", "off"] as const;
export const EARS_VAD_PICKS = ["auto", "silero", "energy"] as const;
export const EARS_EAGERNESS_PICKS = ["eager", "normal", "patient"] as const;
export const EARS_DENOISE_PICKS = ["off", "rnnoise", "gtcrn", "dpdfnet2"] as const;
export const EARS_SCENE_PICKS = ["off", "score"] as const;
export const EARS_OTHER_VOICE_PICKS = ["off", "score", "hold"] as const;

/**
 * How FRIDAY's own listening front end behaves, stored as `voice.ears` (shape version 1). The ordinary browser
 * microphone filter stays `voice.noiseSuppression`; nothing here replaces it.
 */
export type VoiceEarsPrefs = {
  v: 1;
  /** Cut rumble, hum and handling thumps below 85 Hz before the sound is used. */
  hpf: boolean;
  /** Who levels the volume: the browser (today), FRIDAY's own slow leveller, or nobody. */
  agc: (typeof EARS_AGC_PICKS)[number];
  /** Warn in the diagnostics when the microphone is clipping. A meter only. */
  clipWarn: boolean;
  /** The speech detector: automatic, the small model, or the loudness-only one. */
  vad: (typeof EARS_VAD_PICKS)[number];
  /** Speech probability that starts a phrase (0.2 to 0.9). */
  vadStart: number;
  /** Probability below which the phrase is over (0.05 up to vadStart minus 0.05). */
  vadEnd: number;
  /** Shortest sound that counts as speech, in milliseconds (60 to 400). */
  minSpeechMs: number;
  /** Sound kept from just before speech starts, in milliseconds (200 to 1000). */
  preRollMs: number;
  /** How long she waits after a pause before taking the turn. */
  eagerness: (typeof EARS_EAGERNESS_PICKS)[number];
  /** Start preparing an answer at a likely end of turn; dropped if you keep talking. */
  eagerTurn: boolean;
  /** An optional clean-up copy for the speech model only. */
  denoise: (typeof EARS_DENOISE_PICKS)[number];
  /** Score what the room sounds like (speech, music, TV, noise). A score only. */
  scene: (typeof EARS_SCENE_PICKS)[number];
  /** Score whether a voice is the owner's. It never approves anything. */
  otherVoice: (typeof EARS_OTHER_VOICE_PICKS)[number];
  /** Use the PC's own playback as the echo reference. Off until tried on this PC. */
  pcAudioRef: boolean;
};

export const DEFAULT_VOICE_EARS: VoiceEarsPrefs = {
  v: 1,
  hpf: true,
  agc: "browser",
  clipWarn: true,
  vad: "auto",
  vadStart: 0.5,
  vadEnd: 0.35,
  minSpeechMs: 120,
  preRollMs: 500,
  eagerness: "normal",
  eagerTurn: false,
  denoise: "off",
  scene: "score",
  otherVoice: "score",
  pcAudioRef: false,
};

const pick = <T extends string>(list: readonly T[], value: unknown, fallback: T): T =>
  (list as readonly unknown[]).includes(value) ? (value as T) : fallback;

const rounded = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.min(max, Math.max(min, value)) * 100) / 100
    : fallback;

/**
 * A missing, partial or hand-edited `voice.ears` (an install from before it existed has none) reads the defaults
 * key by key; unknown words fall back and numbers clamp. The end threshold always sits at least 0.05 below the start.
 */
export function sanitizeVoiceEars(input: unknown): VoiceEarsPrefs {
  const src = (input && typeof input === "object" ? input : {}) as {
    [K in keyof VoiceEarsPrefs]?: unknown;
  };
  const d = DEFAULT_VOICE_EARS;
  const vadStart = rounded(src.vadStart, 0.2, 0.9, d.vadStart);
  const endCeiling = Math.round((vadStart - 0.05) * 100) / 100;
  return {
    v: 1,
    hpf: src.hpf === undefined ? d.hpf : src.hpf !== false,
    agc: pick(EARS_AGC_PICKS, src.agc, d.agc),
    clipWarn: src.clipWarn === undefined ? d.clipWarn : src.clipWarn !== false,
    vad: pick(EARS_VAD_PICKS, src.vad, d.vad),
    vadStart,
    vadEnd: rounded(src.vadEnd, 0.05, endCeiling, Math.min(d.vadEnd, endCeiling)),
    minSpeechMs: wholeIn(src.minSpeechMs, 60, 400, d.minSpeechMs),
    preRollMs: wholeIn(src.preRollMs, 200, 1000, d.preRollMs),
    eagerness: pick(EARS_EAGERNESS_PICKS, src.eagerness, d.eagerness),
    eagerTurn: src.eagerTurn === true,
    denoise: pick(EARS_DENOISE_PICKS, src.denoise, d.denoise),
    scene: pick(EARS_SCENE_PICKS, src.scene, d.scene),
    otherVoice: pick(EARS_OTHER_VOICE_PICKS, src.otherVoice, d.otherVoice),
    pcAudioRef: src.pcAudioRef === true,
  };
}

/** A stored or edited value is always made safe: unknown words fall back, numbers clamp, an old shape reads the defaults. */
export function sanitizeVoiceTaskPrefs(
  input: Partial<VoiceTaskPrefs> | null | undefined,
): VoiceTaskPrefs {
  const src = input ?? {};
  const d = DEFAULT_VOICE_TASK_PREFS;
  return {
    maxParallel: wholeIn(src.maxParallel, 1, 3, d.maxParallel),
    narration:
      src.narration === "quiet" || src.narration === "chatty" || src.narration === "normal"
        ? src.narration
        : d.narration,
    progressLinesPerMinute: wholeIn(src.progressLinesPerMinute, 0, 6, d.progressLinesPerMinute),
    speakDone: src.speakDone !== false,
    resumeAfterRestart: src.resumeAfterRestart === "auto" ? "auto" : "ask",
    sideQuestionLane: src.sideQuestionLane !== false,
  };
}

/** One selectable, individually tuned FRIDAY voice. */
export type VoiceModel = {
  id: string;
  label: string;
  /**
   * "system" = installed OS/browser voice, "file" = imported voice model,
   * "neural" = free edge-tts neural voice (natural Hindi / Indian English).
   */
  kind: "system" | "file" | "neural";
  voiceName: string;
  /** Absolute path of the imported file inside the workspace (file voices). */
  filePath?: string;
  sizeBytes?: number;
  lang: string;
  rate: number;
  pitch: number;
  volume: number;
  addedAt: number;
};

export type VoicePreferences = {
  /** Word that wakes FRIDAY up in auto mode. */
  wakeWord: string;
  /** Recognition language (Indian English / Hindi supported). */
  recognitionLang: string;
  /** Preferred Windows audio input device id ("" = system default). */
  inputDeviceId: string;
  /** Preferred speaker (audio output) device id ("" = system default). A missing device falls back to the default. */
  outputDeviceId: string;
  /** The browser's own noise suppression on the microphone. On is how FRIDAY has always opened it. */
  noiseSuppression: boolean;
  /** Which engine speaks: auto keeps today's order; supertonic is the local voice only; sapi is the system voice only. */
  ttsEngine: TtsEnginePick;
  /** Spoken reply language. */
  speechLang: string;
  /** Preferred voice name, e.g. Microsoft Swara Online (Natural) - Hindi. */
  voiceName: string;
  rate: number;
  pitch: number;
  volume: number;
  speakReplies: boolean;
  /** Reply in natural Hindi–English mix (Hinglish) the owner speaks in. */
  hinglish: boolean;
  /** Lower other apps while FRIDAY is speaking. Quiet hours do not duck them. */
  duckOthers: boolean;
  /** Quieter speech. It does not change a permission. */
  whisperMode: boolean;
  /** Cloud speech stays off even when a Neural voice is selected. */
  privacyMode: boolean;
  /** Stay quiet while a known call app is open. */
  pauseDuringCalls: boolean;
  /** Opt-in: overlap listening, thinking and speaking tighter (Auto mode only). */
  realtimeExperiment: boolean;
  /** Turn-taking tuning: calibration, end-of-turn prior, classifier mode, longest wait. */
  turn: VoiceTurnPrefs;
  /** Self-repair, the command lane and the lexicon fix. */
  understanding: VoiceUnderstandingPrefs;
  /** Seconds a spoken yes stays valid (10 to 60). */
  approvalTtlSec: number;
  /** On by default: the first spoken clause is cut small (4 to 8 words, at a comma or a dash) so the first sound comes sooner. */
  fastFirstClause: boolean;
  /** On by default: the local voice's clauses are played as raw samples through the gapless scheduler, not as a WAV file; the first failure turns it off for the session and speech goes on through the file path. */
  pcmPlayback: boolean;
  /** Warm the speech, voice, turn and brain engines once when Auto mode opens the microphone. Changes no audio. */
  prewarm: boolean;
  /** When a reply is cut off, the conversation remembers only the part that was heard, marked as cut. */
  trimHistoryToPlayed: boolean;
  /** Tasks that run while the owner keeps talking: narration, progress lines, restart, side questions. */
  tasks: VoiceTaskPrefs;
  /**
   * While she speaks, a nod ("hmm", "haan") or a cough only lowers her volume; she stops for real words, a stop word
   * or an answer to her question. On by default; the three numbers are the thresholds.
   */
  interruptGate: InterruptGatePrefs;
  /** Push-to-talk: how long the segment stays open after the key is released (100 to 800 ms). */
  pttTailMs: number;
  /** Hands-free wake gates: cooldown, speech before a wake, follow-up window, room-noise raise. Each value is bounded. */
  wake: WakeGuardConfig;
  /** Opt-in: a short acknowledgement is said while a task works. Off until tried on this PC. */
  instantAck: boolean;
  /** Opt-in, experimental: start thinking before the owner finishes speaking. Off until tried on this PC. */
  eagerTurn: boolean;
  /** Opt-in, experimental: her own voice is cancelled from the microphone. Off until tried on this PC. */
  echoReference: boolean;
  /**
   * Cloud voice limits. Everything starts off: no cloud request, no spend. The numbers are the owner's; a free
   * allowance is never assumed. See `voice-engine/voice-cloud-settings.ts`.
   */
  cloudVoice: VoiceCloudPrefs;
  /** The local voice style (see `LOCAL_VOICE_STYLES`). Empty means the FRIDAY voice, her own default. */
  localVoiceStyle: LocalVoiceStyle;
  /** Small changes of pace, pitch and volume per clause (a question rises, an apology softens). */
  expressiveSpeech: boolean;
  /** Speech Prep: English words and Roman Hindi in Hindi replies are written in Devanagari before the voice reads them. */
  speechPrep: boolean;
  /** How often she asks yes or no first: rare (default), normal, always. Dangerous orders always ask in every position. */
  confirmLevel: VoiceConfirmLevel;
  /** The optional light Hindi voice (Models, "Hindi light voice") for Devanagari-only Hindi lines. Off by default. */
  hindiLightVoice: boolean;
  /** Keep the last spoken clips as WAV files for the voice diagnostics. Off by default: no raw audio is saved. */
  keepUtteranceWavs: boolean;
  /** Days a kept clip stays when `keepUtteranceWavs` is on (1 to 90). */
  utteranceWavDays: number;
  /** Clean the words shown for what the owner said (fillers, spoken punctuation, corrections); what the brain gets is unchanged. */
  tidyDictation: boolean;
  /** Show the words while the owner is still speaking (a recognition every second or so: uses more CPU). */
  liveWords: boolean;
  /** The streaming ear (partial words while she listens): off, auto, or a named engine. Local only; off by default. */
  streamEngine: StreamEnginePick;
  /** FRIDAY's own listening front end: filters, speech detector, turn timing, optional clean-up and scoring. */
  ears: VoiceEarsPrefs;
  /** Read spoken numbers, times and money in Hinglish as digits in the words shown (runs after the tidy step). */
  itn: boolean;
  /** Score the shared microphone for the wake word as it arrives (needs an openWakeWord model; local only). */
  liveWake: boolean;
  /** A saved voice may block a sensitive command from a voice that does not match it. It never approves anything. */
  recogniseMyVoice: boolean;
  /** Ignore what clearly is not the owner's saved voice (a stop is always heard). Off by default. */
  ownerVoiceOnly: boolean;
  /** The owner's own "Friday" recordings may wake her when the transcript missed the word. */
  personalWake: boolean;
  /** Names and words FRIDAY should expect to hear (kept on this PC, used as a hint when listening). */
  vocabulary: string;
  /** FRIDAY's own Hindi voice (an online neural voice id). Empty uses the default, Swara. */
  hindiVoice: string;
  /** FRIDAY's own English voice (an online neural voice id). Empty uses the default, Neerja. */
  englishVoice: string;
  /** The delivery preset the sliders were last set from ("custom" once moved). Display only. */
  voicePreset: string;
  /** Which shipped voice numbers this install was moved to (0 = the first ones). */
  voicePresetVersion: number;
  /** Days to keep finished voice notes and meeting notes; 0 keeps them until deleted. */
  notesRetentionDays: number;
  /** Words the voice should say differently: { written: "said as" }. Wins over the built-in dictionary. */
  pronunciations: Record<string, string>;
  /** faster-whisper size. auto keeps the measured tier. */
  sttSize: SttSizePick;
  /** Listen for the language again on every phrase (faster-whisper multilingual). Off by default; auto language only. */
  sttMultilingual: boolean;
  /** The optional large Hinglish ear for mixed Hindi-English phrases: off (default) or the Trelis one. GPU only, opt-in. */
  hinglishEar: HinglishEarPick;
  /** Short name used in status lines. Empty keeps the line unnamed. */
  addressName: string;
  /** When a heard line is a turn. Conversation is the fresh-install default. */
  addressMode: "name-only" | "conversation" | "meant-for-me";
  /** Auto mode only. "always" listens for every utterance; "push-to-talk" waits for the talk key. */
  listenStyle: "always" | "push-to-talk";
  /** Seconds after FRIDAY speaks in which the next line is a follow-up. */
  addressWindowSec: number;
  /** Minutes of heard lines kept on this PC. Zero turns the log off. */
  heardKeepMin: number;
  /** Heard rows kept on this PC. Zero turns the log off. */
  heardKeepRows: number;
  /** Ambient lines may be added to a cloud prompt only when Privacy mode is off. */
  allowAmbientCloud: boolean;
  /** Voice library — imported and registered voices, each with its tuning. */
  models: VoiceModel[];
  /** Id of the active entry in `models` ("" = use the plain fields above). */
  activeId: string;
};

export type FridayPreferences = {
  theme: string;
  toggles: Record<string, boolean>;
  fields: Record<string, string>;
  voice: VoicePreferences;
};

export const DEFAULT_PREFERENCES: FridayPreferences = {
  theme: "",
  toggles: {
    startup: true,
    tray: true,
    background: true,
    autoUpdate: true,
    updateCheck: false,
    confirmExit: true,
    notifications: true,
    sounds: false,
    telemetry: false,
    autoIndex: true,
    repoWatch: true,
    autoBuild: false,
    circuit: true,
    glow: true,
    scanlines: true,
    gpuRender: true,
    autoLite: true,
    reduceMotion: false,
    animations: true,
    blur: true,
    highContrast: true,
    memOpt: true,
    autoClear: true,
    longTerm: true,
    encryption: true,
    secureComm: true,
    biometric: false,
    safeTools: true,
    workspaceWrites: false,
    execApproval: true,
    installApproval: true,
    pcControlApproval: true,
    lessons: true,
    rememberChats: true,
    memorySnapshot: false,
    autoSnapshot: false,
    autoLock: false,
    maskSecrets: false,
    blockUnknownHosts: false,
    auditLog: true,
    speakAlerts: false,
    notifyTaskDone: true,
    notifyTaskFail: true,
    notifyUpdates: true,
    notifyHealth: true,
    throttleFullscreen: false,
    pauseOnBattery: false,
    keepModelsWarm: true,
    unloadIdleModels: true,
    alwaysOnTop: false,
    launchMinimized: false,
    followSystem: false,
    chatTimestamps: false,
    doNotDisturb: false,
    quietHours: false,
    clearWorkingOnQuit: false,
  },
  fields: {
    language: "English",
    timezone: "(UTC+05:30) Asia/Kolkata",
    dateFormat: "DD-MM-YYYY",
    timeFormat: "12 Hour",
    updateChannel: "Stable",
    // Auto Mode follow-up window in seconds (see attention-window.ts).
    attentionWindow: "45",
    landingPage: "Friday (Main Window)",
    importTarget: "Workspace",
    buildOutput: "",
    archiveFormat: "ZIP (all files)",
    githubToken: "",
    font: "Orbitron",
    bodyFont: "Rajdhani",
    colorMode: "dark",
    accent: "cyan",
    density: "Normal",
    sidebarDefault: "Expanded",
    bubbleStyle: "Compact",
    textSize: "Normal",
    // Text settings (appearance.ts): "" means the named text size; the others are named choices.
    textScale: "",
    lineSpacing: "Normal",
    letterSpacing: "Normal",
    textWeight: "Medium",
    headingWeight: "Bold",
    chatTextSize: "Match",
    smallText: "Standard",
    codeFont: "JetBrains Mono",
    panelOpacity: "100",
    graphicIntensity: "70",
    // FRIDAY Glass (appearance.ts): interface style, glass depth, labels.
    uiStyle: "glass",
    glassDepth: "Balanced",
    cornerStyle: "Round",
    ambientLight: "Vivid",
    ambientMotion: "Off",
    buttonLabels: "hover",
    personality:
      "Be direct and short. State the risk before running any exec tool. Prefer local models; use an online model only for research or when local models disagree. After a failure, write one lesson to memory.",
    cpuBudget: "50",
    modelIdleMinutes: "10",
    sampleSeconds: "2",
    sessionTimeout: "30",
    quietStart: "22:00",
    quietEnd: "07:00",
    talk: "balanced",
    warmth: "steady",
  },
  voice: {
    wakeWord: "friday",
    // A fresh install listens in auto: Hindi, English or mixed speech is each heard by the right engine. An install
    // that already stored a choice (hi-IN included) keeps it: a stored value cannot be told from an explicit pick.
    recognitionLang: "auto",
    inputDeviceId: "",
    outputDeviceId: "",
    noiseSuppression: true,
    ttsEngine: "auto",
    speechLang: "hi-IN",
    voiceName: "Microsoft Swara Online (Natural) - Hindi (India)",
    // A soft, warm Indian-girl delivery: slightly slower, slightly brighter.
    // The natural preset (voice-presets.ts): the neural voice's own pitch, a touch slower than its own pace.
    rate: 0.97,
    pitch: 1,
    volume: 1,
    speakReplies: true,
    hinglish: true,
    duckOthers: true,
    whisperMode: false,
    privacyMode: false,
    pauseDuringCalls: true,
    realtimeExperiment: false,
    turn: { ...DEFAULT_VOICE_TURN },
    understanding: { ...DEFAULT_VOICE_UNDERSTANDING },
    approvalTtlSec: 30,
    fastFirstClause: true,
    pcmPlayback: true,
    prewarm: true,
    trimHistoryToPlayed: true,
    tasks: { ...DEFAULT_VOICE_TASK_PREFS },
    interruptGate: { ...DEFAULT_INTERRUPT_GATE },
    pttTailMs: PTT_TAIL_DEFAULT_MS,
    wake: { ...WAKE_GUARD_DEFAULTS },
    instantAck: false,
    eagerTurn: false,
    echoReference: false,
    cloudVoice: { ...DEFAULT_VOICE_CLOUD_PREFS },
    pronunciations: {},
    tidyDictation: true,
    liveWords: false,
    streamEngine: "off",
    ears: { ...DEFAULT_VOICE_EARS },
    itn: true,
    liveWake: false,
    recogniseMyVoice: true,
    ownerVoiceOnly: false,
    personalWake: true,
    vocabulary: "",
    hindiVoice: "hi-IN-SwaraNeural",
    englishVoice: "en-IN-NeerjaNeural",
    voicePreset: "natural",
    voicePresetVersion: 1,
    notesRetentionDays: 30,
    expressiveSpeech: true,
    speechPrep: true,
    confirmLevel: "rare",
    hindiLightVoice: false,
    keepUtteranceWavs: false,
    utteranceWavDays: 7,
    localVoiceStyle: "",
    sttSize: "auto",
    sttMultilingual: false,
    hinglishEar: "off",
    addressName: "",
    addressMode: "conversation",
    listenStyle: "always",
    addressWindowSec: 8,
    heardKeepMin: 10,
    heardKeepRows: 40,
    allowAmbientCloud: false,
    models: [],
    activeId: "",
  },
};

const STORAGE_KEY = "friday.preferences";

type Bridge = {
  getPreferences?: () => Promise<Partial<FridayPreferences> | null>;
  setPreferences?: (value: FridayPreferences) => Promise<unknown>;
};

const bridge = (): Bridge | null =>
  typeof window === "undefined"
    ? null
    : ((window as unknown as { friday?: Bridge }).friday ?? null);

/** Only a plain object can patch `ears`; anything else (null, a string, an array) patches nothing. */
const earsPatch = (value: unknown): Partial<VoiceEarsPrefs> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Partial<VoiceEarsPrefs>)
    : {};

/** A text setting must be a string; a stored null or a number reads the value already held. */
const textOr = (value: unknown, fallback: string): string =>
  typeof value === "string" ? value : fallback;

/** Only a plain object can patch a nested setting. */
const objectPatch = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function merge(
  base: FridayPreferences,
  patch: Partial<FridayPreferences> | null,
): FridayPreferences {
  if (!patch) return base;
  return {
    theme: typeof patch.theme === "string" ? patch.theme : base.theme,
    toggles: { ...base.toggles, ...(patch.toggles ?? {}) },
    fields: { ...base.fields, ...(patch.fields ?? {}) },
    voice: {
      ...base.voice,
      ...(patch.voice ?? {}),
      // A partial voice patch (a single slider) must never wipe the library.
      models: Array.isArray(patch.voice?.models) ? patch.voice.models : base.voice.models,
      // Task settings merge key by key and are made safe; an old shape without them keeps the defaults.
      tasks: sanitizeVoiceTaskPrefs({ ...base.voice.tasks, ...(patch.voice?.tasks ?? {}) }),
      interruptGate: sanitizeInterruptGate({
        ...base.voice.interruptGate,
        ...(patch.voice?.interruptGate ?? {}),
      }),
      wakeWord: textOr(patch.voice?.wakeWord, base.voice.wakeWord),
      recognitionLang: textOr(patch.voice?.recognitionLang, base.voice.recognitionLang),
      speechLang: textOr(patch.voice?.speechLang, base.voice.speechLang),
      voiceName: textOr(patch.voice?.voiceName, base.voice.voiceName),
      addressName: textOr(patch.voice?.addressName, base.voice.addressName),
      turn: sanitizeVoiceTurn({ ...base.voice.turn, ...objectPatch(patch.voice?.turn) }),
      understanding: sanitizeVoiceUnderstanding({
        ...base.voice.understanding,
        ...objectPatch(patch.voice?.understanding),
      }),
      approvalTtlSec: sanitizeApprovalTtlSec(
        patch.voice?.approvalTtlSec ?? base.voice.approvalTtlSec,
      ),
      pttTailMs: normalizePttTailMs(patch.voice?.pttTailMs ?? base.voice.pttTailMs),
      wake: normalizeWakeGuardConfig({ ...base.voice.wake, ...(patch.voice?.wake ?? {}) }),
      instantAck: (patch.voice?.instantAck ?? base.voice.instantAck) === true,
      eagerTurn: (patch.voice?.eagerTurn ?? base.voice.eagerTurn) === true,
      echoReference: (patch.voice?.echoReference ?? base.voice.echoReference) === true,
      hindiLightVoice: (patch.voice?.hindiLightVoice ?? base.voice.hindiLightVoice) === true,
      localVoiceStyle: sanitizeLocalVoiceStyle(
        patch.voice?.localVoiceStyle ?? base.voice.localVoiceStyle,
      ),
      confirmLevel: sanitizeConfirmLevel(patch.voice?.confirmLevel ?? base.voice.confirmLevel),
      // Device, engine and size choices: an old or odd stored shape reads the shipped default.
      inputDeviceId: sanitizeDeviceId(patch.voice?.inputDeviceId ?? base.voice.inputDeviceId),
      outputDeviceId: sanitizeDeviceId(patch.voice?.outputDeviceId ?? base.voice.outputDeviceId),
      noiseSuppression: (patch.voice?.noiseSuppression ?? base.voice.noiseSuppression) !== false,
      ttsEngine: sanitizeTtsEngine(patch.voice?.ttsEngine ?? base.voice.ttsEngine),
      sttSize: sanitizeSttSize(patch.voice?.sttSize ?? base.voice.sttSize),
      hinglishEar: sanitizeHinglishEar(patch.voice?.hinglishEar ?? base.voice.hinglishEar),
      streamEngine: sanitizeStreamEngine(patch.voice?.streamEngine ?? base.voice.streamEngine),
      // A missing or partial `ears` object (an older install) fills from the defaults and clamps.
      ears: sanitizeVoiceEars({ ...base.voice.ears, ...earsPatch(patch.voice?.ears) }),
      itn: (patch.voice?.itn ?? base.voice.itn) !== false,
      keepUtteranceWavs: (patch.voice?.keepUtteranceWavs ?? base.voice.keepUtteranceWavs) === true,
      utteranceWavDays: sanitizeWavDays(
        patch.voice?.utteranceWavDays ?? base.voice.utteranceWavDays,
      ),
    },
  };
}

class PreferencesStore {
  private listeners = new Set<() => void>();
  private hydrated = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private state: FridayPreferences = DEFAULT_PREFERENCES;
  private snapshot: FridayPreferences = DEFAULT_PREFERENCES;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    void this.hydrate();
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  private emit() {
    this.snapshot = this.state;
    this.listeners.forEach((l) => l());
  }

  /** Read persisted preferences once. Safe to call from anywhere. */
  async hydrate(): Promise<FridayPreferences> {
    if (this.hydrated || typeof window === "undefined") return this.state;
    this.hydrated = true;
    let stored: Partial<FridayPreferences> | null = null;
    const api = bridge();
    if (api?.getPreferences) {
      try {
        stored = await api.getPreferences();
      } catch {
        stored = null;
      }
    }
    // Desktop: the FRIDAY folder on disk is the ONLY store. The browser cache
    // is read solely in the web preview, where no bridge exists.
    if (!stored && !api?.setPreferences) {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        stored = raw ? (JSON.parse(raw) as Partial<FridayPreferences>) : null;
      } catch {
        stored = null;
      }
    }
    this.state = merge(DEFAULT_PREFERENCES, stored);
    // An install that still holds the first shipped voice numbers is moved to the natural preset, once.
    if (stored?.voice) {
      const upgraded = upgradeVoiceDefaults({ ...stored.voice });
      if (upgraded.changed) {
        this.state = merge(this.state, { voice: upgraded.voice as VoicePreferences });
        this.schedule();
      }
    }
    this.emit();
    return this.state;
  }

  update(patch: Partial<FridayPreferences>) {
    this.state = merge(this.state, patch);
    this.emit();
    this.schedule();
  }

  setToggle(key: string, value: boolean) {
    this.update({ toggles: { [key]: value } });
  }

  setField(key: string, value: string) {
    this.update({ fields: { [key]: value } });
  }

  setVoice(patch: Partial<VoicePreferences>) {
    this.update({ voice: patch as VoicePreferences });
  }

  setTheme(theme: string) {
    this.update({ theme });
  }

  /** Restore shipped defaults. Voice library entries are cleared. */
  reset(): void {
    this.state = {
      theme: DEFAULT_PREFERENCES.theme,
      toggles: { ...DEFAULT_PREFERENCES.toggles },
      fields: { ...DEFAULT_PREFERENCES.fields },
      voice: {
        ...DEFAULT_PREFERENCES.voice,
        tasks: { ...DEFAULT_VOICE_TASK_PREFS },
        ears: { ...DEFAULT_VOICE_EARS },
        models: [],
        activeId: "",
      },
    };
    this.emit();
    void this.flush();
  }

  exportJson(): string {
    return JSON.stringify(this.state, null, 2);
  }

  importJson(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("That file is not valid JSON");
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error("That file is not a FRIDAY preferences export");
    }
    const patch = parsed as Partial<FridayPreferences>;
    if (!patch.toggles && !patch.fields && !patch.voice && typeof patch.theme !== "string") {
      throw new Error("That file is not a FRIDAY preferences export");
    }
    this.state = merge(DEFAULT_PREFERENCES, patch);
    this.emit();
    void this.flush();
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 250);
  }

  /** Sends a change that is still waiting on its debounce now (the window is closing or hidden). */
  flushPending(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    void this.flush();
  }

  /** Persist immediately (used by the Save button). */
  async flush(): Promise<void> {
    if (typeof window === "undefined") return;
    const value = this.state;
    const api = bridge();
    if (!api?.setPreferences) {
      // Web preview only: no FRIDAY folder to write to, so the browser copy is
      // all there is. In the desktop app nothing is mirrored to localStorage.
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      } catch {
        /* storage blocked — nothing else to fall back to in the preview */
      }
      return;
    }
    try {
      await api.setPreferences(value);
    } catch {
      /* main process unavailable — retried on the next change */
    }
  }
}

export const preferences = new PreferencesStore();

// A text or font change made just before the window closes must not die in the 250 ms debounce.
registerFlush(() => preferences.flushPending());
