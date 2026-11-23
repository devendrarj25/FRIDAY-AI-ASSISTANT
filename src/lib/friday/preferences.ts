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

/** Days a kept utterance clip stays: a whole number from 1 to 90; anything else reads 7. */
export function sanitizeWavDays(value: unknown): number {
  const n = typeof value === "number" ? Math.round(value) : Number.NaN;
  return Number.isFinite(n) ? Math.min(90, Math.max(1, n)) : 7;
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
  /** Opt-in: the first spoken clause is cut small (4 to 8 words, at a comma or a dash) so the first sound comes sooner. */
  fastFirstClause: boolean;
  /** Opt-in: the local voice's clauses are played as raw samples through the gapless scheduler, not as a WAV file. */
  pcmPlayback: boolean;
  /** Warm the speech, voice, turn and brain engines once when Auto mode opens the microphone. Changes no audio. */
  prewarm: boolean;
  /** When a reply is cut off, the conversation remembers only the part that was heard, marked as cut. */
  trimHistoryToPlayed: boolean;
  /** Tasks that run while the owner keeps talking: narration, progress lines, restart, side questions. */
  tasks: VoiceTaskPrefs;
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
  /** The local voice style (F1 to F5, female styles of the local voice). Empty keeps the default, F2. */
  localVoiceStyle: "" | "F1" | "F2" | "F3" | "F4" | "F5";
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
  sttSize: "auto" | "tiny" | "base" | "small" | "medium" | "large-v3-turbo" | "large-v3";
  /** Listen for the language again on every phrase (faster-whisper multilingual). Off by default; auto language only. */
  sttMultilingual: boolean;
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
    fastFirstClause: false,
    pcmPlayback: false,
    prewarm: true,
    trimHistoryToPlayed: true,
    tasks: { ...DEFAULT_VOICE_TASK_PREFS },
    instantAck: false,
    eagerTurn: false,
    echoReference: false,
    cloudVoice: { ...DEFAULT_VOICE_CLOUD_PREFS },
    pronunciations: {},
    tidyDictation: true,
    liveWords: false,
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
      instantAck: (patch.voice?.instantAck ?? base.voice.instantAck) === true,
      eagerTurn: (patch.voice?.eagerTurn ?? base.voice.eagerTurn) === true,
      echoReference: (patch.voice?.echoReference ?? base.voice.echoReference) === true,
      hindiLightVoice: (patch.voice?.hindiLightVoice ?? base.voice.hindiLightVoice) === true,
      confirmLevel: sanitizeConfirmLevel(patch.voice?.confirmLevel ?? base.voice.confirmLevel),
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
