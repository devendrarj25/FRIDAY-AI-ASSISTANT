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
  try {
    if (api?.speakNeural && neuralAllowed) {
      const segments = splitByLanguage(spoken);
      const clips: Array<{ audioBase64: string; mime: string }> = [];
      for (const segment of segments) {
        if (stale()) return "none";
        const cloudVoice =
          tuning.kind === "neural" && /Neural$/i.test(tuning.voiceName)
            ? neuralVoiceFor(segment.lang, tuning.voiceName)
            : "";
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
        clips.push({ audioBase64: result.audioBase64, mime: result.mime ?? "audio/mpeg" });
      }
      if (clips.length && !stale()) {
        playback.onStart();
        for (const clip of clips) {
          if (stale()) break;
          await playBase64(clip.audioBase64, clip.mime, tuning.volume);
        }
        if (!stale()) playback.onEnd();
        return stale() ? "none" : "neural";
      }
    }
    if (stale()) return "none";
    const system = await speakWithSystemVoice(spoken, tuning, playback, stale);
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
  const wanted = tuning.voiceName.trim().toLowerCase();
  const match =
    systemVoices().find((v) => v.name.toLowerCase() === wanted) ||
    systemVoices().find((v) => wanted && v.name.toLowerCase().includes(wanted.slice(0, 18)));
  if (match) utter.voice = match;
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
  void speakText(text, tuning);
  return true;
}
