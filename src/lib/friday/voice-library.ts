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
}

async function playBase64(audioBase64: string, mime: string, volume: number): Promise<void> {
  const audio = new Audio(`data:${mime};base64,${audioBase64}`);
  audio.volume = Math.min(Math.max(volume, 0), 1);
  currentAudio = audio;
  // Feed the desktop companion the real speech envelope for lip-sync.
  attachSpeechAudio(audio);
  await new Promise<void>((resolve) => {
    audio.onended = () => resolve();
    audio.onerror = () => resolve();
    void audio.play().catch(() => resolve());
  });
  if (currentAudio === audio) currentAudio = null;
  stopSpeechAudio();
}

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
export async function speakText(
  text: string,
  tuning: {
    voiceName: string;
    lang: string;
    rate: number;
    pitch: number;
    volume: number;
    kind?: VoiceModel["kind"] | undefined;
    allowCloud?: boolean;
  },
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
    if (api?.speakNeural && neuralAllowed) {
      const clips: Array<{ audioBase64: string; mime: string }> = [];
      const langs: string[] = [];
      let route: SpeechRoute = EMPTY_ROUTE;
      for (const segment of segments) {
        if (stale()) return "none";
        const cloudVoice = cloudVoiceFor(tuning, segment.lang, allowCloud);
        const result = await api.speakNeural({
          text: segment.text,
          voice: cloudVoice,
          rate: tuning.rate,
          volume: tuning.volume,
          pitch: tuning.pitch,
          lang: segment.lang,
        });
        if (!result?.ok || !result.audioBase64) {
          clips.length = 0;
          break;
        }
        langs.push(segment.lang);
        route = {
          engine: String(result.engine || (cloudVoice ? "edge-tts" : "local")),
          voiceId: String(result.voice || cloudVoice || ""),
          lang: langs.join("+"),
          cloud: Boolean(result.cloud),
          note: String(result.note || ""),
        };
        clips.push({ audioBase64: result.audioBase64, mime: result.mime ?? "audio/mpeg" });
      }
      if (clips.length && !stale()) {
        rememberSpeechRoute(route);
        playback.onStart();
        for (const clip of clips) {
          if (stale()) break;
          await playBase64(clip.audioBase64, clip.mime, tuning.volume);
        }
        if (!stale()) playback.onEnd();
        return stale() ? "none" : route.engine === "sapi" ? "system" : "neural";
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
