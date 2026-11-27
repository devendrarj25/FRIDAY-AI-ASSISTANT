/**
 * One simulated room, end to end, for the own echo canceller (voice.echoReference): a 150 ms path, FRIDAY's answer as
 * the reference, the owner starting to talk over her one second in. Asserts what the owner's PC A/B will later check
 * by ear: his voice survives (within 1.5 dB), her echo drops (at least 15 dB) and barge-in fires within 400 ms of
 * his onset, counted in capture frames (no wall clock). A simulated room is not a real room: the setting stays off
 * by default until that A/B is done on the owner's speakers and an HFP headset.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanedLevel,
  markWorklet,
  noteCaptureFrame,
  preRollFrom,
  resetCaptureRing,
  setCaptureLatency,
  setCaptureProcessor,
} from "../../src/lib/friday/pcm-capture";
import { EchoLive } from "../../src/lib/friday/voice-engine/echo-live";
import { floatToPcm16 } from "../../src/lib/friday/voice-engine/audio-format";
import {
  BargeLadder,
  echoReferenceRunning,
} from "../../src/lib/friday/voice-engine/interruption-controller";
import { PcmClipPlayer, type PcmContext } from "../../src/lib/friday/voice-engine/pcm-clip-player";
import {
  audioConstraints,
  trackProcessing,
  trackProcessingRows,
} from "../../src/lib/friday/voice-audio";
import { DEFAULT_PREFERENCES } from "../../src/lib/friday/preferences";

const RATE = 48_000;
const FRAME = 128;
const T0 = 7.5; // the first microphone sample, in the air, on the common clock
const S = 10.0; // the answer is scheduled now
const OUT_LAT = 0.03;
const IN_LAT = 0.012;
const DELAY_MS = 150;
const ANSWER_S = 8;
/** The owner's first sound, seconds after the answer is scheduled. */
const OWNER_AT_S = 1.0;
const OWNER_S = 2;
/** The level the recogniser's VAD calls a voice on the cleaned signal. */
const VOICE_LEVEL = 0.02;
const HOLD_FRAMES = Math.round((0.25 * RATE) / FRAME);
/** A talker close to the microphone: as loud in the ring as her echo is, so the echo shows in the sum. */
const OWNER_GAIN = 1;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xffffffff - 0.5;
  };
}

/** Speech-like band-limited signal at 48 kHz, with syllables and pauses. */
function speech48(seconds: number, seed: number): Float32Array {
  const rand = rng(seed);
  const n = Math.round(seconds * RATE);
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i += 1) raw[i] = rand();
  const smooth = (x: Float32Array): Float32Array => {
    const out = new Float32Array(x.length);
    let acc = 0;
    for (let i = 0; i < x.length; i += 1) {
      acc += x[i]! - (i >= 16 ? x[i - 16]! : 0);
      out[i] = acc / 16;
    }
    return out;
  };
  const x = smooth(smooth(raw));
  let peak = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / RATE;
    x[i] =
      x[i]! *
      Math.max(0, Math.sin(2 * Math.PI * 3.2 * t)) *
      (Math.sin(2 * Math.PI * 0.4 * t) > -0.6 ? 1 : 0);
    peak = Math.max(peak, Math.abs(x[i]!));
  }
  for (let i = 0; i < n; i += 1) x[i] = (x[i]! / peak) * 0.6;
  return x;
}

function room48(delayMs: number, gain: number, seed: number) {
  const delay = Math.round((delayMs / 1000) * RATE);
  const rand = rng(seed);
  const h = new Float32Array(480);
  for (let k = 0; k < h.length; k += 1)
    h[k] = gain * Math.exp(-k / 90) * (k === 0 ? 1 : rand() * 1.2);
  return (x: Float32Array, length: number): Float32Array => {
    const out = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      let acc = 0;
      for (let k = 0; k < h.length; k += 1) {
        const j = i - delay - k;
        if (j >= 0 && j < x.length) acc += h[k]! * x[j]!;
      }
      out[i] = acc;
    }
    return out;
  };
}

const rmsOf = (x: ArrayLike<number>): number => {
  let sum = 0;
  for (let i = 0; i < x.length; i += 1) sum += (x[i] ?? 0) ** 2;
  return Math.sqrt(sum / Math.max(1, x.length));
};
const db = (a: number, b: number): number => 20 * Math.log10(Math.max(a, 1e-9) / Math.max(b, 1e-9));

function fakeContext(clock: { ms: number }): PcmContext {
  return {
    sampleRate: 24_000,
    state: "running",
    outputLatency: OUT_LAT,
    get currentTime() {
      return Math.floor((clock.ms / 1000 - 3.7) * 100) / 100;
    },
    destination: {},
    createBuffer: () => ({ copyToChannel: () => undefined }),
    createBufferSource: () => ({
      buffer: null,
      connect: () => undefined,
      start: () => undefined,
      stop: () => undefined,
      onended: null,
    }),
  } as unknown as PcmContext;
}

const noTimers = {
  setTimeout: () => 0,
  clearTimeout: () => undefined,
  setInterval: () => 0,
  clearInterval: () => undefined,
};

type RoomRun = {
  live: EchoLive;
  /** Seconds after the answer is scheduled, on the capture clock, when the owner's own sound really starts. */
  ownerOnsetFrame: number;
  /** Frame index (of 128 samples) of the first barge-in, or null. */
  bargeFrame: number | null;
  /** The detector fired before the owner spoke (a false barge-in on her own echo). */
  falseBarge: boolean;
  echoStartMs: number;
};

/**
 * A speaker plays the answer through the real player, the room returns it, the owner's voice is added from
 * OWNER_AT_S, and the capture hook delivers 128-sample frames. The barge-in detector reads the level the VAD
 * would read (the cleaned level when the canceller ran, the raw frame otherwise).
 */
function room(opts: { on: boolean; echoGain: number; owner: boolean; seed: number }): RoomRun {
  const x48 = speech48(ANSWER_S, opts.seed);
  const x24 = new Float32Array(Math.floor(x48.length / 2));
  for (let i = 0; i < x24.length; i += 1) x24[i] = x48[i * 2]!;
  const clock = { ms: 0 };
  const player = new PcmClipPlayer(fakeContext(clock), { timers: noTimers });
  const live = new EchoLive({ enabled: () => opts.on, nowMs: () => clock.ms, shadow: () => null });
  resetCaptureRing();
  setCaptureProcessor(null);
  setCaptureLatency(IN_LAT);
  markWorklet(true);
  live.attach(player);

  const emitIndex = Math.round((S + OUT_LAT - T0) * RATE);
  const total = emitIndex + x48.length + RATE;
  const emitted = new Float32Array(total);
  emitted.set(x48, emitIndex);
  const mic = room48(DELAY_MS, opts.echoGain, 7)(emitted, total);
  const ownerStart = Math.round((S + OWNER_AT_S - T0) * RATE);
  if (opts.owner) {
    const voice = speech48(OWNER_S, 77);
    for (let i = 0; i < voice.length; i += 1) mic[ownerStart + i]! += voice[i]! * OWNER_GAIN;
  }
  // the owner's own sound begins at the first 10 ms stretch that is clearly voice
  let onsetSample = ownerStart;
  if (opts.owner) {
    const voice = speech48(OWNER_S, 77);
    for (let i = 0; i + 480 <= voice.length; i += 64) {
      if (rmsOf(voice.subarray(i, i + 480).map((v) => v * OWNER_GAIN)) > 0.02) {
        onsetSample = ownerStart + i;
        break;
      }
    }
  }
  const ownerOnsetFrame = Math.floor(onsetSample / FRAME);

  const ladder = new BargeLadder();
  const levels: number[] = [];
  const jitter = rng(99);
  let replyStartedAt: number | null = null;
  let scheduled = false;
  let lastDelivered = 0;
  let bargeFrame: number | null = null;
  let falseBarge = false;
  for (let at = 0, n = 0; at + FRAME <= total; at += FRAME, n += 1) {
    const ideal = (T0 + (at + FRAME) / RATE + IN_LAT) * 1000;
    const delivered = Math.max(lastDelivered, ideal + (jitter() + 0.5) * 6);
    lastDelivered = delivered;
    clock.ms = delivered;
    if (!scheduled && delivered >= S * 1000) {
      scheduled = true;
      replyStartedAt = delivered;
      ladder.begin(delivered);
      for (let c = 0; c < x24.length; c += 12_000)
        player.start(floatToPcm16(x24.subarray(c, Math.min(x24.length, c + 12_000))), 24_000);
    }
    noteCaptureFrame(mic.subarray(at, at + FRAME), delivered, RATE, 0);
    if (!scheduled) continue;
    const frameMic = mic.subarray(at, at + FRAME);
    // the VAD holds a voice for 250 ms (`heardSpeechWithin(250)`): speech on the signal the capture hook cleaned
    levels.push(cleanedLevel(delivered) ?? rmsOf(frameMic));
    if (levels.length > HOLD_FRAMES) levels.shift();
    const verdict = ladder.evaluate({
      t: delivered,
      echoCleanedSpeech:
        echoReferenceRunning({
          enabled: opts.on,
          attached: true,
          cancelledFrames: live.diagnostics().cancelledFrames,
        }) && Math.max(...levels) > VOICE_LEVEL,
      text: null,
      replyStartedAt,
      replyEndsAt: null,
    });
    const fired = verdict.kind === "duck" || verdict.kind === "stop";
    if (fired && bargeFrame === null) {
      bargeFrame = n;
      if (n < ownerOnsetFrame || !opts.owner) falseBarge = true;
    }
  }
  return {
    live,
    ownerOnsetFrame,
    bargeFrame,
    falseBarge,
    echoStartMs: (S + OUT_LAT + DELAY_MS / 1000) * 1000,
  };
}

/** Power-free level of the ring between two air times given in seconds on the common clock. */
function ringRms(fromAirS: number, toAirS: number): number {
  const stamp = (airS: number) => (airS + IN_LAT) * 1000 + 12;
  const a = preRollFrom(stamp(fromAirS));
  const b = preRollFrom(stamp(toAirS));
  return rmsOf(a.subarray(0, a.length - b.length));
}

beforeEach(() => {
  resetCaptureRing();
  setCaptureProcessor(null);
  setCaptureLatency(0);
});
afterEach(() => {
  setCaptureProcessor(null);
  markWorklet(false);
  resetCaptureRing();
});

describe("simulated room: 150 ms path, owner talks over her one second in", () => {
  const FRAMES_400_MS = Math.round((0.4 * RATE) / FRAME);
  const win = (fromS: number, toS: number) => ringRms(S + fromS, S + toS);

  it("keeps the owner's voice within 1.5 dB, takes her echo down at least 15 dB, and barge-in fires within 400 ms", () => {
    room({ on: true, echoGain: 0, owner: true, seed: 31 });
    const ownerAlone = win(OWNER_AT_S, OWNER_AT_S + OWNER_S);
    const raw = room({ on: false, echoGain: 0.5, owner: true, seed: 31 });
    const rawOwner = win(OWNER_AT_S, OWNER_AT_S + OWNER_S);
    const rawEcho = win(4.5, 7.5);
    const on = room({ on: true, echoGain: 0.5, owner: true, seed: 31 });
    const onOwner = win(OWNER_AT_S, OWNER_AT_S + OWNER_S);
    const onEcho = win(4.5, 7.5);

    // the room really does add her echo to his voice, so the check below can fail
    expect(db(rawOwner, ownerAlone)).toBeGreaterThan(2.5);
    expect(on.live.diagnostics().cancelledFrames).toBeGreaterThan(100);
    expect(Math.abs(db(onOwner, ownerAlone))).toBeLessThanOrEqual(1.5);
    expect(db(rawEcho, onEcho)).toBeGreaterThanOrEqual(15);
    // no frame is a barge-in before he speaks, and the first one comes within 400 ms of his onset (frames, not time)
    expect(on.falseBarge).toBe(false);
    expect(on.bargeFrame).not.toBeNull();
    expect(on.bargeFrame! - on.ownerOnsetFrame).toBeGreaterThanOrEqual(0);
    expect(on.bargeFrame! - on.ownerOnsetFrame).toBeLessThanOrEqual(FRAMES_400_MS);
    // the plain level-only room, with the canceller off, is not what the ladder listens to: it never fires there
    expect(raw.bargeFrame).toBeNull();
  }, 60_000);

  it("her own echo alone never counts as the owner's voice: no barge-in while the filter learns the room", () => {
    const alone = room({ on: true, echoGain: 0.5, owner: false, seed: 31 });
    expect(alone.live.diagnostics().cancelledFrames).toBeGreaterThan(100);
    expect(alone.bargeFrame).toBeNull();
  }, 60_000);

  it("the setting stays off by default until the owner-PC A/B (headset and speaker) is done", () => {
    expect(DEFAULT_PREFERENCES.voice.echoReference).toBe(false);
    expect(read("src/lib/friday/preferences.ts")).toMatch(/echoReference: false,/);
  });
});

describe("diagnostics: what the browser really applied to the live microphone track", () => {
  const asked = { echoCancellation: true, noiseSuppression: true, autoGainControl: false };

  it("reads only the three processing flags from getSettings, and keeps a missing one as unknown", () => {
    expect(
      trackProcessing({ echoCancellation: true, noiseSuppression: false, autoGainControl: false }),
    ).toEqual({ echoCancellation: true, noiseSuppression: false, autoGainControl: false });
    expect(trackProcessing({ echoCancellation: false, sampleRate: 16_000 })).toEqual({
      echoCancellation: false,
      noiseSuppression: null,
      autoGainControl: null,
    });
    expect(trackProcessing(undefined)).toBeNull();
    expect(trackProcessing(null)).toBeNull();
  });

  it("shows asked and live side by side, and flags a track that dropped what was asked", () => {
    const rows = trackProcessingRows(
      { echoCancellation: false, noiseSuppression: true, autoGainControl: null },
      asked,
    );
    expect(rows.map((r) => r.label)).toEqual([
      "microphone echo cancellation (asked · live track)",
      "microphone noise suppression (asked · live track)",
      "microphone auto gain (asked · live track)",
    ]);
    expect(rows[0]).toEqual({
      label: "microphone echo cancellation (asked · live track)",
      value: "on · live off",
      bad: true,
    });
    expect(rows[1]!.value).toBe("on · live on");
    expect(rows[1]!.bad).toBeUndefined();
    expect(rows[2]!.value).toBe("off · live not reported");
    expect(rows[2]!.bad).toBeUndefined();
  });

  it("with no live microphone nothing is invented: every row says there is none", () => {
    const rows = trackProcessingRows(null, asked);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.value).toMatch(/no live microphone$/);
      expect(row.bad).toBeUndefined();
    }
  });

  it("the asked side is the constraint the capture really sends, so the two can never disagree", () => {
    const c = audioConstraints(undefined, true);
    expect(c.echoCancellation).toBe(true);
    expect(c.noiseSuppression).toBe(true);
    expect(typeof c.autoGainControl).toBe("boolean");
  });
});

const read = (rel: string) => readFileSync(resolve(__dirname, "../..", rel), "utf8");
