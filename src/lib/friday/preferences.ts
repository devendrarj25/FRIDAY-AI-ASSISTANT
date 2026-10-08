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
  /** faster-whisper size. auto keeps the measured tier. */
  sttSize: "auto" | "tiny" | "base" | "small" | "medium" | "large-v3";
  /** Short name used in status lines. Empty keeps the line unnamed. */
  addressName: string;
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
    panelOpacity: "100",
    graphicIntensity: "70",
    personality:
      "Be direct and short. State the risk before running any exec tool. Prefer local models; use an online model only for research or when local models disagree. After a failure, write one lesson to memory.",
    cpuBudget: "50",
    modelIdleMinutes: "10",
    sampleSeconds: "2",
    sessionTimeout: "30",
    quietStart: "22:00",
    quietEnd: "07:00",
    talk: "balanced",
  },
  voice: {
    wakeWord: "friday",
    recognitionLang: "hi-IN",
    inputDeviceId: "",
    speechLang: "hi-IN",
    voiceName: "Microsoft Swara Online (Natural) - Hindi (India)",
    // A soft, warm Indian-girl delivery: slightly slower, slightly brighter.
    rate: 0.96,
    pitch: 1.12,
    volume: 1,
    speakReplies: true,
    hinglish: true,
    duckOthers: true,
    whisperMode: false,
    privacyMode: false,
    pauseDuringCalls: true,
    sttSize: "auto",
    addressName: "",
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
      voice: { ...DEFAULT_PREFERENCES.voice, models: [], activeId: "" },
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
