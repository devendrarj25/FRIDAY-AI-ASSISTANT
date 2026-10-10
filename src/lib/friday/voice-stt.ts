/**
 * FRIDAY · desktop speech-to-text (renderer side)
 *
 * The browser's Web Speech API needs Chromium's online service, drops long
 * sessions and is unavailable in some packaged builds. When FRIDAY runs on the
 * desktop she transcribes on-device instead: this module records real audio,
 * segments it into utterances with the shared VAD, and sends each utterance to
 * the Electron main process (faster-whisper) for transcription.
 *
 * It degrades honestly: if the desktop engine is not installed, `available()`
 * returns false and the caller keeps using Web Speech.
 */
import { desktopApi as desktop } from "./desktop";
import { preferences } from "./preferences";
import { biasPrompt } from "./speech-parse";
import { voiceGate } from "./voice-audio";
import type { WakeProbe } from "./wake-engine";

export interface SttStatus {
  available: boolean;
  ready?: boolean;
  engine: string;
  model?: string | undefined;
  reason?: string | null | undefined;
  dependency?: "ready" | "missing";
  worker?: "ready" | "stopped" | "crashed";
  inference?: "verified" | "unverified" | "failed";
  loadCount?: number;
}

const OFFLINE: SttStatus = {
  available: false,
  engine: "browser",
  reason: "the desktop transcriber is only available in the FRIDAY app",
};

/**
 * Whisper's `language=` *locks* decoding to one language. Hindi/English
 * regional prefs (hi-IN, en-IN) must stay auto-detect so Hinglish is not
 * forced into one script. Other ISO codes still lock when the owner set them.
 */
export function whisperLanguageArg(pref?: string | null): string {
  const raw = String(pref || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (!raw || raw === "auto" || raw === "mixed") return "";
  if (/^(hi|en)(-|$)/.test(raw)) return "";
  const iso = raw.slice(0, 2);
  return /^[a-z]{2}$/.test(iso) ? iso : "";
}

/** Bias faster-whisper toward mixed speech without rewriting technical terms. */
export function sttInitialPrompt(opts?: {
  preference?: string;
  topic?: string;
  vocab?: readonly string[];
}): string {
  const bits = [
    "Hinglish: mixed Hindi and English in one utterance.",
    "Preserve filenames, paths, code identifiers, application names, project names, commands, FRIDAY, and technical terms.",
    "Do not translate or replace those with similar everyday words.",
  ];
  const pref = String(opts?.preference || "").trim();
  if (/^hi/i.test(pref)) bits.push("The speaker often uses Hindi and Indian English.");
  else if (/^en/i.test(pref)) bits.push("The speaker often uses Indian English mixed with Hindi.");
  const topic = String(opts?.topic || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  if (topic) bits.push(`Current work: ${topic}.`);
  const names = biasPrompt(opts?.vocab || []);
  if (names) bits.push(names);
  return bits.join(" ");
}

let cached: { at: number; value: SttStatus } | null = null;
let cachedLocal: { at: number; value: SttStatus } | null = null;

/** Is on-device transcription usable right now? Cached for a minute.
 *  Pass `warm` only when starting Auto Mode / dictation so the worker loads
 *  once — UI polls must not force a model load.
 */
export async function sttStatus(
  force = false,
  localOnly = false,
  warm = false,
): Promise<SttStatus> {
  const entry = localOnly ? cachedLocal : cached;
  if (entry && !force && !warm && Date.now() - entry.at < 60_000) return entry.value;
  const api = desktop();
  if (!api?.sttStatus) {
    const value = OFFLINE;
    if (localOnly) cachedLocal = { at: Date.now(), value };
    else cached = { at: Date.now(), value };
    return value;
  }
  try {
    const raw = (await api.sttStatus(force, localOnly, warm)) as SttStatus;
    const value: SttStatus = {
      available: Boolean(raw?.available),
      engine: raw?.engine || "faster-whisper",
      reason: raw?.reason ?? null,
    };
    if (typeof raw?.ready === "boolean") value.ready = raw.ready;
    else value.ready = Boolean(raw?.available);
    if (raw?.model) value.model = raw.model;
    if (raw?.dependency === "ready" || raw?.dependency === "missing")
      value.dependency = raw.dependency;
    if (raw?.worker === "ready" || raw?.worker === "stopped" || raw?.worker === "crashed") {
      value.worker = raw.worker;
    }
    if (
      raw?.inference === "verified" ||
      raw?.inference === "unverified" ||
      raw?.inference === "failed"
    ) {
      value.inference = raw.inference;
    }
    if (typeof raw?.loadCount === "number") value.loadCount = raw.loadCount;
    if (localOnly) cachedLocal = { at: Date.now(), value };
    else cached = { at: Date.now(), value };
    return value;
  } catch (error) {
    const value = { ...OFFLINE, reason: String((error as Error)?.message || error) };
    if (localOnly) cachedLocal = { at: Date.now(), value };
    else cached = { at: Date.now(), value };
    return value;
  }
}

/** Install the on-device transcriber (pip install faster-whisper). */
export async function installStt(): Promise<{ ok: boolean; error?: string }> {
  const api = desktop();
  if (!api?.installStt) return { ok: false, error: "not running inside the FRIDAY desktop app" };
  cached = null;
  cachedLocal = null;
  try {
    return (await api.installStt()) as { ok: boolean; error?: string };
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message || error) };
  }
}

function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const type of [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ]) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {
      /* older runtimes throw instead of returning false */
    }
  }
  return "";
}

const toBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

export interface DictationOptions {
  language?: string;
  deviceId?: string | null;
  /** Require faster-whisper; never use a network transcription provider. */
  localOnly?: boolean;
  /** Silence after speech that ends an utterance. */
  silenceMs?: number | (() => number);
  /** Optional faster-whisper initial_prompt (Hinglish + session topic). */
  initialPrompt?: string | (() => string);
  /** Hard cap so one long monologue still gets transcribed. */
  maxUtteranceMs?: number;
  /**
   * A finished transcript. `meta.wake` carries the openWakeWord verdict when
   * the low-latency engine really ran, so the caller knows which detector
   * answered instead of assuming the transcript regex.
   */
  onFinal: (text: string, meta?: { wake?: WakeProbe | null; ms?: number }) => void;
  /**
   * Optional low-latency wake scoring, run on the RAW audio before whisper.
   * Returning null means the engine is unavailable → transcript fallback.
   */
  wakeProbe?: (payload: { audioBase64: string; mime: string }) => Promise<WakeProbe | null>;
  /** Fired once per utterance when an in-flight wake probe matches. */
  onEarlyWake?: (wake: WakeProbe) => void;
  onSpeechStart?: () => void;
  onError?: (message: string) => void;
  onStateChange?: (state: "listening" | "thinking" | "idle") => void;
  /**
   * Every observable step of the capture → transcribe pipeline, so a silent
   * Auto Mode can be diagnosed from the UI instead of guessed at.
   */
  onDiagnostic?: (event: {
    stage: "speech" | "segment" | "dropped" | "transcribing" | "transcript" | "wake" | "error";
    detail: string;
    ms?: number;
    bytes?: number;
  }) => void;
}

/**
 * Continuous on-device dictation. One microphone stream, one MediaRecorder,
 * one transcription at a time — no timers left running when it stops.
 */
/**
 * One microphone lease for dictation. Auto Mode is the only caller. Chat does
 * not open a microphone. A stale or dead holder is reclaimed; a live holder
 * is told why a second start was refused. voiceGate remains the single capture.
 */
export type DictationHolder = { active: boolean; stop?: () => void };

export type DictationClaim =
  | { ok: true; token: string; reclaimed: boolean }
  | { ok: false; reason: "own-second-capture" | "in-app-session"; detail: string };

export const DICTATION_LEASE_TTL_MS = 20_000;
const DICTATION_START_GRACE_MS = 15_000;

type DictationLease = {
  token: string;
  holder: DictationHolder;
  expiresAt: number;
  claimedAt: number;
  phase: "starting" | "live";
};

let dictationLease: DictationLease | null = null;
let dictationSeq = 0;

function dictationStale(now: number): boolean {
  if (!dictationLease) return false;
  if (now >= dictationLease.expiresAt) return true;
  if (dictationLease.phase === "live" && !dictationLease.holder.active) return true;
  if (
    dictationLease.phase === "starting" &&
    !dictationLease.holder.active &&
    now >= dictationLease.claimedAt + DICTATION_START_GRACE_MS
  ) {
    return true;
  }
  return false;
}

export function claimDictation(holder: DictationHolder, now: number): DictationClaim {
  if (dictationLease && dictationLease.holder === holder && !dictationStale(now)) {
    return {
      ok: false,
      reason: "own-second-capture",
      detail: "this capture already holds the microphone",
    };
  }
  if (dictationLease && dictationLease.holder !== holder && !dictationStale(now)) {
    return {
      ok: false,
      reason: "in-app-session",
      detail: "voice input is already active elsewhere",
    };
  }
  let reclaimed = false;
  if (dictationLease && dictationStale(now)) {
    const dying = dictationLease;
    dictationLease = null;
    try {
      dying.holder.stop?.();
    } catch {
      /* a dead holder must not block the next start */
    }
    reclaimed = true;
  }
  dictationSeq += 1;
  const token = `dict-${dictationSeq}`;
  dictationLease = {
    token,
    holder,
    expiresAt: now + DICTATION_LEASE_TTL_MS,
    claimedAt: now,
    phase: "starting",
  };
  return { ok: true, token, reclaimed };
}

export function heartbeatDictation(token: string, now: number): boolean {
  if (!dictationLease || dictationLease.token !== token) return false;
  dictationLease.expiresAt = now + DICTATION_LEASE_TTL_MS;
  return true;
}

export function markDictationLive(token: string, now: number): boolean {
  if (!dictationLease || dictationLease.token !== token) return false;
  dictationLease.phase = "live";
  dictationLease.expiresAt = now + DICTATION_LEASE_TTL_MS;
  return true;
}

export function releaseDictation(token: string): void {
  if (dictationLease?.token === token) dictationLease = null;
}

export function resetDictationLease(): void {
  dictationLease = null;
  dictationSeq = 0;
}

/** Skip the turn-score process after the file is known to be missing. */
let turnScoreReady: "unknown" | "absent" | "ready" = "unknown";

export class DesktopDictation {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private timer: number | null = null;
  private startedAt = 0;
  private speaking = false;
  private running = false;
  private busy = false;
  /** Utterances captured while whisper was busy, transcribed in order. */
  private queue: Array<{ blob: Blob; wake: WakeProbe | null }> = [];
  /** In-utterance wake score (once); reused at send if it already matched. */
  private earlyWake: WakeProbe | null = null;
  private earlyWakeTried = false;
  private earlyWakeGen = 0;
  /** idle → scoring once → extend (probability under 0.5) or done. */
  private turnHold: "idle" | "scoring" | "extend" | "done" = "idle";

  private unsubscribe: (() => void) | null = null;
  private leaseToken = "";
  private heartbeatTimer: number | null = null;
  private readonly onPageHide = () => this.stop();

  constructor(private readonly options: DictationOptions) {}

  get active(): boolean {
    return this.running;
  }

  async start(): Promise<boolean> {
    if (this.running) return true;
    const claim = claimDictation(this, Date.now());
    if (!claim.ok) {
      this.options.onError?.(claim.detail);
      return false;
    }
    this.leaseToken = claim.token;
    if (typeof MediaRecorder === "undefined" || !navigator?.mediaDevices?.getUserMedia) {
      this.releaseLease();
      this.options.onError?.("audio capture is unavailable in this runtime");
      return false;
    }
    // Open the microphone in the click's user-activation window BEFORE any
    // IPC. `sttStatus` used to run first; after that await Chromium treats
    // AudioContext as suspended, VAD reads silence, and the dock still shows
    // listening with no transcripts.
    const opened = await voiceGate.acquire("dictation", this.options.deviceId ?? undefined);
    this.stream = voiceGate.micStream();
    if (!opened || !this.stream) {
      voiceGate.release("dictation");
      this.stream = null;
      this.releaseLease();
      const captured = voiceGate.lastCaptureFailure();
      this.options.onError?.(captured?.reason || "the microphone could not be opened");
      return false;
    }
    const state = await sttStatus(true, Boolean(this.options.localOnly), true);
    const fasterOk =
      state.engine === "faster-whisper" &&
      state.available &&
      state.ready !== false &&
      state.inference !== "failed";
    const cloudOk =
      !this.options.localOnly &&
      Boolean(state.available) &&
      String(state.engine || "").startsWith("cloud:") &&
      state.ready !== false;
    if (this.options.localOnly ? !fasterOk : !(fasterOk || cloudOk)) {
      voiceGate.release("dictation");
      this.stream = null;
      this.releaseLease();
      this.options.onError?.(state.reason || "speech recognition is not verified yet");
      return false;
    }
    this.running = true;
    markDictationLive(this.leaseToken, Date.now());
    this.armLease();
    this.options.onStateChange?.("listening");
    this.unsubscribe = voiceGate.subscribe((snapshot) => {
      if (!this.running) return;
      if (snapshot.speech && !this.speaking) {
        this.options.onDiagnostic?.({ stage: "speech", detail: "speech detected" });
        // THE deadlock that made Auto Mode go permanently deaf: `speaking` used
        // to be latched true even when the recorder could not start (a
        // transcription still in flight, a MediaRecorder constructor throw).
        // Nothing ever cleared it, so `speech && !speaking` never fired again
        // and every later utterance was silently ignored. `speaking` is now
        // only latched when a segment really started recording.
        this.speaking = this.beginSegment();
        if (this.speaking) this.options.onSpeechStart?.();
      }
      if (this.speaking) this.evaluateSegment(snapshot.speech);
    });

    return true;
  }

  stop() {
    this.running = false;
    this.speaking = false;
    this.releaseLease();
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) window.clearInterval(this.timer);
    this.timer = null;
    try {
      if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    } catch {
      /* already stopped */
    }
    this.recorder = null;
    this.chunks = [];
    this.queue = [];
    this.earlyWake = null;
    this.earlyWakeTried = false;
    this.earlyWakeGen += 1;
    // Hand the shared stream back instead of stopping tracks other consumers
    // (barge-in, level meters, wake word) may still be using.
    this.stream = null;
    voiceGate.release("dictation");
    this.options.onStateChange?.("idle");
  }

  private releaseLease() {
    if (this.heartbeatTimer != null && typeof window !== "undefined") {
      window.clearInterval(this.heartbeatTimer);
    }
    this.heartbeatTimer = null;
    if (typeof window !== "undefined") window.removeEventListener("pagehide", this.onPageHide);
    if (this.leaseToken) releaseDictation(this.leaseToken);
    this.leaseToken = "";
  }

  private armLease() {
    if (typeof window === "undefined") return;
    window.addEventListener("pagehide", this.onPageHide);
    this.heartbeatTimer = window.setInterval(() => {
      if (this.leaseToken) heartbeatDictation(this.leaseToken, Date.now());
    }, 5_000);
  }

  /** @returns true only when a segment is really recording now. */
  private beginSegment(): boolean {
    if (this.recorder) return true;
    if (!this.stream) {
      this.options.onDiagnostic?.({ stage: "dropped", detail: "no microphone stream" });
      return false;
    }
    // A transcription still in flight no longer blocks capture: recording is
    // independent of whisper, so the next utterance is recorded now and queued
    // (see `enqueue`) instead of being thrown away while FRIDAY is thinking.

    const mime = pickMime();
    try {
      this.recorder = mime
        ? new MediaRecorder(this.stream, { mimeType: mime })
        : new MediaRecorder(this.stream);
    } catch (error) {
      this.recorder = null;
      this.options.onError?.(String((error as Error)?.message || error));
      this.options.onDiagnostic?.({ stage: "error", detail: "MediaRecorder refused the stream" });
      return false;
    }
    this.chunks = [];
    this.turnHold = "idle";
    this.startedAt = Date.now();
    this.earlyWake = null;
    this.earlyWakeTried = false;
    this.earlyWakeGen += 1;
    this.recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) this.chunks.push(event.data);
      this.maybeEarlyWake();
    };
    this.recorder.onerror = () => {
      this.recorder = null;
      this.speaking = false;
      this.options.onDiagnostic?.({ stage: "error", detail: "recorder error — segment abandoned" });
    };
    this.recorder.onstop = () => {
      const chunkCount = this.chunks.length;
      const blob = new Blob(this.chunks, { type: this.chunks[0]?.type || mime || "audio/webm" });
      this.chunks = [];
      this.recorder = null;
      this.options.onDiagnostic?.({
        stage: "segment",
        detail: `utterance captured · ${chunkCount} chunks`,
        ms: Date.now() - this.startedAt,
        bytes: blob.size,
      });
      this.enqueue(blob, this.earlyWake);
    };
    this.recorder.start(250);
    return true;
  }

  /** End the utterance after enough trailing silence, or at the hard cap. */
  private evaluateSegment(speech: boolean) {
    const maxMs = this.options.maxUtteranceMs ?? 20_000;
    if (this.timer) return;
    this.timer = window.setInterval(() => {
      if (!this.running || !this.recorder) {
        if (this.timer) window.clearInterval(this.timer);
        this.timer = null;
        return;
      }
      const snapshot = voiceGate.getSnapshot();
      const quietFor = snapshot.sinceSpeech ?? 0;
      const tooLong = Date.now() - this.startedAt > maxMs;
      const silenceMs = this.silenceBudget();
      const cap = Math.min(1600, silenceMs >= 1000 ? silenceMs : silenceMs + 780);
      if (this.turnHold === "scoring" && quietFor < cap && !tooLong) return;
      if (
        !snapshot.speech &&
        this.turnHold === "idle" &&
        quietFor >= silenceMs &&
        quietFor < cap &&
        !tooLong
      ) {
        this.turnHold = "scoring";
        void this.requestTurnScore();
        return;
      }
      const budget = this.turnHold === "extend" ? cap : silenceMs;
      if ((!snapshot.speech && quietFor >= budget) || tooLong) {
        if (this.timer) window.clearInterval(this.timer);
        this.timer = null;
        this.speaking = false;
        try {
          if (this.recorder.state !== "inactive") this.recorder.stop();
        } catch {
          /* already stopped */
        }
      }
    }, 80);
    void speech;
  }

  private async requestTurnScore(): Promise<void> {
    const api = desktop();
    if (!api?.scoreTurn || !this.chunks.length || turnScoreReady === "absent") {
      this.turnHold = "done";
      return;
    }
    try {
      const blob = new Blob(this.chunks, { type: this.chunks[0]?.type || "audio/webm" });
      const audioBase64 = toBase64(await blob.arrayBuffer());
      const scored = await api.scoreTurn({ audioBase64, mime: blob.type });
      if (scored?.ready) turnScoreReady = "ready";
      else if (/absent/.test(scored?.reason || "")) turnScoreReady = "absent";
      const probability = scored?.probability;
      this.turnHold = typeof probability === "number" && probability < 0.5 ? "extend" : "done";
    } catch {
      this.turnHold = "done";
    }
  }

  private silenceBudget(): number {
    const value = this.options.silenceMs;
    const ms = typeof value === "function" ? value() : value;
    return typeof ms === "number" && ms > 0 ? ms : 650;
  }

  /**
   * Score the in-progress utterance once (~700ms of speech) with the existing
   * wake engine. This is still one captured window, not a second microphone
   * loop — a true always-on frame scorer would need a persistent Python
   * process and is not introduced here.
   */
  private maybeEarlyWake() {
    if (this.earlyWakeTried || !this.options.wakeProbe || !this.running) return;
    if (Date.now() - this.startedAt < 700) return;
    if (this.chunks.length < 2) return;
    this.earlyWakeTried = true;
    const gen = this.earlyWakeGen;
    void this.runEarlyWake(gen);
  }

  private async runEarlyWake(gen: number) {
    if (!this.options.wakeProbe) return;
    const mime = this.chunks[0]?.type || "audio/webm";
    const blob = new Blob(this.chunks.slice(), { type: mime });
    if (blob.size < 2500) return;
    try {
      const audioBase64 = toBase64(await blob.arrayBuffer());
      if (!this.running || gen !== this.earlyWakeGen) return;
      const wake = await this.options.wakeProbe({ audioBase64, mime });
      if (!this.running || gen !== this.earlyWakeGen) return;
      this.earlyWake = wake;
      if (wake?.detected) {
        this.options.onDiagnostic?.({
          stage: "wake",
          detail: `early ${wake.detail}`,
        });
        this.options.onEarlyWake?.(wake);
      }
    } catch {
      /* final send() still probes the finished utterance */
    }
  }

  /**
   * Never lose speech while whisper is busy. Utterances are queued and
   * transcribed in order; only a genuine backlog (more than three waiting)
   * drops the OLDEST one, and even that is reported.
   */
  private enqueue(blob: Blob, wake: WakeProbe | null = null) {
    this.queue.push({ blob, wake });
    if (this.busy)
      this.options.onDiagnostic?.({
        stage: "segment",
        detail: "queued — still transcribing the previous utterance",
        bytes: blob.size,
      });
    while (this.queue.length > 3) {
      const dropped = this.queue.shift();
      this.options.onDiagnostic?.({
        stage: "dropped",
        detail: "transcription backlog — oldest utterance discarded",
        bytes: dropped?.blob.size ?? 0,
      });
    }
    void this.pump();
  }

  /** Drain the queue one utterance at a time (whisper is single-flight). */
  private async pump(): Promise<void> {
    if (this.busy) return;
    while (this.queue.length) {
      const next = this.queue.shift();
      if (!next) break;
      await this.send(next.blob, next.wake);
    }
  }

  private async send(blob: Blob, early: WakeProbe | null = null) {
    const api = desktop();
    if (!api?.transcribe) {
      this.speaking = false;
      this.options.onError?.("the desktop transcriber bridge is unavailable");
      this.options.onDiagnostic?.({ stage: "error", detail: "no transcribe bridge" });
      return;
    }
    if (blob.size < 2000) {
      // Too short to hold speech — but never silently: a mic that captures
      // nothing looks exactly like this, and the owner deserves to see it.
      this.speaking = false;
      this.options.onDiagnostic?.({
        stage: "dropped",
        detail: "utterance too short to transcribe",
        bytes: blob.size,
      });
      return;
    }
    this.busy = true;
    const startedAt = Date.now();
    try {
      const audioBase64 = toBase64(await blob.arrayBuffer());
      // Low-latency wake scoring FIRST: openWakeWord answers in milliseconds
      // from the raw audio, so FRIDAY knows whether she was called before the
      // (much slower) transcription even starts. Reuse an in-utterance match
      // instead of scoring the same clip twice.
      let wake: WakeProbe | null = early;
      if (!wake?.detected && this.options.wakeProbe) {
        wake = await this.options.wakeProbe({ audioBase64, mime: blob.type });
        if (wake)
          this.options.onDiagnostic?.({
            stage: "wake",
            detail: wake.detail,
            ms: Date.now() - startedAt,
          });
      } else if (wake?.detected) {
        this.options.onDiagnostic?.({
          stage: "wake",
          detail: `reused early ${wake.detail}`,
          ms: Date.now() - startedAt,
        });
      }
      this.options.onStateChange?.("thinking");
      this.options.onDiagnostic?.({
        stage: "transcribing",
        detail: "sent to faster-whisper",
        bytes: blob.size,
      });
      const language = whisperLanguageArg(this.options.language) || undefined;
      const promptOpt = this.options.initialPrompt;
      const initialPrompt =
        typeof promptOpt === "function"
          ? promptOpt()
          : (promptOpt ?? sttInitialPrompt({ preference: this.options.language ?? "" }));
      const sttSize = preferences.getSnapshot().voice.sttSize;
      const result = (await api.transcribe({
        audioBase64,
        mime: blob.type,
        language,
        ...(this.options.language ? { speechPref: this.options.language } : {}),
        ...(sttSize && sttSize !== "auto" ? { model: sttSize, sttSize } : {}),
        localOnly: Boolean(this.options.localOnly),
        ...(initialPrompt ? { initialPrompt } : {}),
      })) as {
        ok: boolean;
        text?: string;
        error?: string;
        language?: string;
        noSpeechProb?: number;
      };
      if (result?.ok) {
        const text = (result.text || "").trim();
        const noSpeech = result.noSpeechProb;
        this.options.onDiagnostic?.({
          stage: "transcript",
          detail: text || "(empty transcript)",
          ms: Date.now() - startedAt,
        });
        if (typeof noSpeech === "number" && noSpeech >= 0.65) {
          this.options.onDiagnostic?.({
            stage: "dropped",
            detail: `no-speech probability ${noSpeech.toFixed(2)} — not sent to the brain`,
            ms: Date.now() - startedAt,
          });
        } else if (text) {
          this.options.onFinal(text, { wake, ms: Date.now() - startedAt });
        } else {
          this.options.onDiagnostic?.({
            stage: "dropped",
            detail: "empty transcript",
            ms: Date.now() - startedAt,
          });
        }
      } else if (result?.error) {
        this.options.onError?.(result.error);
        this.options.onDiagnostic?.({ stage: "error", detail: result.error });
      }
    } catch (error) {
      const message = String((error as Error)?.message || error);
      this.options.onError?.(message);
      this.options.onDiagnostic?.({ stage: "error", detail: message });
    } finally {
      this.busy = false;
      // The segment is over — never leave capture latched. A recorder that is
      // already running belongs to the NEXT utterance, so its latch stands.
      if (!this.recorder) this.speaking = false;
      if (this.running) this.options.onStateChange?.("listening");
    }
  }
}
