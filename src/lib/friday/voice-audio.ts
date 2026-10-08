/**
 * FRIDAY · real audio input layer.
 *
 * Everything the voice pipeline needs to know about the machine's actual audio
 * hardware, plus a real (signal based) voice-activity detector. Nothing here
 * guesses: microphone state comes from `enumerateDevices` + a live
 * `getUserMedia` track, and speech detection comes from the audio signal via an
 * AnalyserNode with an adaptive noise floor.
 *
 * There is exactly one gate instance for the whole app (`voiceGate`) so the
 * microphone is opened once and shared by every consumer. Capture stays in
 * this renderer graph. A second kernel capture path is not added.
 */

import { captureMayRetry } from "./voice-session";
import { classifyMicHold, relaxedCapture } from "./mic-truth";

/** Process names from the existing meeting watch. Empty off Windows. */
let namedHolders: string[] = [];

export function noteMicHolders(names: readonly string[]): void {
  namedHolders = names
    .map((name) => String(name || "").trim())
    .filter(Boolean)
    .slice(0, 80);
}

export type MicState =
  | "available"
  | "permission-required"
  | "permission-denied"
  | "no-microphone"
  | "device-offline"
  | "device-error";

export interface AudioDeviceInfo {
  id: string;
  label: string;
  kind: "audioinput" | "audiooutput";
  isDefault: boolean;
}

export interface MicStatus {
  state: MicState;
  /** True only when a live audio track was actually obtained. */
  available: boolean;
  deviceId: string | null;
  deviceLabel: string | null;
  channels: number | null;
  sampleRate: number | null;
  inputs: AudioDeviceInfo[];
  outputs: AudioDeviceInfo[];
  reason: string | null;
}

export const EMPTY_MIC_STATUS: MicStatus = {
  state: "no-microphone",
  available: false,
  deviceId: null,
  deviceLabel: null,
  channels: null,
  sampleRate: null,
  inputs: [],
  outputs: [],
  reason: null,
};

const media = () => (typeof navigator !== "undefined" ? (navigator.mediaDevices ?? null) : null);

function classify(
  err: unknown,
  ownTracks = 0,
  holders: string[] = [],
): { state: MicState; reason: string } {
  const e = err as { name?: string; message?: string } | undefined;
  const name = e?.name ?? "";
  const message = e?.message ?? String(err ?? "unknown error");
  const hold = classifyMicHold({
    name,
    ownTracks,
    holders,
    exclusiveHint: name === "NotReadableError" || name === "TrackStartError",
  });
  if (hold.cause === "permission") return { state: "permission-denied", reason: hold.reason };
  if (hold.cause === "no-device") return { state: "no-microphone", reason: hold.reason };
  if (hold.cause === "own-capture" || hold.cause === "other-app" || hold.cause === "exclusive") {
    return { state: "device-offline", reason: `${hold.reason} ${hold.next}` };
  }
  if (!name) return { state: "device-error", reason: message };
  return { state: "device-error", reason: hold.reason || message };
}

/** Real device list. Labels only appear once permission has been granted. */
export async function listAudioDevices(): Promise<{
  inputs: AudioDeviceInfo[];
  outputs: AudioDeviceInfo[];
}> {
  const md = media();
  if (!md?.enumerateDevices) return { inputs: [], outputs: [] };
  let devices: MediaDeviceInfo[] = [];
  try {
    devices = await md.enumerateDevices();
  } catch {
    return { inputs: [], outputs: [] };
  }
  const map = (kind: "audioinput" | "audiooutput") =>
    devices
      .filter((d) => d.kind === kind)
      .map((d, index) => ({
        id: d.deviceId,
        label:
          d.label || (kind === "audioinput" ? `Microphone ${index + 1}` : `Speaker ${index + 1}`),
        kind,
        isDefault: d.deviceId === "default" || (index === 0 && d.deviceId !== "communications"),
      }));
  return { inputs: map("audioinput"), outputs: map("audiooutput") };
}

/**
 * The honest microphone answer. Tries the preferred device, then falls back to
 * the Windows default input before reporting anything as unavailable.
 */
export async function probeMicrophone(
  preferredId?: string | null,
  existing?: MediaStream | null,
): Promise<MicStatus> {
  const live = existing?.getAudioTracks().find((track) => track.readyState === "live");
  if (live && existing) {
    const listed = await listAudioDevices();
    return finish(
      { ok: true, track: live, stream: existing, state: "available", reason: null },
      listed,
      false,
    );
  }
  const md = media();
  if (!md?.getUserMedia) {
    return {
      ...EMPTY_MIC_STATUS,
      state: "device-error",
      reason: "audio capture is unavailable in this runtime",
    };
  }

  const { inputs, outputs } = await listAudioDevices();
  if (!inputs.length) {
    // No device *and* no labels can also mean permission was never granted, so
    // still attempt a capture before declaring "no microphone".
    const attempted = await tryCapture(md, undefined);
    if (attempted.ok) return finish(attempted, await listAudioDevices());
    if (attempted.state === "permission-denied" || attempted.state === "permission-required")
      return {
        ...EMPTY_MIC_STATUS,
        inputs,
        outputs,
        state: attempted.state,
        reason: attempted.reason,
      };
    return {
      ...EMPTY_MIC_STATUS,
      inputs,
      outputs,
      state: "no-microphone",
      reason: attempted.reason,
    };
  }

  const order = [preferredId, "default", inputs[0]?.id].filter(
    (id, i, arr): id is string => Boolean(id) && arr.indexOf(id) === i,
  );
  let last: Awaited<ReturnType<typeof tryCapture>> | null = null;
  for (const id of order) {
    const attempt = await tryCapture(md, id);
    if (attempt.ok) return finish(attempt, { inputs, outputs });
    last = attempt;
    if (attempt.state === "permission-denied") break;
  }
  return {
    ...EMPTY_MIC_STATUS,
    inputs,
    outputs,
    state: last?.state ?? "device-error",
    reason: last?.reason ?? "the microphone could not be opened",
  };
}

type CaptureAttempt =
  | { ok: true; track: MediaStreamTrack; stream: MediaStream; state: MicState; reason: null }
  | { ok: false; state: MicState; reason: string };

async function tryCapture(md: MediaDevices, deviceId?: string): Promise<CaptureAttempt> {
  let last: unknown = null;
  for (let step = 0; step < 3; step += 1) {
    const plan = relaxedCapture(step, deviceId);
    if (!plan) break;
    try {
      const stream = await md.getUserMedia({ audio: plan.audio });
      const track = stream.getAudioTracks()[0];
      if (!track) {
        stream.getTracks().forEach((t) => t.stop());
        return { ok: false, state: "device-error", reason: "the device produced no audio track" };
      }
      return { ok: true, track, stream, state: "available", reason: null };
    } catch (err) {
      last = err;
      const name = (err as { name?: string }).name ?? "";
      if (
        name !== "NotReadableError" &&
        name !== "TrackStartError" &&
        name !== "OverconstrainedError"
      ) {
        break;
      }
    }
  }
  return { ok: false, ...classify(last, ownLiveTracks(), namedHolders) };
}

function ownLiveTracks(): number {
  const stream = voiceGate.micStream();
  return stream?.getAudioTracks().filter((track) => track.readyState === "live").length ?? 0;
}

function finish(
  attempt: Extract<CaptureAttempt, { ok: true }>,
  devices: { inputs: AudioDeviceInfo[]; outputs: AudioDeviceInfo[] },
  stop = true,
): MicStatus {
  const settings = attempt.track.getSettings?.() ?? {};
  const status: MicStatus = {
    state: "available",
    available: true,
    deviceId: settings.deviceId ?? null,
    deviceLabel: attempt.track.label || devices.inputs[0]?.label || "Default microphone",
    channels: (settings as { channelCount?: number }).channelCount ?? null,
    sampleRate: (settings as { sampleRate?: number }).sampleRate ?? null,
    inputs: devices.inputs,
    outputs: devices.outputs,
    reason: null,
  };
  if (stop) attempt.stream.getTracks().forEach((t) => t.stop());
  return status;
}

/**
 * Windows-friendly capture constraints. Echo cancellation, noise suppression
 * and AGC are handled by the platform audio stack — this is what keeps fans,
 * keyboards and FRIDAY's own speaker output out of the recogniser.
 */
export function audioConstraints(deviceId?: string): MediaTrackConstraints {
  return {
    ...(deviceId && deviceId !== "default" ? { deviceId: { exact: deviceId } } : {}),
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  };
}

/* ----------------------------------------------------------------- the VAD */

export interface VadSnapshot {
  /** Live input level, 0..1 (RMS). */
  level: number;
  /** Adaptive noise floor learned from the room, 0..1. */
  noiseFloor: number;
  /** True while the signal is convincingly above the room noise. */
  speech: boolean;
  /** ms since the last frame classified as speech, or null if never. */
  sinceSpeech: number | null;
  running: boolean;
  /** True while TTS is playing — VAD uses a higher bar so echo is not speech. */
  speakingGuard: boolean;
}

/**
 * One VAD step. Steady noise lifts the floor and is rejected. A voice is a
 * short run of frames above that floor. While FRIDAY is speaking the bar is
 * higher so echo is not a barge-in, and a close talker still clears it.
 */
function voiceDot(left: number[], right: number[]): number | null {
  if (left.length === 0 || left.length !== right.length) return null;
  let dot = 0;
  let leftSq = 0;
  let rightSq = 0;
  for (let index = 0; index < left.length; index += 1) {
    const x = left[index] ?? 0;
    const y = right[index] ?? 0;
    dot += x * y;
    leftSq += x * x;
    rightSq += y * y;
  }
  if (leftSq === 0 || rightSq === 0) return null;
  return dot / Math.sqrt(leftSq * rightSq);
}

/**
 * While FRIDAY is speaking, a frame that matches the playback is her own voice
 * and is dropped. A different frame can still barge in.
 */
export function suppressSelfVoice(input: {
  mic: number[];
  playback: number[];
  speaking: boolean;
}): { keep: boolean; reason: "quiet" | "self-voice" | "owner" } {
  if (!input.speaking) return { keep: true, reason: "quiet" };
  const sim = voiceDot(input.mic, input.playback);
  if (sim != null && sim >= 0.9) return { keep: false, reason: "self-voice" };
  return { keep: true, reason: "owner" };
}

export function advanceVad(input: {
  level: number;
  noiseFloor: number;
  voiceFrames: number;
  speakingGuard: boolean;
  ducked: boolean;
}): { noiseFloor: number; voiceFrames: number; speech: boolean; threshold: number } {
  const floor =
    input.noiseFloor === 0
      ? input.level
      : input.level > input.noiseFloor
        ? input.noiseFloor * 0.995 + input.level * 0.005
        : input.noiseFloor * 0.9 + input.level * 0.1;
  const floorMul = input.speakingGuard ? 4.2 : 2.4;
  const extra = input.speakingGuard ? 0.018 : 0.006;
  const minAbs = input.speakingGuard ? 0.02 : 0.008;
  const threshold = Math.max(floor * floorMul, floor + extra, minAbs);
  const loud = !input.ducked && input.level > threshold;
  const voiceFrames = loud ? input.voiceFrames + 1 : Math.max(0, input.voiceFrames - 2);
  const needed = input.speakingGuard ? 8 : 3;
  return { noiseFloor: floor, voiceFrames, speech: voiceFrames >= needed, threshold };
}

const SILENT: VadSnapshot = {
  level: 0,
  noiseFloor: 0,
  speech: false,
  sinceSpeech: null,
  running: false,
  speakingGuard: false,
};

/**
 * Adaptive energy VAD. It learns the room's noise floor continuously while no
 * speech is present, and only reports speech when the signal clears the floor
 * by a margin for a few consecutive frames. Steady noise (fan, AC, traffic)
 * raises the floor and is therefore rejected; a voice is transient and clears it.
 */
export class VoiceGate {
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private raf = 0;
  private buffer: Float32Array = new Float32Array(0);
  private snapshot: VadSnapshot = SILENT;
  private listeners = new Set<(s: VadSnapshot) => void>();
  private voiceFrames = 0;
  private lastSpeechAt = 0;
  /** Hard mute — leftover API. Auto Mode uses speakingGuard during TTS instead. */
  private ducked = false;
  /**
   * Raised VAD bar while FRIDAY's TTS is in the room. Full duck would block
   * barge-in; an unguarded live VAD treats speaker echo as the owner talking.
   */
  private speakingGuard = false;
  /** Everyone currently relying on this one microphone stream. */
  private holders = new Set<string>();
  /** The device the live stream was opened with, so it can be reopened. */
  private deviceId: string | null = null;
  private lastFailure: { state: MicState; reason: string } | null = null;
  private reopening = false;
  private deviceWatch: (() => void) | null = null;
  /** Last time UI subscribers were notified (speech edges always emit). */
  private lastEmitAt = 0;

  /**
   * The single live microphone stream. Dictation and any other consumer share
   * it instead of opening a second capture, which on Windows would fight the
   * first one for the device and stall input.
   */
  micStream(): MediaStream | null {
    return this.stream;
  }

  lastCaptureFailure(): { state: MicState; reason: string } | null {
    return this.lastFailure;
  }

  /** Opens (or joins) the shared stream on behalf of one named owner. */
  async acquire(holder: string, deviceId?: string | null): Promise<boolean> {
    const ok = await this.start(deviceId ?? undefined);
    if (ok) this.holders.add(holder);
    return ok;
  }

  /** Releases one owner; the stream closes only when the last one lets go. */
  release(holder: string) {
    this.holders.delete(holder);
    if (!this.holders.size) this.stop(true);
  }

  getSnapshot(): VadSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (s: VadSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** True when speech was detected within the given window. */
  heardSpeechWithin(ms: number): boolean {
    if (!this.snapshot.running) return true; // no gate → never block the recogniser
    if (this.snapshot.speech) return true;
    return this.lastSpeechAt > 0 && Date.now() - this.lastSpeechAt <= ms;
  }

  duck(on: boolean) {
    this.ducked = on;
    if (on) this.voiceFrames = 0;
  }

  /**
   * While FRIDAY is speaking, require a louder, longer burst before VAD
   * reports speech so keyboard/fan/echo do not barge-in, but a close talker
   * still can. Does not open a second microphone.
   */
  setSpeakingGuard(on: boolean) {
    if (this.speakingGuard === on) return;
    this.speakingGuard = on;
    if (on) this.voiceFrames = 0;
    if (this.snapshot.running) {
      this.snapshot = {
        ...this.snapshot,
        speakingGuard: on,
        speech: on ? false : this.snapshot.speech,
      };
      this.emit();
    }
  }

  isSpeakingGuarded(): boolean {
    return this.speakingGuard;
  }

  async start(deviceId?: string | null): Promise<boolean> {
    if (this.ctx) {
      await this.ensureRunning();
      return this.ctx.state !== "closed";
    }
    const md = media();
    const Ctx =
      typeof window !== "undefined"
        ? (window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
        : undefined;
    if (!md?.getUserMedia || !Ctx) return false;
    this.deviceId = deviceId ?? null;
    let ctx: AudioContext | null = null;
    try {
      // Resume during the click's user-activation window. Awaiting getUserMedia
      // or IPC first leaves AudioContext "suspended": AnalyserNode then reads
      // zeros, VAD never fires, and the UI can still say listening.
      ctx = new Ctx();
      await this.resumeContext(ctx);
      const stream = await this.openStream(md, deviceId);
      await this.resumeContext(ctx);
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.2;
      source.connect(analyser);
      this.stream = stream;
      this.ctx = ctx;
      this.source = source;
      this.analyser = analyser;
      this.buffer = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
      this.snapshot = { ...SILENT, running: true };
      // A microphone that is unplugged (or grabbed by another app) ends its
      // track. Without this the gate kept reporting "running" forever and the
      // whole voice pipeline waited for speech that could never arrive.
      const track = stream.getAudioTracks()[0];
      if (track) track.addEventListener("ended", this.onTrackEnded);
      this.watchDevices();
      this.loop();
      this.lastFailure = null;
      return true;
    } catch (err) {
      const own =
        this.stream?.getAudioTracks().filter((track) => track.readyState === "live").length ?? 0;
      this.lastFailure = classify(err, own, namedHolders);
      if (!this.ctx) void ctx?.close().catch(() => undefined);
      if (this.holders.size) this.teardown();
      else this.stop();
      return false;
    }
  }

  /** Strict constraints, then a relaxed open, then the system default. One stream. */
  private async openStream(md: MediaDevices, deviceId?: string | null): Promise<MediaStream> {
    const ids: Array<string | undefined> = [];
    if (deviceId && deviceId !== "default") ids.push(deviceId);
    ids.push(undefined);
    let last: unknown = null;
    for (const id of ids) {
      for (let step = 0; step < 3; step += 1) {
        const plan = relaxedCapture(step, id);
        if (!plan) break;
        try {
          return await md.getUserMedia({ audio: plan.audio });
        } catch (err) {
          last = err;
          const name = (err as { name?: string }).name ?? "";
          if (
            name !== "NotReadableError" &&
            name !== "TrackStartError" &&
            name !== "OverconstrainedError"
          ) {
            break;
          }
        }
      }
    }
    throw last ?? new Error("the microphone did not open");
  }

  stop(force = false) {
    // A shared stream is never torn down under a holder that still needs it.
    if (!force && this.holders.size) return;
    this.holders.clear();
    this.deviceWatch?.();
    this.deviceWatch = null;
    this.teardown();
  }

  /** Closes the audio graph but keeps the holders, so it can be reopened. */
  private teardown() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.source?.disconnect();
    this.analyser?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.source = null;
    this.analyser = null;
    this.stream = null;
    this.voiceFrames = 0;
    this.speakingGuard = false;
    this.ducked = false;
    this.snapshot = SILENT;
    this.emit();
  }

  /**
   * The live microphone disappeared. Consumers still hold the gate, so the
   * graph is closed and reopened (default device) with a short backoff until
   * the device comes back or the last holder lets go.
   */
  private onTrackEnded = () => {
    if (!this.holders.size) return this.stop(true);
    this.teardown();
    void this.reopen();
  };

  private async reopen(attempt = 0): Promise<void> {
    if (this.reopening || !this.holders.size) return;
    this.reopening = true;
    try {
      const ok = await this.start(this.deviceId);
      if (!ok && captureMayRetry(attempt) && this.holders.size) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 8000)));
        this.reopening = false;
        return this.reopen(attempt + 1);
      }
    } finally {
      this.reopening = false;
    }
  }

  /** Reconnect when the owner plugs a microphone back in. */
  private watchDevices() {
    const md = media();
    if (this.deviceWatch || !md?.addEventListener) return;
    const handler = () => {
      if (this.holders.size && !this.ctx) void this.reopen();
    };
    md.addEventListener("devicechange", handler);
    this.deviceWatch = () => md.removeEventListener?.("devicechange", handler);
  }

  private async resumeContext(ctx: AudioContext | null = this.ctx): Promise<void> {
    if (!ctx || ctx.state !== "suspended") return;
    try {
      await ctx.resume();
    } catch {
      /* Chromium may still resume on the next gesture */
    }
  }

  private async ensureRunning(): Promise<void> {
    await this.resumeContext();
  }

  private loop = () => {
    const analyser = this.analyser;
    if (!analyser) return;
    if (this.ctx?.state === "suspended") void this.resumeContext();
    try {
      analyser.getFloatTimeDomainData(this.buffer as Float32Array<ArrayBuffer>);
    } catch {
      this.buffer = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
      try {
        analyser.getFloatTimeDomainData(this.buffer as Float32Array<ArrayBuffer>);
      } catch {
        this.raf = requestAnimationFrame(this.loop);
        return;
      }
    }
    let sum = 0;
    for (let i = 0; i < this.buffer.length; i += 1) {
      const v = this.buffer[i] ?? 0;
      sum += v * v;
    }
    const level = Math.sqrt(sum / this.buffer.length);
    const prev = this.snapshot;
    const step = advanceVad({
      level,
      noiseFloor: prev.noiseFloor,
      voiceFrames: this.voiceFrames,
      speakingGuard: this.speakingGuard,
      ducked: this.ducked,
    });
    this.voiceFrames = step.voiceFrames;
    const speech = step.speech;
    if (speech) this.lastSpeechAt = Date.now();
    this.snapshot = {
      level,
      noiseFloor: step.noiseFloor,
      speech,
      sinceSpeech: this.lastSpeechAt ? Date.now() - this.lastSpeechAt : null,
      running: true,
      speakingGuard: this.speakingGuard,
    };
    const now = Date.now();
    const speechChanged = speech !== prev.speech;
    const uiTick = now - this.lastEmitAt >= 200;
    if (speechChanged || (uiTick && Math.abs(level - prev.level) > 0.01)) {
      this.lastEmitAt = now;
      this.emit();
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  private emit() {
    this.listeners.forEach((fn) => fn(this.snapshot));
  }
}

export const voiceGate = new VoiceGate();
