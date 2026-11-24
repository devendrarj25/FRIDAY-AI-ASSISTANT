/**
 * FRIDAY · live words while the owner is still speaking.
 *
 * The local recogniser is not a streaming engine: it reads a finished piece of audio. This turns it into one the way
 * the Whisper streaming work does (ufal/whisper_streaming LocalAgreement-2, WhisperLiveKit's coalescing), adapted:
 *   · every pass reads the rolling audio buffer and returns words with times inside that buffer;
 *   · `LocalAgreementStabilizer` shifts them by the buffer's offset into one clock and commits the longest word
 *     prefix two passes in a row agree on; the rest is shown dim (`unstable`);
 *   · the buffer is trimmed at a committed segment end once it passes about 15 s, from the last committed word at
 *     about 24 s, and never grows beyond about 30 s;
 *   · a pass waits until about half a second of new audio has arrived, never starts while one is running, and waits
 *     one and a half times the last pass when passes are slow;
 *   · a pass still running when speech ends (or the follower stops) is cancelled, so the final reading is not delayed.
 * Nothing here may start an action or reach the Brain: the final transcript, from the normal path, is the only one
 * that does. A reply without timed words (an engine that gives text only) falls back to the plain text agreement.
 * Partial audio never leaves this PC (the request is local-only and provisional). Opt-in (`voice.liveWords`), off by
 * default, because every pass is a real recognition on this PC.
 */
import {
  LocalAgreementStabilizer,
  TranscriptStabilizer,
  type TimedWord,
} from "./transcript-stabilizer";

export type LivePassWord = { text: string; start: number; end: number };

/** What one live pass answers. `words` and `segments` are timed in seconds inside the audio that was sent. */
export type LivePassReply = {
  ok: boolean;
  text?: string;
  words?: LivePassWord[];
  segments?: { start: number; end: number }[];
  language?: string;
  languageProbability?: number | null;
  engine?: string;
  reason?: string;
  cancelled?: boolean;
  unsupportedEngine?: boolean;
};

/** What the follower tells one pass: the language the last confident pass heard ("" = detect) and the utterance id. */
export type LivePassHint = { language: string; utteranceId: string };

export type LiveWordsUpdate = {
  /** Words two passes agreed on (committed; they never change). */
  settled: string;
  /** Everything heard so far: settled, then unstable. */
  shown: string;
  /** The words after the settled ones, still liable to change (show them dim). */
  unstable: string;
  passes: number;
  /** The language the last confident pass heard ("" until one was). */
  language: string;
};

export type LiveWordsDeps = {
  /** The audio spoken since `fromMono` (ms clock), mono at `rate`, newest `maxMs` only. */
  audioSince: (fromMono: number, maxMs: number) => { samples: Float32Array; rate: number };
  /** One recognition of a WAV clip. */
  transcribe: (wav: Uint8Array, hint: LivePassHint) => Promise<LivePassReply>;
  /** Stop the pass of this utterance that is running (a pass in flight is never allowed to delay the final). */
  cancel?: (utteranceId: string) => void;
  encodeWav: (samples: Float32Array, rate: number) => Uint8Array;
  /** True while speech is still being heard. */
  speaking: () => boolean;
  onUpdate: (update: LiveWordsUpdate) => void;
  /** Timed-word mode: the buffer is trimmed and capped here, and words are agreed on by time. */
  timed?: boolean;
  now?: () => number;
  hopMs?: number;
  maxWindowMs?: number;
  minAudioMs?: number;
  maxPasses?: number;
  /** New audio a timed pass needs before it starts (ms). */
  coalesceMs?: number;
};

/** The longest the gap between two passes grows to when passes are slow. */
const MAX_ADAPTIVE_HOP_MS = 6_000;
/** The buffer is cut at a committed segment end once it is longer than this. */
const TRIM_AFTER_MS = 15_000;
/** With no segment end to cut at, it is cut at the last committed word once it is longer than this. */
const FORCE_TRIM_MS = 24_000;
const TIMED_WINDOW_MS = 30_000;
const COALESCE_MS = 500;
/** One pass in this many asks for no locked language, so a switch between Hindi and English is noticed. */
const RELOOK_EVERY = 4;
/** A language heard with at least this probability is kept for the next passes. */
const LANGUAGE_SURE = 0.85;
const TIMED_HOP_MS = 800;
/** A timed utterance may run longer (the buffer is trimmed), so its bound is higher; pacing still caps the duty. */
const TIMED_MAX_PASSES = 40;
const TEXT_HOP_MS = 1200;

let utteranceSeq = 0;

const DEVANAGARI = /[ऀ-ॣॱ-ॿ]/u;
const LATIN = /[A-Za-z]/;

/** A word never holds two scripts: `meetingको` becomes `meeting` and `को`, the time shared by letter count. */
export function splitMixedScript(word: TimedWord): TimedWord[] {
  const runs: { dev: boolean; text: string }[] = [];
  let pending = "";
  for (const ch of word.text) {
    const dev = DEVANAGARI.test(ch);
    if (!dev && !LATIN.test(ch)) {
      const last = runs[runs.length - 1];
      if (last) last.text += ch;
      else pending += ch;
      continue;
    }
    const last = runs[runs.length - 1];
    if (last && last.dev === dev) last.text += ch;
    else runs.push({ dev, text: (runs.length ? "" : pending) + ch });
  }
  if (runs.length < 2) return [word];
  const total = runs.reduce((n, run) => n + run.text.length, 0);
  const span = word.end - word.start;
  let at = word.start;
  return runs.map((run, i) => {
    const end = i === runs.length - 1 ? word.end : at + (span * run.text.length) / total;
    const piece = { text: run.text, start: at, end };
    at = end;
    return piece;
  });
}

const joinWords = (words: TimedWord[]): string => words.map((w) => w.text).join(" ");

export class LiveWords {
  private origin = 0;
  private bufferStart = 0;
  private lastEnd: number | null = null;
  private active = false;
  private busy = false;
  private token = 0;
  private passes = 0;
  private lastPassAt: number | null = null;
  /** How long the last pass took: the next one waits longer when passes are slow, so they never run back to back. */
  private lastPassMs = 0;
  private utteranceId = "";
  private language = "";
  private agree = new LocalAgreementStabilizer();
  private stabilizer = new TranscriptStabilizer({ minActionWords: 9_999 });
  private readonly now: () => number;

  constructor(private readonly deps: LiveWordsDeps) {
    this.now = deps.now ?? (() => performance.now());
  }

  /** Start following an utterance that began at `fromMono`. */
  start(fromMono: number): void {
    this.cancelRunning();
    this.origin = fromMono;
    this.bufferStart = fromMono;
    this.lastEnd = null;
    this.active = true;
    this.busy = false;
    this.token += 1;
    this.passes = 0;
    this.lastPassAt = null;
    this.lastPassMs = 0;
    this.language = "";
    utteranceSeq += 1;
    this.utteranceId = `live-${utteranceSeq}`;
    this.agree = new LocalAgreementStabilizer();
    this.stabilizer = new TranscriptStabilizer({ minActionWords: 9_999 });
  }

  stop(): void {
    this.cancelRunning();
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  private cancelRunning(): void {
    if (this.active && this.busy && this.utteranceId) this.deps.cancel?.(this.utteranceId);
  }

  /** Call often (a timer). Does a pass only when one is due and none is running. */
  async tick(): Promise<void> {
    if (!this.active) return;
    if (!this.deps.speaking()) {
      this.stop(); // speech ended: the normal final reading takes over, undisturbed
      return;
    }
    if (this.busy) return;
    const timed = this.deps.timed === true;
    const hop = this.deps.hopMs ?? (timed ? TIMED_HOP_MS : TEXT_HOP_MS);
    const max = this.deps.maxPasses ?? (timed ? TIMED_MAX_PASSES : 14);
    if (this.passes >= max) return;
    const t = this.now();
    // A pass that takes longer than the hop (a slow engine reading a long window) would otherwise keep the one
    // recogniser busy until the owner stops, and the final reading would queue behind it.
    const wait = Math.max(hop, Math.min(MAX_ADAPTIVE_HOP_MS, Math.round(this.lastPassMs * 1.5)));
    if (this.lastPassAt !== null && t - this.lastPassAt < wait) return;
    const capMs = this.deps.maxWindowMs ?? (timed ? TIMED_WINDOW_MS : 12_000);
    const heard = this.deps.audioSince(this.bufferStart, timed ? 1e9 : capMs);
    const rate = heard.rate;
    let samples = heard.samples;
    let audioMs = (samples.length / rate) * 1000;
    if (timed && audioMs > capMs) {
      // Nothing settled that could be cut at: the oldest audio goes, and the clock moves with it.
      const keep = Math.round((capMs / 1000) * rate);
      this.bufferStart += audioMs - capMs;
      samples = samples.subarray(samples.length - keep);
      audioMs = capMs;
    }
    if (audioMs < (this.deps.minAudioMs ?? 900)) return;
    const audioEnd = this.bufferStart + audioMs;
    if (
      timed &&
      this.lastEnd !== null &&
      audioEnd - this.lastEnd < (this.deps.coalesceMs ?? COALESCE_MS)
    ) {
      return;
    }
    this.busy = true;
    this.lastPassAt = t;
    this.lastEnd = audioEnd;
    const token = this.token;
    const id = this.utteranceId;
    const bufferAt = this.bufferStart;
    const relook = timed && this.passes > 0 && this.passes % RELOOK_EVERY === RELOOK_EVERY - 1;
    try {
      const out = await this.deps.transcribe(this.deps.encodeWav(samples, rate), {
        language: relook ? "" : this.language,
        utteranceId: id,
      });
      this.lastPassMs = Math.max(0, this.now() - t);
      if (!this.active || token !== this.token || !out.ok) return;
      const update =
        timed && Array.isArray(out.words)
          ? this.agreeWords(out, bufferAt, audioMs)
          : this.agreeText(out);
      if (!update) return;
      this.passes += 1;
      this.noteLanguage(out);
      this.deps.onUpdate({ ...update, passes: this.passes, language: this.language });
    } catch {
      // A failed pass is skipped; the normal final reading is unaffected.
    } finally {
      if (token === this.token) this.busy = false;
    }
  }

  private agreeText(
    out: LivePassReply,
  ): Pick<LiveWordsUpdate, "settled" | "shown" | "unstable"> | null {
    const text = (out.text ?? "").trim();
    if (!text) return null;
    const snapshot = this.stabilizer.push(text);
    // Words that settled stay put even when the window later slides past their audio.
    this.stabilizer.commit(snapshot.stable);
    const rest = snapshot.partial.startsWith(snapshot.stable)
      ? snapshot.partial.slice(snapshot.stable.length).trim()
      : "";
    return { settled: snapshot.stable, shown: snapshot.partial, unstable: rest };
  }

  private agreeWords(
    out: LivePassReply,
    bufferAt: number,
    audioMs: number,
  ): Pick<LiveWordsUpdate, "settled" | "shown" | "unstable"> | null {
    const heard = (out.words ?? []).flatMap((w) =>
      Number.isFinite(w.start) && Number.isFinite(w.end) && typeof w.text === "string"
        ? splitMixedScript({ text: w.text, start: w.start, end: w.end })
        : [],
    );
    if (!heard.length) return null;
    const offsetS = (bufferAt - this.origin) / 1000;
    const result = this.agree.push(heard, offsetS);
    this.trim(out, offsetS, audioMs, result.lastCommittedTime);
    const settled = joinWords(result.committed);
    const unstable = joinWords(result.unstable);
    return { settled, unstable, shown: `${settled} ${unstable}`.trim() };
  }

  /** Cut the front of the buffer at settled audio so a long utterance stays cheap to read. */
  private trim(out: LivePassReply, offsetS: number, audioMs: number, committedS: number): void {
    if (audioMs <= TRIM_AFTER_MS || committedS <= offsetS) return;
    const ends = (out.segments ?? [])
      .map((s) => s.end + offsetS)
      .filter((end) => Number.isFinite(end) && end <= committedS && end > offsetS + 0.5);
    let cut = ends.length ? Math.max(...ends) : null;
    if (cut === null && audioMs > FORCE_TRIM_MS) cut = committedS;
    if (cut === null) return;
    const next = this.origin + cut * 1000;
    if (next > this.bufferStart) this.bufferStart = next;
  }

  private noteLanguage(out: LivePassReply): void {
    const code = (out.language ?? "").toLowerCase().slice(0, 2);
    if (code !== "hi" && code !== "en") return;
    const sure =
      typeof out.languageProbability === "number"
        ? out.languageProbability >= LANGUAGE_SURE
        : out.engine === "hindi-ear";
    if (sure) this.language = code;
  }
}

/** The owner's listening choice, read fresh for every pass. */
export type LiveVoiceChoice = { language?: string; speechPref?: string; sttSize?: string };

/** The part of the desktop bridge a live pass uses (the desktop type satisfies it). */
export type LivePassApi = {
  transcribe?: (payload: LivePassRequest) => Promise<LivePassReply | undefined>;
  cancelTranscribe?: (payload: { utteranceId?: string }) => Promise<unknown>;
};

export type LivePassRequest = {
  audioBytes: Uint8Array;
  mime: string;
  language?: string | undefined;
  speechPref?: string;
  model?: string;
  sttSize?: string;
  localOnly: boolean;
  provisional?: boolean;
  livePass?: boolean;
  utteranceId?: string;
};

/**
 * The `transcribe` and `cancel` a `LiveWords` needs, over the desktop bridge. A live pass is a provisional read
 * (never queued behind a final decode, cancellable, never counted as heard) that asks for timed words, local-only.
 * An engine that cannot read speculatively (not the local speech worker) is read the plain way, as before, text only.
 */
export function livePassDeps(
  api: LivePassApi,
  voice: () => LiveVoiceChoice,
): Pick<LiveWordsDeps, "transcribe" | "cancel"> {
  return {
    transcribe: async (wav, hint) => {
      const choice = voice();
      const language = hint.language || choice.language || undefined;
      const base: LivePassRequest = {
        audioBytes: wav,
        mime: "audio/wav",
        ...(language ? { language } : {}),
        ...(choice.speechPref ? { speechPref: choice.speechPref } : {}),
        localOnly: true,
        ...(choice.sttSize && choice.sttSize !== "auto"
          ? { model: choice.sttSize, sttSize: choice.sttSize }
          : {}),
      };
      const out = await api.transcribe?.({
        ...base,
        provisional: true,
        livePass: true,
        utteranceId: hint.utteranceId,
      });
      if (!out) return { ok: false };
      if (out.ok || !out.unsupportedEngine) return out;
      const plain = await api.transcribe?.(base);
      return plain?.ok ? { ok: true, text: plain.text ?? "" } : { ok: false };
    },
    cancel: (utteranceId) => {
      void api.cancelTranscribe?.({ utteranceId });
    },
  };
}
