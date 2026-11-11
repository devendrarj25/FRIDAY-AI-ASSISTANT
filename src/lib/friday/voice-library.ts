/**
 * FRIDAY · voice library.
 *
 * One canonical place for the voices FRIDAY can speak with:
 *   - "system" voices installed in Windows / the browser (SpeechSynthesis)
 *   - "file"  voices imported by the user (a local voice-model file that is
 *             copied into <workspace>/resources/voices and remembered)
 *
 * Every entry carries its own tuning (language, rate, pitch, volume), so each
 * voice keeps the customisation it was saved with. The list lives inside the
 * preferences store, which already persists to
 * <workspace>/config/friday-preferences.json — so it survives restarts.
 */
import { applyExpression, expressionFor, pauseAfter } from "./voice-engine/expression";
import { runSpeechPipeline } from "./voice-engine/speech-pipeline";
import { attachSpeechAudio, pulseSpeechAudio, stopSpeechAudio } from "./character/speech-audio";
import { preferences, type VoiceModel } from "./preferences";
import { alertsAudible } from "./settings-runtime";
import { readVoiceSurface, shouldDuck, spokenReplyAllowed } from "./voice-session";

export type { VoiceModel };

export type NeuralVoice = { id: string; label: string; lang: string };

type VoiceBridge = {
  neuralVoiceStatus?: () => Promise<{ available: boolean; reason?: string; version?: string }>;
  installNeuralVoice?: () => Promise<{ ok: boolean; error?: string; version?: string }>;
  listNeuralVoices?: () => Promise<{ available: boolean; reason?: string; voices: NeuralVoice[] }>;
  speakNeural?: (payload: {
    text: string;
    voice: string;
    rate: number;
    volume: number;
    pitch: number;
    lang?: string;
    /** The local voice style (F1 to F5). Ignored by cloud voices. */
    style?: string;
  }) => Promise<{
    ok: boolean;
    reason?: string;
    mime?: string;
    audioBase64?: string;
    engine?: string;
    cloud?: boolean;
    voice?: string;
    note?: string;
  }>;
  duckAudio?: (payload: {
    on: boolean;
  }) => Promise<{ ok: boolean; ducked?: boolean; reason?: string }>;
  importVoiceModel?: (payload: {
    name: string;
    dataBase64: string;
  }) => Promise<{ path: string; name: string; size: number }>;
  removeVoiceModel?: (filePath: string) => Promise<boolean>;
  listVoiceModels?: () => Promise<Array<{ path: string; name: string; size: number }>>;
};

const bridge = (): VoiceBridge | null =>
  typeof window === "undefined"
    ? null
    : ((window as unknown as { friday?: VoiceBridge }).friday ?? null);

/** Voices the operating system / browser exposes right now. */
export function systemVoices(): SpeechSynthesisVoice[] {
  if (typeof window === "undefined" || !window.speechSynthesis) return [];
  try {
    return window.speechSynthesis.getVoices();
  } catch {
    return [];
  }
}

/** Chrome/Edge populate the voice list asynchronously — notify when ready. */
export function onSystemVoices(cb: (voices: SpeechSynthesisVoice[]) => void): () => void {
  if (typeof window === "undefined" || !window.speechSynthesis) return () => {};
  const synth = window.speechSynthesis;
  const emit = () => cb(systemVoices());
  emit();
  synth.addEventListener?.("voiceschanged", emit);
  return () => synth.removeEventListener?.("voiceschanged", emit);
}

const uid = () => `voice_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

function currentModels(): VoiceModel[] {
  return preferences.getSnapshot().voice.models ?? [];
}

function writeModels(models: VoiceModel[], activeId?: string) {
  preferences.setVoice({
    models,
    ...(activeId === undefined ? {} : { activeId }),
  });
  void preferences.flush();
}

/** Register a system (installed) voice as a reusable, tunable FRIDAY voice. */
export function addSystemVoice(voiceName: string, lang: string): VoiceModel {
  const base = preferences.getSnapshot().voice;
  const existing = currentModels().find((m) => m.kind === "system" && m.voiceName === voiceName);
  if (existing) {
    writeModels(currentModels(), existing.id);
    return existing;
  }
  const model: VoiceModel = {
    id: uid(),
    label: voiceName,
    kind: "system",
    voiceName,
    lang: lang || base.speechLang,
    rate: base.rate,
    pitch: base.pitch,
    volume: base.volume,
    addedAt: Date.now(),
  };
  writeModels([...currentModels(), model], model.id);
  return model;
}

/**
 * Import a local voice-model file. In the desktop app the bytes are copied
 * into the workspace so the voice is still there after a reinstall; in the
 * browser preview the entry is remembered by name only.
 */
export async function importVoiceFile(file: File): Promise<VoiceModel> {
  const api = bridge();
  let filePath: string | undefined;
  if (api?.importVoiceModel) {
    const buffer = await file.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    const saved = await api.importVoiceModel({ name: file.name, dataBase64: btoa(binary) });
    filePath = saved.path;
  }
  const base = preferences.getSnapshot().voice;
  const model: VoiceModel = {
    id: uid(),
    label: file.name.replace(/\.[^.]+$/, ""),
    kind: "file",
    voiceName: file.name.replace(/\.[^.]+$/, ""),
    ...(filePath ? { filePath } : {}),
    sizeBytes: file.size,
    lang: base.speechLang,
    rate: base.rate,
    pitch: base.pitch,
    volume: base.volume,
    addedAt: Date.now(),
  };
  writeModels([...currentModels(), model], model.id);
  return model;
}

/** Save the tuning of one voice (language, rate, pitch, volume, label). */
export function updateVoiceModel(id: string, patch: Partial<VoiceModel>) {
  writeModels(currentModels().map((m) => (m.id === id ? { ...m, ...patch, id: m.id } : m)));
}

/** Make one voice the active FRIDAY voice for Auto mode. */
export function selectVoiceModel(id: string) {
  const model = currentModels().find((m) => m.id === id);
  if (!model) return;
  preferences.setVoice({
    activeId: id,
    voiceName: model.voiceName,
    speechLang: model.lang,
    rate: model.rate,
    pitch: model.pitch,
    volume: model.volume,
  });
  void preferences.flush();
}

/** Remove a voice; imported files are deleted from the workspace too. */
export async function removeVoiceModel(id: string) {
  const model = currentModels().find((m) => m.id === id);
  const next = currentModels().filter((m) => m.id !== id);
  const activeId = preferences.getSnapshot().voice.activeId === id ? "" : undefined;
  writeModels(next, activeId);
  if (model?.kind === "file" && model.filePath) {
    try {
      await bridge()?.removeVoiceModel?.(model.filePath);
    } catch {
      /* file already gone — the entry is removed either way */
    }
  }
}

/* --------------------------------------------------------- neural voices */

/** Is the free edge-tts neural path usable right now (and if not, why)? */
export async function neuralVoiceStatus(): Promise<{
  available: boolean;
  reason?: string;
  version?: string;
}> {
  const api = bridge();
  if (!api?.neuralVoiceStatus)
    return { available: false, reason: "Neural voices need the FRIDAY desktop app." };
  try {
    return await api.neuralVoiceStatus();
  } catch (error) {
    return { available: false, reason: (error as Error)?.message ?? "unavailable" };
  }
}

/** Install edge-tts through the shared Python toolchain (free, no API key). */
export async function installNeuralVoice() {
  const api = bridge();
  if (!api?.installNeuralVoice) return { ok: false, error: "Desktop app required." };
  return api.installNeuralVoice();
}

/** Neural voices FRIDAY can speak with (Indian female voices come first). */
export async function listNeuralVoices(): Promise<NeuralVoice[]> {
  const api = bridge();
  if (!api?.listNeuralVoices) return [];
  try {
    const result = await api.listNeuralVoices();
    return result?.voices ?? [];
  } catch {
    return [];
  }
}

/** Register a neural voice as a tunable, selectable FRIDAY voice. */
export function addNeuralVoice(voice: NeuralVoice): VoiceModel {
  const base = preferences.getSnapshot().voice;
  const existing = currentModels().find((m) => m.kind === "neural" && m.voiceName === voice.id);
  if (existing) {
    writeModels(currentModels(), existing.id);
    return existing;
  }
  const model: VoiceModel = {
    id: uid(),
    label: voice.label,
    kind: "neural",
    voiceName: voice.id,
    lang: voice.lang,
    rate: base.rate,
    pitch: base.pitch,
    volume: base.volume,
    addedAt: Date.now(),
  };
  writeModels([...currentModels(), model], model.id);
  return model;
}

/** Default neural voice for a language — Swara for Hindi, Neerja for English. */
export function neuralVoiceFor(lang: string, preferred?: string): string {
  const hindi = /^hi/i.test(lang);
  if (preferred && /Neural$/.test(preferred)) {
    const preferredIsHindi = preferred.startsWith("hi-");
    if (preferredIsHindi === hindi) return preferred;
  }
  return hindi ? "hi-IN-SwaraNeural" : "en-IN-NeerjaNeural";
}

/**
 * Cloud id for this clause. A fresh install (no Neural id saved) uses Swara
 * or Neerja. An explicit Neural pick is kept. Supertonic passes kind neural
 * with an empty name and must not be sent to the cloud. Privacy and the
 * system path pass allowCloud false.
 */
export function cloudVoiceFor(
  tuning: { kind?: string | undefined; voiceName?: string | undefined },
  lang: string,
  allowCloud: boolean,
): string {
  if (!allowCloud) return "";
  if (tuning.kind === "file" || tuning.kind === "system") return "";
  const name = tuning.voiceName || "";
  if (tuning.kind === "neural" && !/Neural$/i.test(name)) return "";
  if (/Neural$/i.test(name)) return neuralVoiceFor(lang, name);
  return neuralVoiceFor(lang);
}

const HINGLISH_WORDS: Record<string, string> = {
  hai: "है",
  hain: "हैं",
  hoon: "हूं",
  ho: "हो",
  nahi: "नहीं",
  nahin: "नहीं",
  kya: "क्या",
  kal: "कल",
  subah: "सुबह",
  baje: "बजे",
  bolo: "बोलो",
  bol: "बोल",
  karo: "करो",
  karna: "करना",
  chahiye: "चाहिए",
  theek: "ठीक",
  thik: "ठीक",
  haan: "हाँ",
  han: "हाँ",
  mujhe: "मुझे",
  tum: "तुम",
  aap: "आप",
  namaste: "नमस्ते",
  shukriya: "शुक्रिया",
  dhanyavad: "धन्यवाद",
  abhi: "अभी",
  lekin: "लेकिन",
  yaar: "यार",
  kholo: "खोलो",
  batao: "बताओ",
  suno: "सुनो",
  ruko: "रुको",
  chalo: "चलो",
  jao: "जाओ",
  aao: "आओ",
  aayega: "आएगा",
  kahan: "कहां",
  kab: "कब",
  kyun: "क्यों",
  kaise: "कैसे",
  accha: "अच्छा",
  achha: "अच्छा",
  bilkul: "बिल्कुल",
  zaroor: "जरूर",
  chalao: "चलाओ",
  dikhao: "दिखाओ",
  samjho: "समझो",
  me: "में",
  mein: "में",
  ka: "का",
  ki: "की",
  ke: "के",
  ko: "को",
  se: "से",
  par: "पर",
  pe: "पे",
  aur: "और",
  bhi: "भी",
  toh: "तो",
  na: "ना",
};

const HINGLISH_STRONG = new Set(
  Object.keys(HINGLISH_WORDS).filter(
    (word) =>
      ![
        "me",
        "mein",
        "ka",
        "ki",
        "ke",
        "ko",
        "se",
        "par",
        "pe",
        "aur",
        "ho",
        "na",
        "bhi",
        "toh",
      ].includes(word),
  ),
);

const SPOKEN_PROTECT =
  /(`[^`]*`|https?:\/\/\S+|\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b|[A-Za-z]:\\[^\s]+)/g;

function maskSpoken(text: string): { text: string; holes: string[] } {
  const holes: string[] = [];
  const masked = text.replace(SPOKEN_PROTECT, (span) => {
    const token = `\uE000${holes.length}\uE000`;
    holes.push(span);
    return token;
  });
  return { text: masked, holes };
}

function unmaskSpoken(text: string, holes: string[]): string {
  return text.replace(/\uE000(\d+)\uE000/g, (_all, index: string) => holes[Number(index)] ?? "");
}

function clauseIsHinglish(clause: string): boolean {
  if (/[\u0900-\u097F]/.test(clause)) return true;
  return clause.split(/[^A-Za-z]+/).some((word) => HINGLISH_STRONG.has(word.toLowerCase()));
}

function applyHinglishWords(clause: string): string {
  return clause.replace(/[A-Za-z]+/g, (word) => HINGLISH_WORDS[word.toLowerCase()] ?? word);
}

/**
 * What is sent to the speaker. The screen keeps the original text.
 * Roman Hinglish words become Devanagari so Swara does not read them with an
 * English accent. Emails, URLs, code spans, paths, numbers, and unknown names
 * stay as written. A real English clause stays on the English voice.
 */
export function spokenClauses(text: string): Array<{ text: string; lang: string }> {
  const masked = maskSpoken(text);
  const clauses = masked.text.split(/(?<=[।.!?,;])\s+/).filter((part) => part.trim());
  const out: Array<{ text: string; lang: string }> = [];
  for (const clause of clauses.length ? clauses : [masked.text]) {
    const hindi = clauseIsHinglish(clause);
    const spoken = hindi ? applyHinglishWords(clause) : clause;
    const lang = hindi ? "hi-IN" : "en-IN";
    const restored = unmaskSpoken(spoken, masked.holes).trim();
    if (!restored) continue;
    const last = out[out.length - 1];
    if (last && last.lang === lang) last.text = `${last.text} ${restored}`;
    else out.push({ text: restored, lang });
  }
  return out.length ? out : [{ text: text.trim(), lang: "en-IN" }];
}

export type SpeechRoute = {
  engine: string;
  voiceId: string;
  lang: string;
  cloud: boolean;
  note: string;
};

const EMPTY_ROUTE: SpeechRoute = { engine: "", voiceId: "", lang: "", cloud: false, note: "" };
let speechRoute: SpeechRoute = EMPTY_ROUTE;

export function lastSpeechRoute(): SpeechRoute {
  return { ...speechRoute };
}

export function rememberSpeechRoute(route: SpeechRoute) {
  speechRoute = {
    engine: route.engine,
    voiceId: route.voiceId,
    lang: route.lang,
    cloud: route.cloud,
    note: route.note,
  };
}

/** Shown when Windows has no female Indian voice. The chip already on screen. */
export const NO_INDIAN_VOICE =
  "No Indian voice is installed. Windows Settings, Time and language, Speech, Add voices, Hindi (India).";

/**
 * Listening stays as it is for the online default. An offline voice is named.
 * A missing Indian voice replaces the label with the install hint.
 */
export function statusWithVoice(label: string): string {
  const route = lastSpeechRoute();
  if (route.note) return route.note;
  if (route.voiceId && !route.cloud) return `${label} · ${route.voiceId}`;
  return label;
}

/** Female Indian names first. A male or non-Indian voice is not a silent pick. */
export function pickSpokenVoice(
  voices: Array<{ name: string; lang: string }>,
  wanted: string,
): { name: string; note: string } {
  const needle = wanted.trim().toLowerCase();
  const exact = voices.find((voice) => voice.name.toLowerCase() === needle);
  if (exact) return { name: exact.name, note: "" };
  const named = voices.find((voice) => /swara|heera|kalpana|neerja/i.test(voice.name));
  if (named) return { name: named.name, note: "" };
  const partial = voices.find(
    (voice) => needle.length > 8 && voice.name.toLowerCase().includes(needle.slice(0, 18)),
  );
  if (partial && /swara|heera|kalpana|neerja/i.test(partial.name)) {
    return { name: partial.name, note: "" };
  }
  return { name: "", note: NO_INDIAN_VOICE };
}

/**
 * Split a reply into Hindi (Devanagari) and English (Latin) runs so a natural
 * Hinglish sentence is spoken by the matching neural voice per clause instead
 * of forcing the whole line into one locale.
 */
export function splitByLanguage(text: string): Array<{ text: string; lang: string }> {
  const clauses = text.split(/(?<=[।.!?,;])\s+/).filter((part) => part.trim());
  const out: Array<{ text: string; lang: string }> = [];
  for (const clause of clauses.length ? clauses : [text]) {
    const devanagari = (clause.match(/[\u0900-\u097F]/g) ?? []).length;
    const latin = (clause.match(/[A-Za-z]/g) ?? []).length;
    const lang = devanagari > latin ? "hi-IN" : "en-IN";
    const last = out[out.length - 1];
    if (last && last.lang === lang) last.text = `${last.text} ${clause.trim()}`;
    else out.push({ text: clause.trim(), lang });
  }
  return out;
}

let currentAudio: HTMLAudioElement | null = null;
/** Bumped on every stop so a late neural clip from the previous turn cannot play. */
let speechGeneration = 0;
/**
 * Everything that can be waiting on speech to finish: a clip being played, a pause between two clauses. Stopping
 * calls each one, so no promise is left pending behind an interrupt and the next turn can start at once.
 */
const cancelHooks = new Set<() => void>();

/** Run `body` with a hook that ends it early; the hook is removed when `body` settles. */
function cancellable<T>(body: (settle: (value: T) => void) => () => void, onCancel: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    let cleanup: () => void = () => undefined;
    const hook = () => finish(onCancel);
    const finish = (value: T) => {
      if (done) return;
      done = true;
      cancelHooks.delete(hook);
      try {
        cleanup();
      } catch {
        /* nothing left to clean */
      }
      resolve(value);
    };
    cancelHooks.add(hook);
    cleanup = body(finish);
    if (done) cleanup(); // settled while the body was still setting up
  });
}

/** Stop whatever FRIDAY is saying right now (neural playback or SAPI). */
export function stopSpeaking() {
  speechGeneration += 1;
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* not available */
  }
  stopSpeechAudio();
  if (currentAudio) {
    try {
      currentAudio.pause();
    } catch {
      /* already stopped */
    }
    currentAudio = null;
  }
  // Settle every pending playback and pause, and let each give back what it holds.
  for (const hook of [...cancelHooks]) {
    try {
      hook();
    } catch {
      /* one hook failing must not keep the others waiting */
    }
  }
  resetPrefetchedSpeech();
}

/** How many playbacks or pauses are waiting to be cancelled (a stuck count means a leak). */
export const pendingSpeechOperations = (): number => cancelHooks.size;

function playBase64(
  audioBase64: string,
  mime: string,
  volume: number,
  ready?: unknown,
  release?: () => void,
): Promise<void> {
  // A clip that is still arriving comes as an element that is already attached to its stream and paused.
  const audio =
    (ready as HTMLAudioElement | undefined) ?? new Audio(`data:${mime};base64,${audioBase64}`);
  audio.volume = Math.min(Math.max(volume, 0), 1);
  currentAudio = audio;
  // Feed the desktop companion the real speech envelope for lip-sync.
  attachSpeechAudio(audio);
  return cancellable<void>((finish) => {
    audio.onended = () => finish();
    audio.onerror = () => finish();
    void audio.play().catch(() => finish());
    return () => {
      // Whether it ended, failed or was cancelled: detach, stop and give the clip's resources back.
      audio.onended = null;
      audio.onerror = null;
      try {
        audio.pause();
      } catch {
        /* already stopped */
      }
      release?.();
      if (currentAudio === audio) currentAudio = null;
      stopSpeechAudio();
    };
  }, undefined);
}

/** A pause between two clauses that a stop cuts short. */
const pauseSpeech = (ms: number): Promise<void> =>
  cancellable<void>((finish) => {
    const timer = setTimeout(() => finish(), ms);
    return () => clearTimeout(timer);
  }, undefined);

function duckOthers(speaking: boolean) {
  const api = bridge();
  if (!api?.duckAudio) return;
  const enabled = preferences.getSnapshot().voice.duckOthers !== false;
  const on = shouldDuck({ enabled, speaking, quiet: !alertsAudible() });
  void api.duckAudio({ on }).catch(() => undefined);
}

/**
 * Speak with the best available voice: local Supertonic or a selected cloud
 * Neural voice first, then the installed SAPI/browser voices.
 * Returns the source that actually produced sound.
 * Local audio plays through the page audio element so the one capture graph
 * can cancel its echo.
 */
type SpeechTuning = {
  voiceName: string;
  lang: string;
  rate: number;
  pitch: number;
  volume: number;
  kind?: VoiceModel["kind"] | undefined;
  allowCloud?: boolean;
  /** Per-clause expression. Off keeps the owner's settings exactly (the pauses stay). */
  expressive?: boolean;
  /**
   * An owner-chosen cloud speech provider (a Sarvam or Azure female Indian voice). Asked first for each clause;
   * null means "not this time" and the normal ladder takes over.
   */
  cloudClip?: (
    text: string,
    lang: string,
    tone: { rate: number; pitch: number; volume: number },
  ) => Promise<{
    audioBase64: string;
    mime: string;
    engine: string;
    voice?: string;
    /** A paused audio element fed by a stream; played instead of the base64 clip. */
    audio?: unknown;
    /** Gives back the stream, buffers and object URL of `audio` when the clip is dropped or cancelled. */
    release?: () => void;
  } | null>;
};

type SpeechClip = {
  audioBase64: string;
  mime: string;
  route: SpeechRoute;
  audio?: unknown;
  release?: () => void;
};

type SegmentPlan = {
  text: string;
  lang: string;
  cloudVoice: string;
  rate: number;
  pitch: number;
  volume: number;
  pauseAfterMs: number;
  key: string;
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** What each clause of a reply will sound like: its language, its voice and its small expression. */
function planSegments(
  segments: Array<{ text: string; lang: string }>,
  tuning: SpeechTuning,
  allowCloud: boolean,
): SegmentPlan[] {
  return segments.map((segment) => {
    const expression =
      tuning.expressive === false
        ? {
            kind: "plain" as const,
            rate: 1,
            pitch: 1,
            volume: 1,
            pauseAfterMs: pauseAfter(segment.text),
          }
        : expressionFor(segment.text);
    const tone = applyExpression(tuning, expression);
    const cloudVoice = cloudVoiceFor(tuning, segment.lang, allowCloud);
    return {
      text: segment.text,
      lang: segment.lang,
      cloudVoice,
      rate: tone.rate,
      pitch: tone.pitch,
      volume: tone.volume,
      pauseAfterMs: expression.pauseAfterMs,
      key: JSON.stringify([
        segment.text,
        segment.lang,
        cloudVoice,
        round2(tone.rate),
        round2(tone.pitch),
        round2(tone.volume),
        Boolean(tuning.cloudClip),
        preferences.getSnapshot().voice.localVoiceStyle || "",
      ]),
    };
  });
}

/** Make the audio for one clause. Null when no engine could make it. */
async function makeClip(
  plan: SegmentPlan,
  tuning: SpeechTuning,
  api: VoiceBridge | null,
): Promise<SpeechClip | null> {
  if (tuning.cloudClip) {
    const cloud = await tuning
      .cloudClip(plan.text, plan.lang, { rate: plan.rate, pitch: plan.pitch, volume: plan.volume })
      .catch(() => null);
    if (cloud?.audioBase64 || cloud?.audio) {
      return {
        audioBase64: cloud.audioBase64,
        mime: cloud.mime,
        ...(cloud.audio ? { audio: cloud.audio } : {}),
        ...(cloud.release ? { release: cloud.release } : {}),
        route: {
          engine: cloud.engine,
          voiceId: cloud.voice ?? "",
          lang: plan.lang,
          cloud: true,
          note: "",
        },
      };
    }
  }
  if (!api?.speakNeural) return null;
  const result = await api
    .speakNeural({
      text: plan.text,
      voice: plan.cloudVoice,
      rate: plan.rate,
      volume: plan.volume,
      pitch: plan.pitch,
      lang: plan.lang,
      style: preferences.getSnapshot().voice.localVoiceStyle || "",
    })
    .catch(() => null);
  if (!result?.ok || !result.audioBase64) return null;
  return {
    audioBase64: result.audioBase64,
    mime: result.mime ?? "audio/mpeg",
    route: {
      engine: String(result.engine || (plan.cloudVoice ? "edge-tts" : "local")),
      voiceId: String(result.voice || plan.cloudVoice || ""),
      lang: plan.lang,
      cloud: Boolean(result.cloud),
      note: String(result.note || ""),
    },
  };
}

/** Clips being made ahead of time for the next sentence of a reply. Each is used once, then forgotten. */
const clipAhead = new Map<string, Promise<SpeechClip | null>>();
const AHEAD_LIMIT = 12;
const AHEAD_LIFETIME_MS = 60_000;

/** A prepared clip that is dropped unused gives back what it holds (a media stream, an object URL). */
const releaseUnused = (promise: Promise<SpeechClip | null>) =>
  void promise.then((clip) => clip?.release?.()).catch(() => undefined);

function remember(key: string, promise: Promise<SpeechClip | null>) {
  if (clipAhead.size >= AHEAD_LIMIT) {
    const oldest = clipAhead.keys().next().value;
    if (oldest !== undefined) {
      const dropped = clipAhead.get(oldest);
      clipAhead.delete(oldest);
      if (dropped) releaseUnused(dropped);
    }
  }
  clipAhead.set(key, promise);
  setTimeout(() => {
    if (clipAhead.get(key) === promise) {
      clipAhead.delete(key);
      releaseUnused(promise);
    }
  }, AHEAD_LIFETIME_MS);
}

async function clipFor(plan: SegmentPlan, tuning: SpeechTuning, api: VoiceBridge | null) {
  const ready = clipAhead.get(plan.key);
  if (ready) {
    clipAhead.delete(plan.key);
    const clip = await ready;
    if (clip) return clip;
  }
  return makeClip(plan, tuning, api);
}

/**
 * Start making the audio for a sentence that will be spoken next, while the current one is still playing, so the
 * gap between two sentences is the end of one clip and the start of the next, not a fresh synthesis. Uses the same
 * tuning as the later `speakText` call; if that differs, the prepared clips are simply not used.
 */
export function prefetchSpeech(text: string, tuning: SpeechTuning): void {
  const spoken = text.trim();
  const api = bridge();
  if (!spoken || !api?.speakNeural || tuning.kind === "file") return;
  const plans = planSegments(spokenClauses(spoken), tuning, tuning.allowCloud !== false);
  for (const plan of plans.slice(0, 3)) {
    if (!clipAhead.has(plan.key)) remember(plan.key, makeClip(plan, tuning, api));
  }
}

export function resetPrefetchedSpeech(): void {
  for (const promise of clipAhead.values()) releaseUnused(promise);
  clipAhead.clear();
}

/**
 * Speak with the best available voice: an owner-chosen cloud voice, local Supertonic or a selected cloud Neural
 * voice, then the installed SAPI/browser voices. A reply is spoken clause by clause: the next clauses are being
 * made while the current one plays, so the first sound does not wait for the last clause, and each clause carries
 * a little expression (a question rises, an apology softens). Returns the source that actually produced sound.
 * Local audio plays through the page audio element so the one capture graph can cancel its echo.
 */
export async function speakText(
  text: string,
  tuning: SpeechTuning,
  hooks: { onStart?: () => void; onEnd?: () => void } = {},
): Promise<"neural" | "system" | "none"> {
  const spoken = text.trim();
  if (!spoken) return "none";
  const generation = speechGeneration;
  const stale = () => generation !== speechGeneration;
  const api = bridge();
  const playback = {
    onStart: () => {
      duckOthers(true);
      hooks.onStart?.();
    },
    onEnd: () => {
      duckOthers(false);
      hooks.onEnd?.();
    },
  };
  const neuralAllowed = tuning.kind !== "file";
  const allowCloud = tuning.allowCloud !== false;
  const segments = spokenClauses(spoken);
  try {
    if ((api?.speakNeural || tuning.cloudClip) && neuralAllowed) {
      const plans = planSegments(segments, tuning, allowCloud);
      const routes: SpeechRoute[] = [];
      const outcome = await runSpeechPipeline<SegmentPlan, SpeechClip>({
        items: plans,
        synthesize: async (plan) => {
          const clip = await clipFor(plan, tuning, api);
          if (clip) routes.push(clip.route);
          return clip;
        },
        play: (clip, plan) =>
          stale()
            ? Promise.resolve()
            : playBase64(clip.audioBase64, clip.mime, plan.volume, clip.audio, clip.release),
        stale,
        ahead: 2,
        onFirstClip: (clip) => {
          rememberSpeechRoute(clip.route);
          playback.onStart();
        },
        gapAfter: (plan) => plan.pauseAfterMs,
        sleep: pauseSpeech,
        // A clause made for a reply that was interrupted is never played: give its stream back.
        dispose: (clip) => clip.release?.(),
      });
      if (outcome.stale) return "none";
      const last = routes[routes.length - 1];
      if (last) {
        rememberSpeechRoute({ ...last, lang: [...new Set(routes.map((r) => r.lang))].join("+") });
      }
      if (outcome.failedAt === null) {
        playback.onEnd();
        return last?.engine === "sapi" ? "system" : "neural";
      }
      if (outcome.failedAt > 0) {
        // Part of the reply was already spoken: finish the rest with the system voice, once, without a second start.
        const rest = plans
          .slice(outcome.failedAt)
          .map((plan) => plan.text)
          .join(" ");
        const finished = await speakWithSystemVoice(rest, tuning, { onEnd: playback.onEnd }, stale);
        if (!finished && !stale()) playback.onEnd();
        return "neural";
      }
    }
    if (stale()) return "none";
    const heard = segments.map((segment) => segment.text).join(" ");
    const system = await speakWithSystemVoice(heard || spoken, tuning, playback, stale);
    return system ? "system" : "none";
  } finally {
    duckOthers(false);
  }
}

function speakWithSystemVoice(
  spoken: string,
  tuning: { voiceName: string; lang: string; rate: number; pitch: number; volume: number },
  hooks: { onStart?: () => void; onEnd?: () => void },
  stale: () => boolean,
): Promise<boolean> {
  if (typeof window === "undefined" || !window.speechSynthesis) return Promise.resolve(false);
  const synth = window.speechSynthesis;
  const utter = new SpeechSynthesisUtterance(spoken);
  utter.lang = tuning.lang || "hi-IN";
  utter.rate = tuning.rate;
  utter.pitch = tuning.pitch;
  utter.volume = tuning.volume;
  const picked = pickSpokenVoice(
    systemVoices().map((voice) => ({ name: voice.name, lang: voice.lang })),
    tuning.voiceName,
  );
  const match = picked.name
    ? systemVoices().find((voice) => voice.name === picked.name)
    : undefined;
  if (match) utter.voice = match;
  rememberSpeechRoute({
    engine: "speechSynthesis",
    voiceId: match?.name || "",
    lang: tuning.lang || "hi-IN",
    cloud: false,
    note: picked.note,
  });
  return new Promise((resolve) => {
    let settled = false;
    let started = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      stopSpeechAudio();
      if (started && !stale()) hooks.onEnd?.();
      resolve(started && !stale());
    };
    const timer = window.setTimeout(finish, 30_000);
    utter.onstart = () => {
      if (stale()) {
        try {
          synth.cancel();
        } catch {
          /* already stopped */
        }
        return;
      }
      started = true;
      hooks.onStart?.();
    };
    // The system voice exposes no audio stream, so real word boundaries drive
    // the companion's mouth instead of a synthetic envelope.
    utter.onboundary = () => pulseSpeechAudio(0.8);
    utter.onend = () => finish();
    utter.onerror = () => finish();
    if (stale()) {
      settled = true;
      window.clearTimeout(timer);
      resolve(false);
      return;
    }
    synth.speak(utter);
  });
}

/**
 * Hearable form of an answer. Captions keep the full text; speech drops
 * markdown, code and links and stops after a couple of sentences.
 */
export function spokenSummary(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\[\^[^\]]*\]/g, " ")
    .replace(/\[\d+\]/g, " ")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*([-*•]|\d+[.)])\s+/gm, "")
    .replace(/[*_#>|]+/g, " ")
    .replace(/\bSources?:\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return "";
  const sentences = plain.match(/[^.!?।]+[.!?।]?/g) ?? [plain];
  let out = "";
  for (const sentence of sentences) {
    if (out && (out.length + sentence.length > 240 || out.split(/\s+/).length > 45)) break;
    out += sentence;
    if (out.split(/[.!?।]/).filter(Boolean).length >= 2) break;
  }
  return (out || plain).trim().slice(0, 320);
}

/** Resolve the tuning FRIDAY should speak with right now. */
export function activeVoiceSettings() {
  const voice = preferences.getSnapshot().voice;
  const active = (voice.models ?? []).find((m) => m.id === voice.activeId);
  return {
    kind: active?.kind,
    voiceName: active?.voiceName ?? voice.voiceName,
    lang: active?.lang ?? voice.speechLang,
    rate: active?.rate ?? voice.rate,
    pitch: active?.pitch ?? voice.pitch,
    volume: active?.volume ?? voice.volume,
  };
}

/**
 * Speak a sample line. Used by the Voice settings test buttons.
 * Refuses outside Auto mode, same as every other spoken line.
 */
export function speakSample(
  text: string,
  tuning: {
    voiceName: string;
    lang: string;
    rate: number;
    pitch: number;
    volume: number;
    kind?: VoiceModel["kind"] | undefined;
  },
): boolean {
  if (typeof window === "undefined") return false;
  const surface = readVoiceSurface();
  if (!spokenReplyAllowed(surface.mode, surface.muted)) return false;
  stopSpeaking();
  const privacy = preferences.getSnapshot().voice.privacyMode === true;
  void speakText(text, { ...tuning, allowCloud: !privacy });
  return true;
}
