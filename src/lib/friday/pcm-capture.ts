/**
 * FRIDAY · one PCM capture clock for the shared microphone.
 *
 * The VAD and the recorder read this ring. A segment keeps 500 ms of audio
 * from before speech was marked, so the first syllable is not cut off.
 * Durations use a monotonic clock. A wall-clock jump past the hard cap is a
 * stuck segment and is reported once at the cap.
 */

export const PRE_ROLL_MS = 500;
export const TARGET_RATE = 16_000;
const RING_MS = 600;

export type SegmentClock = {
  close: boolean;
  reportMs: number;
  bug: boolean;
  reason: string;
};

/** Close a segment that outlived its cap, including one frozen across sleep. */
export function segmentClock(input: {
  startedMono: number;
  nowMono: number;
  startedWall: number;
  nowWall: number;
  maxUtteranceMs: number;
}): SegmentClock {
  const maxMs = Math.max(1000, input.maxUtteranceMs);
  const cap = maxMs + 1500;
  const mono = Math.max(0, input.nowMono - input.startedMono);
  const wall = Math.max(0, input.nowWall - input.startedWall);
  const bug = wall > cap && wall > mono + 1000;
  if (mono > maxMs || wall > cap) {
    return {
      close: true,
      reportMs: Math.min(bug ? maxMs : mono || wall, cap),
      bug,
      reason: bug ? "segment duration exceeded the hard cap" : "segment closed",
    };
  }
  return { close: false, reportMs: Math.round(mono), bug: false, reason: "" };
}

export type MicFaultKind =
  | "track-ended"
  | "track-muted"
  | "no-frames"
  | "vad-without-audio"
  | "segment-over-cap"
  | "sleep-resume"
  | "device-change"
  | "permission";

export function micWatch(input: {
  live: boolean;
  lastFrameMono: number;
  nowMono: number;
  lastWall: number;
  nowWall: number;
  speechForMs: number;
  capturedSamples: number;
  segmentWallMs: number;
  maxUtteranceMs: number;
  trackState?: string;
  muted?: boolean;
}): { restart: boolean; kind: MicFaultKind | ""; message: string } {
  if (!input.live) return { restart: false, kind: "", message: "" };
  if (input.trackState === "ended") {
    return {
      restart: true,
      kind: "track-ended",
      message: "The microphone track ended. Reopening it.",
    };
  }
  if (input.muted) {
    return {
      restart: true,
      kind: "track-muted",
      message: "The microphone track is muted. Reopening it.",
    };
  }
  const frameAge = input.lastFrameMono > 0 ? input.nowMono - input.lastFrameMono : 0;
  const wallGap = input.lastWall > 0 ? input.nowWall - input.lastWall : 0;
  if (wallGap > frameAge + 2000 && wallGap > 2000) {
    return {
      restart: true,
      kind: "sleep-resume",
      message: "The PC woke up. Reopening the microphone.",
    };
  }
  if (input.lastFrameMono > 0 && frameAge > 2000) {
    return {
      restart: true,
      kind: "no-frames",
      message: "No audio frames arrived. Reopening the microphone.",
    };
  }
  if (input.speechForMs > 1500 && input.capturedSamples < 160) {
    return {
      restart: true,
      kind: "vad-without-audio",
      message: "Speech was heard but no audio was captured. Reopening the microphone.",
    };
  }
  if (input.segmentWallMs > input.maxUtteranceMs + 1500) {
    return {
      restart: true,
      kind: "segment-over-cap",
      message: "A caption segment stayed open past its cap. Reopening the microphone.",
    };
  }
  return { restart: false, kind: "", message: "" };
}

/** At most `limit` restarts in a rolling minute. */
export function allowRestart(stamps: readonly number[], now: number, limit = 4): boolean {
  return stamps.filter((stamp) => now - stamp < 60_000).length < limit;
}

export function collapseVoiceLog<T extends { stage: string; detail: string }>(
  entries: readonly T[],
): Array<T & { count: number }> {
  const out: Array<T & { count: number }> = [];
  for (const entry of entries) {
    const last = out[out.length - 1];
    if (last && last.stage === entry.stage && last.detail === entry.detail) {
      last.count += 1;
      continue;
    }
    out.push({ ...entry, count: 1 });
  }
  return out;
}

type Queued<T> = { item: T; samples: number };

/**
 * Keep utterance order. When the queue is past the cap, drop the oldest
 * short clip first. A long clip is kept over a short one.
 */
export function admitUtterance<T>(
  queue: Queued<T>[],
  item: T,
  samples: number,
  cap = 3,
): {
  queue: Queued<T>[];
  dropped: number;
} {
  const next = queue.concat([{ item, samples }]);
  let dropped = 0;
  while (next.length > cap) {
    const oldestShort = next.findIndex(
      (row, index) => index < next.length - 1 && row.samples < 8000,
    );
    next.splice(oldestShort >= 0 ? oldestShort : 0, 1);
    dropped += 1;
  }
  return { queue: next, dropped };
}

const buckets = [500, 2000, 8000, 20_000];

export function durationBucket(ms: number): string {
  const safe = Math.max(0, ms);
  for (const edge of buckets) if (safe <= edge) return `<=${edge}`;
  return "over";
}

export function emptyHistogram(): Record<string, number> {
  return { "<=500": 0, "<=2000": 0, "<=8000": 0, "<=20000": 0, over: 0 };
}

/** Rolling 16 kHz mono audio. The ring always holds the pre-roll window. */
export class PcmRing {
  private readonly data: Float32Array;
  private write = 0;
  private filled = 0;
  private readonly stamps: number[] = [];
  private readonly stampAt: number[] = [];

  constructor(preRollMs = PRE_ROLL_MS) {
    const samples = Math.round((TARGET_RATE * Math.max(preRollMs, RING_MS)) / 1000);
    this.data = new Float32Array(samples);
  }

  push(samples: ArrayLike<number>, atMono: number, fromRate = TARGET_RATE): void {
    const step = fromRate > TARGET_RATE ? fromRate / TARGET_RATE : 1;
    for (let i = 0; i < samples.length; i += step) {
      const index = Math.floor(i);
      this.data[this.write] = samples[index] ?? 0;
      this.stampAt[this.write] = atMono;
      this.write = (this.write + 1) % this.data.length;
      this.filled = Math.min(this.data.length, this.filled + 1);
    }
    this.stamps.push(atMono);
    if (this.stamps.length > 80) this.stamps.shift();
  }

  framesPerSecond(nowMono: number): number {
    const recent = this.stamps.filter((stamp) => nowMono - stamp < 1000);
    return recent.length;
  }

  /** Samples from `fromMono` to now, including audio already in the ring. */
  takeSince(fromMono: number): Float32Array {
    if (!this.filled) return new Float32Array(0);
    const out: number[] = [];
    const start = (this.write - this.filled + this.data.length) % this.data.length;
    for (let n = 0; n < this.filled; n += 1) {
      const index = (start + n) % this.data.length;
      if ((this.stampAt[index] ?? 0) >= fromMono) out.push(this.data[index] ?? 0);
    }
    return Float32Array.from(out);
  }
}

let ring = new PcmRing();
let lastFrameMono = 0;
let lastFrameWall = 0;
let workletOn = false;

export function resetCaptureRing(): void {
  ring = new PcmRing();
  lastFrameMono = 0;
  lastFrameWall = 0;
  workletOn = false;
}

export function noteCaptureFrame(
  samples: ArrayLike<number>,
  atMono: number,
  fromRate: number,
  wall = 0,
): void {
  if (!samples || samples.length === 0) return;
  ring.push(samples, atMono, fromRate);
  lastFrameMono = atMono;
  if (wall) lastFrameWall = wall;
}

export function markWorklet(on: boolean): void {
  workletOn = on;
}

export function workletCapturing(): boolean {
  return workletOn;
}

export function captureClock(): { lastFrameMono: number; lastFrameWall: number; fps: number } {
  return {
    lastFrameMono,
    lastFrameWall,
    fps: ring.framesPerSecond(lastFrameMono || 0),
  };
}

export function preRollFrom(speechAtMono: number, preRollMs = PRE_ROLL_MS): Float32Array {
  return ring.takeSince(speechAtMono - preRollMs);
}

export function encodeWav(samples: Float32Array, rate = TARGET_RATE): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return bytes;
}
