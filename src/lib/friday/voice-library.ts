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
import {
  estimateWordTimes,
  PlayedTextTracker,
  type PlayedCut,
  type PlayedReply,
  type WordTime,
} from "./voice-engine/played-text";
import { DELIVERY_TAG_WORDS, stripDeliveryTags } from "./voice-engine/delivery-tags";
import { attachSpeechAudio, pulseSpeechAudio, stopSpeechAudio } from "./character/speech-audio";
import {
  bytesToPcm16,
  PcmClipPlayer,
  pcm16ToWavBase64,
  type PcmClip,
  type PcmContext,
} from "./voice-engine/pcm-clip-player";
import { echoLive } from "./voice-engine/echo-live";
import { LOCAL_VOICE_STYLES, preferences, type VoiceModel } from "./preferences";
import { listAudioDevices } from "./voice-audio";
import { routeToSpeaker, type SinkTarget } from "./voice-engine/audio-devices";
import { ttsEnginePlan } from "./voice-engine/voice-choices";
import { models } from "./models-engine";
import { looksSensitive } from "./brain/memory-policy";
import {
  DEFAULT_LOCAL_STYLE,
  ownerPresetStyle,
  profileVoiceStyle,
} from "./voice-engine/friday-voice-profile";
import {
  TTS_INFO,
  TtsFallbackManager,
  type TtsProvider,
  type TtsProviderInfo,
} from "./voice-engine/tts-provider";
import {
  HINDI_LIGHT_ENGINE,
  HINDI_LIGHT_MODEL_ID,
  chooseHindiLightVoice,
  hindiLightFallbackNote,
} from "./tts-ladder";
import { bestVoiceFields, presetFields, type VoicePresetId } from "./voice-presets";
import { alertsAudible } from "./settings-runtime";
import { readVoiceSurface, shouldDuck, spokenReplyAllowed } from "./voice-session";

export type { VoiceModel };

export type NeuralVoice = { id: string; label: string; lang: string };

type VoiceBridge = {
  neuralVoiceStatus?: () => Promise<{
    available: boolean;
    reason?: string;
    version?: string;
    fridayVoice?: unknown;
  }>;
  installNeuralVoice?: () => Promise<{ ok: boolean; error?: string; version?: string }>;
  listNeuralVoices?: () => Promise<{ available: boolean; reason?: string; voices: NeuralVoice[] }>;
  speakNeural?: (payload: {
    text: string;
    voice: string;
    rate: number;
    volume: number;
    pitch: number;
    lang?: string;
    /** The local voice style id (friday, friday-bright, friday-calm, F1 to F5, M1, M2). Ignored by cloud voices. */
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
  /** The same clause as `speakNeural`, from the local voice only, as raw 16-bit mono samples (no file, no WAV). */
  speakNeuralPcm?: (payload: {
    text: string;
    rate: number;
    lang?: string;
    style?: string;
    seq?: number;
    /** `hindi-light` asks for the optional light Hindi voice; left out, the clause is made as it always was. */
    engine?: string;
    /** The utterance this clause belongs to; `cancelNeuralPcm` for the same id drops it (running, queued or late). */
    utt?: string;
    /** True only for FRIDAY's own words in a spoken reply: the voice may act on the delivery tags in `text`. */
    trusted?: boolean;
    /** True for the first clause of a reply: the voice takes the quickest route to its first sound. */
    first?: boolean;
    /** Silence the voice leaves after this clause (milliseconds), so the pause lives in the clip. */
    pauseMs?: number;
  }) => Promise<{
    ok: boolean;
    reason?: string;
    /** True when the utterance was cancelled: no samples, and not a failure of the voice. */
    cancelled?: boolean;
    engine?: string;
    /** Why another engine spoke than the one asked for (`hindi-light-not-installed`, `hindi-light-failed`...). */
    fallback?: string;
    voice?: string;
    sampleRate?: number;
    pcm?: ArrayLike<number> & { length: number };
    /** The voice's own word timings for this clause, when it has them. */
    wordTimes?: ReadonlyArray<{ word?: unknown; startMs?: unknown; endMs?: unknown }>;
    /** The silence the voice really left after the clause (milliseconds); absent when it left none. */
    pausedMs?: number;
  }>;
  /** Drop one utterance in the local voice (barge-in or stop). The worker keeps running. */
  cancelNeuralPcm?: (payload: { utt: string }) => Promise<{ ok: boolean; reason?: string }>;
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
/**
 * Set how FRIDAY's voice is delivered (speed, pitch, volume). The active library voice carries its own copy of the
 * three numbers and wins over the plain preferences when it speaks, so both are written: otherwise a slider moved
 * while a library voice is active would change nothing.
 */
export function setVoiceDelivery(patch: { rate?: number; pitch?: number; volume?: number }) {
  const voice = preferences.getSnapshot().voice;
  preferences.setVoice({ ...patch, voicePreset: "custom" });
  if (voice.activeId) updateVoiceModel(voice.activeId, patch);
}

/** Apply a delivery preset (natural, warm, bright, calm) to the preferences and to the active library voice. */
export function applyVoicePreset(id: VoicePresetId) {
  const fields = presetFields(id);
  preferences.setVoice(fields);
  const voice = preferences.getSnapshot().voice;
  if (voice.activeId) {
    updateVoiceModel(voice.activeId, {
      ...(fields.rate !== undefined ? { rate: fields.rate } : {}),
      ...(fields.pitch !== undefined ? { pitch: fields.pitch } : {}),
      ...(fields.volume !== undefined ? { volume: fields.volume } : {}),
    });
  }
}

/** Reset FRIDAY's voice to the best-known one: Swara and Neerja, the natural preset. The owner's library is kept. */
export function resetToBestVoice() {
  preferences.setVoice({ ...bestVoiceFields(), activeId: "", voiceName: "", speechLang: "hi-IN" });
}

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
  /** The own speech engine, as the worker reports it (read it with `readFridayVoiceStatus`). */
  fridayVoice?: unknown;
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

/**
 * The neural voice for a language. An explicit voice named by the caller (the active library voice) wins when it
 * speaks that language; otherwise the owner's own Hindi or English pick (Settings → Voice → FRIDAY's voice);
 * otherwise Swara for Hindi and Neerja for English.
 */
export function neuralVoiceFor(lang: string, preferred?: string): string {
  const hindi = /^hi/i.test(lang);
  if (preferred && /Neural$/.test(preferred)) {
    const preferredIsHindi = preferred.startsWith("hi-");
    if (preferredIsHindi === hindi) return preferred;
  }
  const own = hindi
    ? preferences.getSnapshot().voice.hindiVoice
    : preferences.getSnapshot().voice.englishVoice;
  if (own && /Neural$/.test(own) && own.startsWith(hindi ? "hi-" : "en-")) return own;
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

/** A delivery tag the assistant wrote (`[warm]`, `[pause:300]`): kept whole through the word steps below. */
const SPOKEN_TAG = new RegExp(
  `\\[(?:${DELIVERY_TAG_WORDS.filter((word) => word !== "pause").join("|")}|pause(?::\\d{1,4})?)\\]`,
  "g",
);

function maskSpoken(text: string): { text: string; holes: string[] } {
  const holes: string[] = [];
  const hide = (span: string) => {
    const token = `\uE000${holes.length}\uE000`;
    holes.push(span);
    return token;
  };
  return { text: text.replace(SPOKEN_PROTECT, hide).replace(SPOKEN_TAG, hide), holes };
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
  // A clause of delivery tags only (`[pause:300]`) has no words to say: it leads the next clause instead.
  let lead = "";
  for (const clause of clauses.length ? clauses : [masked.text]) {
    const hindi = clauseIsHinglish(clause);
    const spoken = hindi ? applyHinglishWords(clause) : clause;
    const lang = hindi ? "hi-IN" : "en-IN";
    const found = unmaskSpoken(spoken, masked.holes).trim();
    if (!found) continue;
    if (!stripDeliveryTags(found).trim()) {
      lead = lead ? `${lead} ${found}` : found;
      continue;
    }
    const restored = lead ? `${lead} ${found}` : found;
    lead = "";
    const last = out[out.length - 1];
    if (last && last.lang === lang) last.text = `${last.text} ${restored}`;
    else out.push({ text: restored, lang });
  }
  const tail = out[out.length - 1];
  if (lead && tail) tail.text = `${tail.text} ${lead}`;
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

/**
 * What was really heard of the reply being spoken. Every clause registers as it starts; `playedReplySnapshot()`
 * answers at any moment (a stop included) with the whole clauses played plus the words of the one in progress.
 */
const playedTracker = new PlayedTextTracker();

/**
 * What was heard of the reply, cut at the last clause boundary by the milliseconds the speaker really played (the
 * sample player's clock minus its output buffer). Null when the last clause did not go through the sample player:
 * then only `playedReplySnapshot()` can say. Changes nothing.
 */
export function playedReplyCut(): PlayedCut | null {
  if (!pcmPlayer || !pcmPlayedLast) return null;
  return playedTracker.heardAtMs(pcmPlayer.playedMs());
}

/**
 * The wall-clock time her scheduled speech ends, from the sample player's own queue, or null when nothing is queued
 * or the last clause did not go through the sample player. Changes nothing.
 */
export function playbackEndsAt(now = Date.now()): number | null {
  if (!pcmPlayer || !pcmPlayedLast) return null;
  try {
    const queued = pcmPlayer.stats().queuedMs;
    return queued > 0 ? now + queued : null;
  } catch {
    return null;
  }
}

/** How far FRIDAY's own voice is lowered while the owner may be talking over her (1 = not lowered). */
let duckLevel = 1;
let currentAudioVolume = 1;

/**
 * Lower her voice at once without stopping it (`on`), or bring it back. The raw-sample player ducks through its gain
 * stage, the audio element through its volume; a system voice cannot be lowered and keeps going unchanged.
 */
export function duckSpeech(on: boolean, level = 0.3): void {
  duckLevel = on ? Math.min(1, Math.max(0, level)) : 1;
  try {
    pcmPlayer?.setDuck(duckLevel);
  } catch {
    /* nothing audible to lower */
  }
  if (currentAudio) {
    try {
      currentAudio.volume = Math.min(1, Math.max(0, currentAudioVolume * duckLevel));
    } catch {
      /* the element is gone */
    }
  }
}

/** A reply of this run is about to be spoken: forget the clauses of an earlier one (`force` also for the same run). */
export function beginPlayedReply(runId: string, force = false): void {
  playedTracker.begin(runId, force);
}

/** The part of the current reply that was heard so far. Changes nothing. */
export function playedReplySnapshot(): PlayedReply {
  return playedTracker.snapshot();
}

/** Stop whatever FRIDAY is saying right now (neural playback or SAPI). */
export function stopSpeaking() {
  // The local voice may still be making a clause of this utterance: tell it to drop the utterance (worker stays up).
  const dead = pcmUttAsked !== "" && pcmUttAsked === utteranceId() ? pcmUttAsked : "";
  speechGeneration += 1;
  if (dead) cancelPcmUtterance(dead);
  // Before anything is paused: the clock and the audio element's position are still the moment of the stop.
  playedTracker.stop();
  // What follows starts at its own loudness, never at a lowered one left from a hold.
  duckSpeech(false);
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* not available */
  }
  stopSpeechAudio();
  // The raw-sample player cannot pause: a stop flushes its queue and every audible source at once.
  try {
    pcmPlayer?.stop();
  } catch {
    /* nothing audible to stop */
  }
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

/* ------------------------------------------------------------- speaker choice */

/** The speaker the owner saved in Settings > Voice; "" is the system default. */
const savedSpeaker = (): string => preferences.getSnapshot().voice.outputDeviceId || "";

let speakerNoteText = "";

/** One line when the saved speaker could not be used and the default plays instead; empty otherwise. */
export const speakerFallbackNote = (): string => (savedSpeaker() ? speakerNoteText : "");

/** Send one playback target (an audio element or the PCM player's context) to the saved speaker. Never throws. */
async function routeSpeaker(target: SinkTarget): Promise<void> {
  try {
    const { outputs } = await listAudioDevices();
    const result = await routeToSpeaker(
      target,
      savedSpeaker(),
      outputs.map((row) => ({ id: row.id, label: row.label })),
    );
    speakerNoteText = result.fellBack ? result.note : "";
  } catch {
    speakerNoteText = "";
  }
}

/**
 * The owner changed the speaker (or plugged one in or out): the speech that is playing and the PCM player move to
 * it now, and what plays next follows. A browser that cannot choose a speaker keeps the default and says so.
 */
export async function applySpeakerChoice(): Promise<void> {
  if (currentAudio) await routeSpeaker(currentAudio as unknown as SinkTarget);
  if (pcmContext) await routeSpeaker(pcmContext as unknown as SinkTarget);
  if (!currentAudio && !pcmContext && savedSpeaker()) {
    const { outputs } = await listAudioDevices();
    const result = await routeToSpeaker(
      {},
      savedSpeaker(),
      outputs.map((row) => ({ id: row.id, label: row.label })),
    );
    speakerNoteText = result.fellBack ? result.note : "";
  }
}

function playBase64(
  audioBase64: string,
  mime: string,
  volume: number,
  ready?: unknown,
  release?: () => void,
  heardText = "",
): Promise<void> {
  // A clip that is still arriving comes as an element that is already attached to its stream and paused.
  const audio =
    (ready as HTMLAudioElement | undefined) ?? new Audio(`data:${mime};base64,${audioBase64}`);
  currentAudioVolume = Math.min(Math.max(volume, 0), 1);
  audio.volume = currentAudioVolume * duckLevel;
  currentAudio = audio;
  // Feed the desktop companion the real speech envelope for lip-sync.
  attachSpeechAudio(audio);
  // The element's own position says how much of the clause was heard when a stop comes.
  const heard = heardText
    ? playedTracker.startClip(heardText, 0, () => ({
        elapsedMs: (Number(audio.currentTime) || 0) * 1000,
        ...(Number.isFinite(audio.duration) && audio.duration > 0
          ? { durMs: audio.duration * 1000 }
          : {}),
      }))
    : null;
  return cancellable<void>((finish) => {
    audio.onended = () => {
      heard?.end();
      finish();
    };
    audio.onerror = () => {
      heard?.drop();
      finish();
    };
    const failed = () => {
      heard?.drop();
      finish();
    };
    // A saved speaker is set before the first sample; with none saved the clip plays at once, as it always did.
    if (savedSpeaker())
      void routeSpeaker(audio)
        .then(() => audio.play())
        .catch(failed);
    else void audio.play().catch(failed);
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

/**
 * Raw-sample playback (setting `voice.pcmPlayback`, local voice only). The player is made on first use; the first
 * failure of any kind turns it off for the rest of the session and says why (`pcmPlaybackNote`), and speech goes on
 * through the page audio element, so a PCM problem never costs the owner a sentence.
 */
let pcmPlayer: PcmClipPlayer | null = null;
let pcmContext: PcmContext | null = null;
let pcmOffReason = "";
let pcmSeq = 0;
/** Tags one page load, so an utterance id of an older page can never match this one's. */
const PAGE_TAG = Math.random().toString(36).slice(2, 8) || "p";
/** The utterance id the local voice was last asked to make a clause for ("" when none this session). */
let pcmUttAsked = "";

/** The id of the utterance being spoken now: one per speech generation (a stop starts a new one). */
const utteranceId = (): string => `${PAGE_TAG}-${speechGeneration}`;

function cancelPcmUtterance(utt: string): void {
  try {
    void Promise.resolve(bridge()?.cancelNeuralPcm?.({ utt })).catch(() => undefined);
  } catch {
    /* no bridge, or it threw: the stale clause is dropped by the playback generation anyway */
  }
}
let pcmPlayedLast = false;

const audioContextCtor = (): (new () => unknown) | null => {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    AudioContext?: new () => unknown;
    webkitAudioContext?: new () => unknown;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
};

function pcmFailed(reason: string) {
  if (!pcmOffReason) pcmOffReason = reason.replace(/\s+/g, " ").trim().slice(0, 160) || "unknown";
}

/** Why raw-sample playback is off for this session, as one line; empty while it works or the setting is off. */
export function pcmPlaybackNote(): string {
  const voice = preferences.getSnapshot().voice;
  if ((voice.pcmPlayback !== true && voice.hindiLightVoice !== true) || !pcmOffReason) return "";
  return `PCM playback is off for this session (${pcmOffReason}); speech plays through the audio element.`;
}

/** True when the last clause played through the raw-sample player. */
export const lastClipUsedPcm = (): boolean => pcmPlayedLast;

/** Forget the player and the session decision (a new session, or a test). */
export function resetPcmPlayback(): void {
  try {
    echoLive.detach();
  } catch {
    /* nothing to forget */
  }
  try {
    pcmPlayer?.dispose();
  } catch {
    /* nothing audible */
  }
  pcmPlayer = null;
  pcmContext = null;
  pcmOffReason = "";
  pcmSeq = 0;
  pcmUttAsked = "";
  pcmPlayedLast = false;
}

/**
 * How much scheduled speech the speaker still has, and whether it is close to running dry (an answer is open and the
 * backlog is below the floor). Null while nothing was played through the sample player. The driver of a streamed reply
 * hands over a shorter next clause when `underrunRisk` is true; the audio is never stretched to fill the gap.
 */
export function playbackPressure(): { backlogMs: number; underrunRisk: boolean } | null {
  if (!pcmPlayer) return null;
  return { backlogMs: pcmPlayer.backlogMs(), underrunRisk: pcmPlayer.underrunRisk };
}

function getPcmPlayer(): PcmClipPlayer {
  if (pcmPlayer) return pcmPlayer;
  const Ctor = audioContextCtor();
  if (!Ctor) throw new Error("no AudioContext");
  const context = new Ctor() as PcmContext;
  pcmContext = context;
  if (savedSpeaker()) void routeSpeaker(context as unknown as SinkTarget);
  const created = new PcmClipPlayer(context, {
    // Clauses of one answer join with a short equal-power overlap and the answer fades in and out: no clicks.
    join: true,
    onLevel: (rms) => {
      // The measured loudness of the samples that are playing drives the companion's mouth.
      try {
        if (rms > 0) pulseSpeechAudio(Math.min(1, Math.pow(rms * 3.4, 0.72)));
        else stopSpeechAudio();
      } catch {
        /* the companion is not on screen */
      }
    },
  });
  pcmPlayer = created;
  // The raw-sample path is the only one with a tap on what the speaker plays. With `voice.echoReference` on, the
  // microphone frames are cleaned against it; with it off this listens and keeps nothing. The page audio element
  // path has no tap: the browser's own echo cancellation is all that helps there.
  echoLive.attach(created);
  return created;
}

/**
 * The one sample player of the page, for a short line made in advance (the instant acknowledgement). It sounds through
 * the same context and the same echo reference tap as the reply, so the microphone is cleaned against it too. Null
 * when this window has no audio context.
 */
export function sharedPcmPlayer(): PcmClipPlayer | null {
  try {
    return getPcmPlayer();
  } catch {
    return null;
  }
}

/**
 * The light Hindi voice (setting `voice.hindiLightVoice`). The Models page is the source of what is installed; the
 * probe is replaceable so a test can answer without a models store. One line says when a clause asked for it and
 * another voice spoke (or it is switched on but not downloaded): `hindiLightNote`, never silent.
 */
let hindiLightProbe: (() => boolean | null) | null = null;
let hindiLightSaid = "";

export function setHindiLightInstalledProbe(probe: (() => boolean | null) | null): void {
  hindiLightProbe = probe;
}

function hindiLightInstalled(): boolean | null {
  if (hindiLightProbe) return hindiLightProbe();
  try {
    const state = models.getSnapshot();
    if (state.installed[HINDI_LIGHT_MODEL_ID]) return true;
    return state.lastScanAt ? false : null;
  } catch {
    return null;
  }
}

/** Why the light Hindi voice did not speak a line of this session, as one line; empty while it works or is off. */
export function hindiLightNote(): string {
  return preferences.getSnapshot().voice.hindiLightVoice === true ? hindiLightSaid : "";
}

/** The clause as raw samples is wanted: the setting is on, the engine is the local voice, and nothing failed yet. */
function pcmWanted(plan: SegmentPlan, tuning: SpeechTuning, api: VoiceBridge | null): boolean {
  return (
    (preferences.getSnapshot().voice.pcmPlayback === true || plan.engine === HINDI_LIGHT_ENGINE) &&
    !pcmOffReason &&
    tuning.kind === "neural" &&
    plan.cloudVoice === "" &&
    typeof api?.speakNeuralPcm === "function" &&
    audioContextCtor() !== null
  );
}

/** The voice's own word timings, or null when it gave none or they are not usable (the words are then timed by weight). */
function engineWordTimes(raw: unknown): WordTime[] | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  const out: WordTime[] = [];
  for (const item of raw as Array<{ word?: unknown; startMs?: unknown; endMs?: unknown }>) {
    const startMs = Number(item?.startMs);
    const endMs = Number(item?.endMs);
    if (typeof item?.word !== "string" || !item.word) return null;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
    out.push({ word: item.word, startMs, endMs });
  }
  return out;
}

/** One clause as raw samples from the local voice; null (and a recorded reason) when it could not be made. */
async function makePcmClip(plan: SegmentPlan, api: VoiceBridge): Promise<SpeechClip | null> {
  pcmSeq += 1;
  const utt = utteranceId();
  pcmUttAsked = utt;
  const result = await Promise.resolve(
    api.speakNeuralPcm?.({
      // The light Hindi voice never gets a tag: it would reject the clause as not speakable.
      text: plan.engine ? plan.plain : plan.text,
      rate: plan.rate,
      lang: plan.lang,
      style: localStyle(),
      seq: pcmSeq,
      utt,
      ...(plan.engine ? { engine: plan.engine } : {}),
      // The tags travel only with FRIDAY's own words, and never to the light Hindi voice (it has no use for them).
      ...(plan.trusted && !plan.engine ? { trusted: true } : {}),
      ...(plan.first ? { first: true } : {}),
      ...(plan.pauseMs > 0 ? { pauseMs: plan.pauseMs } : {}),
    }),
  ).catch((error: unknown) => ({
    ok: false,
    reason: String((error as Error)?.message || error),
  }));
  const rate = Number((result as { sampleRate?: number } | undefined)?.sampleRate) || 0;
  const bytes = (result as { pcm?: ArrayLike<number> & { length: number } } | undefined)?.pcm;
  if (!result?.ok || !bytes || !(rate > 0)) {
    // A cancelled utterance is the stop doing its job, not a fault: no samples, and PCM playback stays on.
    if (
      (result as { cancelled?: boolean } | undefined)?.cancelled === true ||
      (result as { reason?: string } | undefined)?.reason === "cancelled"
    ) {
      return null;
    }
    const reason = String((result as { reason?: string } | undefined)?.reason || "no samples");
    // Nothing to say is not a failure of the player.
    if (!/^nothing to speak|empty-text/i.test(reason)) pcmFailed(`synthesis: ${reason}`);
    return null;
  }
  const samples = bytesToPcm16(bytes);
  if (!samples.length) {
    pcmFailed("synthesis: the voice returned no samples");
    return null;
  }
  const info = result as { engine?: string; voice?: string; fallback?: string };
  const engineTimes = engineWordTimes((result as { wordTimes?: unknown }).wordTimes);
  const paddedMs = Math.max(
    0,
    Math.min(plan.pauseMs, Number((result as { pausedMs?: unknown }).pausedMs) || 0),
  );
  if (plan.engine) hindiLightSaid = hindiLightFallbackNote(info);
  return {
    audioBase64: "",
    mime: "audio/wav",
    pcm: {
      samples,
      rate,
      ...(engineTimes ? { wordTimes: engineTimes } : {}),
      ...(paddedMs > 0 ? { paddedMs } : {}),
    },
    route: {
      engine: String(info.engine || "supertonic-3"),
      voiceId: String(info.voice || ""),
      lang: plan.lang,
      cloud: false,
      note: "",
    },
  };
}

/**
 * Play a raw-sample clip through the gapless scheduler. If the player cannot start (no audio context, a refused
 * clip) this clause is played from the same samples through the audio element, and PCM playback stays off.
 */
async function playPcmClip(
  clip: SpeechClip,
  volume: number,
  stale: () => boolean,
  heardText = "",
  options: { gapMs?: number; early?: boolean } = {},
): Promise<void> {
  const pcm = clip.pcm;
  if (!pcm) return;
  let playing: PcmClip;
  let endsInMs = 0;
  try {
    const player = getPcmPlayer();
    await player.ready();
    if (stale()) return;
    // The pause before this clause is silence in the scheduler: it is never crossfaded into the clause before.
    const gapMs = Math.max(0, Math.round(options.gapMs ?? 0));
    playing = player.start(pcm.samples, pcm.rate, volume, gapMs > 0 ? { gapMs } : {});
    endsInMs = player.backlogMs();
  } catch (error) {
    pcmFailed(`playback: ${String((error as Error)?.message || error)}`);
    pcmPlayedLast = false;
    if (stale()) return;
    return playBase64(
      pcm16ToWavBase64(pcm.samples, pcm.rate),
      "audio/wav",
      volume,
      undefined,
      undefined,
      heardText,
    );
  }
  pcmPlayedLast = true;
  // The audio clock of the sample player says how much of the clause has been played.
  // The voice's own word times when it gave them; otherwise the words are timed by weight over the speech itself
  // (the pause the voice left after the clause is not speech).
  const speechMs = Math.max(0, playing.durationMs - (pcm.paddedMs ?? 0));
  const heard = heardText
    ? playedTracker.startClip(
        heardText,
        playing.durationMs,
        () => ({ elapsedMs: playing.playedMs(), durMs: playing.durationMs }),
        undefined,
        playing.span,
        pcm.wordTimes ?? estimateWordTimes(heardText, speechMs),
      )
    : null;
  return cancellable<void>((finish) => {
    let natural = false;
    let handedOver = false;
    let lead: ReturnType<typeof setTimeout> | null = null;
    void playing.ended.then(() => {
      natural = true;
      if (!stale()) heard?.end();
      finish();
    });
    // With another clause waiting, hand over just before this one ends so the next is scheduled while this tail is
    // still queued: the two join with an overlap, not a gap. The last clause is awaited to its real end.
    if (options.early) {
      lead = setTimeout(
        () => {
          handedOver = true;
          finish();
        },
        Math.max(0, endsInMs - PCM_HANDOVER_LEAD_MS),
      );
    }
    return () => {
      if (lead !== null) clearTimeout(lead);
      // A stop or a newer reply: cut the queue and every audible source. A clip that ended by itself, or was handed
      // over to the next one, is left alone (a stop flushes the queue anyway).
      if (!natural && !handedOver) playing.stop();
    };
  }, undefined);
}

/** How long before the end of a clause the next one is handed to the scheduler (longer than the join overlap). */
const PCM_HANDOVER_LEAD_MS = 160;

function playWavClip(clip: SpeechClip, volume: number, heardText = ""): Promise<void> {
  pcmPlayedLast = false;
  return playBase64(clip.audioBase64, clip.mime, volume, clip.audio, clip.release, heardText);
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

/** A pinned engine (Settings > Voice) takes the owner's cloud clip maker out of the line: nothing online is asked. */
function pinnedEngine(tuning: SpeechTuning, pick: { cloud: boolean }): SpeechTuning {
  if (pick.cloud || !tuning.cloudClip) return tuning;
  const { cloudClip: _dropped, ...rest } = tuning;
  void _dropped;
  return rest;
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
   * The text is FRIDAY's own words in a spoken reply, so its delivery tags (`[warm]`, `[pause:300]`) may shape the
   * voice. Absent or false: every tag is removed before anything is made, whatever the text says.
   */
  deliveryTags?: boolean;
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
  /** Raw samples from the local voice (setting `voice.pcmPlayback`); played by the scheduler, not the audio element. */
  pcm?: {
    samples: Int16Array;
    rate: number;
    /** The voice's own word timings, when it has them. */
    wordTimes?: readonly WordTime[];
    /** Milliseconds of silence the voice left at the end of the clip. */
    paddedMs?: number;
  };
};

type SegmentPlan = {
  /** What the voice is asked to say. Holds delivery tags only for FRIDAY's own words (`trusted`). */
  text: string;
  /** The same words with every delivery tag removed: what is heard, shown, sent to a cloud voice or checked. */
  plain: string;
  /** `text` carries delivery tags the voice may act on. */
  trusted: boolean;
  /** The first clause of a reply: the voice takes the quickest route to its first sound. */
  first: boolean;
  /** Silence left after this clause inside the clip (0 for the last clause). */
  pauseMs: number;
  lang: string;
  cloudVoice: string;
  rate: number;
  pitch: number;
  volume: number;
  pauseAfterMs: number;
  /** `hindi-light` when this clause asks the local voice op for the light Hindi voice; otherwise empty. */
  engine: string;
  key: string;
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** What each clause of a reply will sound like: its language, its voice and its small expression. */
function planSegments(
  segments: Array<{ text: string; lang: string }>,
  tuning: SpeechTuning,
  allowCloud: boolean,
  firstClause = false,
): SegmentPlan[] {
  return segments.map((clause, index) => {
    // Only FRIDAY's own words keep their tags; a tag in anything else is text to remove, never a cue.
    const plain = stripDeliveryTags(clause.text);
    const trusted = tuning.deliveryTags === true && plain !== clause.text;
    const segment = { text: plain, lang: clause.lang };
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
    const light = chooseHindiLightVoice({
      enabled: preferences.getSnapshot().voice.hindiLightVoice === true,
      installed: hindiLightInstalled(),
      local: tuning.kind === "neural" && cloudVoice === "",
      lang: segment.lang,
      text: segment.text,
    });
    if (light.note) hindiLightSaid = light.note;
    return {
      text: trusted ? clause.text : plain,
      plain,
      trusted,
      first: firstClause && index === 0,
      pauseMs: index < segments.length - 1 ? expression.pauseAfterMs : 0,
      lang: segment.lang,
      cloudVoice,
      rate: tone.rate,
      pitch: tone.pitch,
      volume: tone.volume,
      pauseAfterMs: expression.pauseAfterMs,
      engine: light.use ? HINDI_LIGHT_ENGINE : "",
      key: JSON.stringify([
        trusted ? clause.text : plain,
        segment.lang,
        cloudVoice,
        round2(tone.rate),
        round2(tone.pitch),
        round2(tone.volume),
        Boolean(tuning.cloudClip),
        localStyle(),
        ...(light.use ? [HINDI_LIGHT_ENGINE] : []),
      ]),
    };
  });
}

/**
 * The style the local voice is asked for: an explicit preset the owner picked, else the profile's own style, else
 * FRIDAY's own voice ("friday"). A preview (`speakSample` with a style) overrides it for that one sample only.
 */
function localStyle(): string {
  if (previewStyle) return previewStyle;
  const voice = preferences.getSnapshot().voice;
  return ownerPresetStyle(voice) || profileVoiceStyle(voice, "supertonic") || DEFAULT_LOCAL_STYLE;
}

/** The local voice style a clause would be spoken with right now (the warm-up uses the same one). */
export function activeLocalStyle(): string {
  return localStyle();
}

/** The style a Settings preview asks for, set only while that one sample is made. */
let previewStyle = "";

/** A previewed style id as the engine gets it: a listed id ("" is the FRIDAY voice), or "" for no override. */
export function previewStyleToken(asked: unknown): string {
  if (typeof asked !== "string") return "";
  const known = (LOCAL_VOICE_STYLES as readonly string[]).includes(asked);
  return known ? asked || DEFAULT_LOCAL_STYLE : "";
}

/** The cloud voice the owner picked, for one clause; null when it gave nothing. */
async function cloudClipOf(plan: SegmentPlan, tuning: SpeechTuning): Promise<SpeechClip | null> {
  if (!tuning.cloudClip) return null;
  const cloud = await tuning
    .cloudClip(plan.plain, plan.lang, { rate: plan.rate, pitch: plan.pitch, volume: plan.volume })
    .catch(() => null);
  if (!cloud?.audioBase64 && !cloud?.audio) return null;
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

/** The voice op of this PC for one clause: raw samples first when wanted, then a WAV (or the online voice's file). */
async function localClipOf(
  plan: SegmentPlan,
  tuning: SpeechTuning,
  api: VoiceBridge | null,
): Promise<SpeechClip | null> {
  if (api && pcmWanted(plan, tuning, api)) {
    const utterance = utteranceId();
    const raw = await makePcmClip(plan, api);
    if (raw) return raw;
    // Stopped meanwhile: a stale clause is not made again as a WAV.
    if (utterance !== utteranceId()) return null;
    // The clause is made again below, as a WAV, by the path that always worked.
  }
  if (!api?.speakNeural) return null;
  const result = await api
    .speakNeural({
      text: plan.plain,
      voice: plan.cloudVoice,
      rate: plan.rate,
      volume: plan.volume,
      pitch: plan.pitch,
      lang: plan.lang,
      style: localStyle(),
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

/** One clip maker as a voice of the single text-to-speech interface; it yields the clip as one chunk. */
function clipVoice(info: TtsProviderInfo, make: () => Promise<SpeechClip | null>): TtsProvider {
  return {
    ...info,
    health: () => ({ state: "ready" }),
    cancel: () => undefined,
    async *speak(_text, options) {
      const clip = await make();
      if (clip)
        yield { generation: options.generation, seq: 0, engine: clip.route.engine, payload: clip };
    },
  };
}

const CLOUD_CLIP_INFO: TtsProviderInfo = {
  id: "cloud-clip",
  label: "the cloud voice",
  kind: "cloud",
  languages: ["*"],
  cost: "free-quota",
  privacy: "cloud",
  viaRouter: true,
};

/**
 * Make the audio for one clause. Null when no engine could make it. The voices are the ones this path always
 * used, in the same order (the cloud voice the owner picked, then this PC's voice op); the fallback manager runs
 * them, keeps the privacy and sensitive-line rules in front of any cloud voice, tries at most two, and says which
 * one really spoke and why a better one did not.
 */
async function makeClip(
  plan: SegmentPlan,
  tuning: SpeechTuning,
  api: VoiceBridge | null,
): Promise<SpeechClip | null> {
  const localId = plan.cloudVoice
    ? "edge"
    : plan.engine === HINDI_LIGHT_ENGINE
      ? HINDI_LIGHT_ENGINE
      : "supertonic";
  const order: string[] = [];
  const voices: TtsProvider[] = [];
  if (tuning.cloudClip) {
    order.push(CLOUD_CLIP_INFO.id);
    voices.push(clipVoice(CLOUD_CLIP_INFO, () => cloudClipOf(plan, tuning)));
  }
  order.push(localId);
  voices.push(clipVoice(TTS_INFO[localId], () => localClipOf(plan, tuning, api)));
  const out = await new TtsFallbackManager(voices, { maxAttempts: 2 }).speakOrdered(
    { text: plan.plain, lang: plan.lang },
    {
      online: true,
      allowCloud: true,
      privacyMode: preferences.getSnapshot().voice.privacyMode === true,
      sensitive: looksSensitive(plan.plain),
      billingAllowsPaid: false,
    },
    order,
    { generation: speechGeneration },
  );
  const clip = out.ok ? (out.chunks[0]?.payload as SpeechClip | undefined) : undefined;
  if (!clip) return null;
  return out.note && out.attempts.length > 1
    ? {
        ...clip,
        route: { ...clip.route, note: [clip.route.note, out.note].filter(Boolean).join(" ") },
      }
    : clip;
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
  const pick = ttsEnginePlan(preferences.getSnapshot().voice.ttsEngine);
  if (!spoken || !api?.speakNeural || tuning.kind === "file" || !pick.neural) return;
  tuning = pinnedEngine(tuning, pick);
  const plans = planSegments(
    spokenClauses(spoken),
    tuning,
    tuning.allowCloud !== false && pick.cloud,
  );
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
  hooks: {
    onStart?: () => void;
    onEnd?: () => void;
    onFirstAudio?: () => void;
    /** This is the first clause of a reply: its voice takes the quickest route to the first sound. */
    first?: boolean;
  } = {},
): Promise<"neural" | "system" | "none"> {
  const spoken = text.trim();
  if (!spoken) return "none";
  const generation = speechGeneration;
  const stale = () => generation !== speechGeneration;
  const closeGroup = playedTracker.openGroup();
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
  const pick = ttsEnginePlan(preferences.getSnapshot().voice.ttsEngine);
  tuning = pinnedEngine(tuning, pick);
  const neuralAllowed = tuning.kind !== "file" && pick.neural;
  const allowCloud = tuning.allowCloud !== false && pick.cloud;
  const segments = spokenClauses(spoken);
  try {
    if ((api?.speakNeural || tuning.cloudClip) && neuralAllowed) {
      const plans = planSegments(segments, tuning, allowCloud, hooks.first === true);
      const routes: SpeechRoute[] = [];
      // A clause played from raw samples leaves its pause to the scheduler (silence before the next clause, never
      // crossfaded); the clause after a sample clip that was not is held back by `pauseSpeech` below.
      const gapOwed = new Map<number, number>();
      const viaPcm = new Set<number>();
      const outcome = await runSpeechPipeline<SegmentPlan, SpeechClip>({
        items: plans,
        synthesize: async (plan) => {
          const clip = await clipFor(plan, tuning, api);
          if (clip) routes.push(clip.route);
          return clip;
        },
        play: async (clip, plan, index) => {
          if (stale()) return;
          const owed = gapOwed.get(index) ?? 0;
          if (clip.pcm) {
            viaPcm.add(index);
            const more = index < plans.length - 1;
            // What the voice already left in the clip is not asked of the scheduler a second time.
            if (more)
              gapOwed.set(index + 1, Math.max(0, plan.pauseAfterMs - (clip.pcm.paddedMs ?? 0)));
            return playPcmClip(clip, plan.volume, stale, plan.plain, {
              gapMs: owed,
              early: more,
            });
          }
          if (owed > 0) await pauseSpeech(owed);
          if (stale()) return;
          return playWavClip(clip, plan.volume, plan.plain);
        },
        stale,
        ahead: 2,
        onFirstClip: (clip) => {
          rememberSpeechRoute(clip.route);
          // The first audio of this reply has been received from the engine: stamped before it is played.
          hooks.onFirstAudio?.();
          playback.onStart();
        },
        gapAfter: (plan, index) => (viaPcm.has(index) ? 0 : plan.pauseAfterMs),
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
          .map((plan) => plan.plain)
          .join(" ");
        const finished = await speakWithSystemVoice(rest, tuning, { onEnd: playback.onEnd }, stale);
        if (!finished && !stale()) playback.onEnd();
        return "neural";
      }
    }
    if (stale()) return "none";
    const heard = segments.map((segment) => stripDeliveryTags(segment.text)).join(" ");
    const system = await speakWithSystemVoice(heard || spoken, tuning, playback, stale);
    return system ? "system" : "none";
  } finally {
    closeGroup();
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
    // The system voice reports the character it is saying; that position says how much was heard at a stop.
    let atChar = 0;
    let heard: { end: () => void; drop: () => void } | null = null;
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
      heard = playedTracker.startClip(spoken, 0, () => ({
        elapsedMs: atChar,
        durMs: spoken.length,
      }));
      hooks.onStart?.();
    };
    // The system voice exposes no audio stream, so real word boundaries drive
    // the companion's mouth instead of a synthetic envelope.
    utter.onboundary = (event) => {
      atChar = Math.max(atChar, Number(event?.charIndex) || 0);
      pulseSpeechAudio(0.8);
    };
    utter.onend = () => {
      heard?.end();
      finish();
    };
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
    /** Hear one local voice style without saving it (a Settings preview). Only a listed style id is used. */
    previewStyle?: string;
  },
): boolean {
  if (typeof window === "undefined") return false;
  const surface = readVoiceSurface();
  if (!spokenReplyAllowed(surface.mode, surface.muted)) return false;
  stopSpeaking();
  const privacy = preferences.getSnapshot().voice.privacyMode === true;
  const { previewStyle: asked, ...rest } = tuning;
  const token = previewStyleToken(asked);
  previewStyle = token;
  const done = speakText(text, { ...rest, allowCloud: !privacy });
  void Promise.resolve(done).finally(() => {
    if (previewStyle === token) previewStyle = "";
  });
  return true;
}
