/**
 * Click-free joins in the sample player: equal-power seams between the clauses of one answer, a short fade at an
 * answer's start and at a stop, silence kept for a pause, the backlog and underrun signal, and the player running at
 * the context rate for sources of 22.05, 24, 44.1 and 48 kHz. Fake audio context and fake clock: no speaker.
 */
import { describe, expect, it } from "vitest";
import { floatToPcm16, pcm16ToFloat } from "../../src/lib/friday/voice-engine/audio-format";
import {
  PCM_FALLBACK_RATE,
  PcmClipPlayer,
  playRate,
  type PcmContext,
} from "../../src/lib/friday/voice-engine/pcm-clip-player";
import {
  DEFAULT_EDGE_FADE_MS,
  DEFAULT_JOIN_MS,
  DEFAULT_UNDERRUN_FLOOR_MS,
  PcmPlayback,
  equalPowerCurves,
  fadeEdge,
  joinClips,
  joinSeam,
  msToSamples,
} from "../../src/lib/friday/voice-engine/playback-scheduler";
import { PlayedTextTracker } from "../../src/lib/friday/voice-engine/played-text";

const RATE = 8000; // 8 ms = 64 samples, 4 ms = 32 samples

/** A seeded noise generator, so the power checks are the same on every machine. */
function noise(length: number, seed: number): Float32Array {
  let state = seed >>> 0;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state ^ (state >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
    state = Math.imul(state ^ (state >>> 13), 3266489909) >>> 0;
    out[i] = ((state >>> 8) / 0x800000 - 1) * 0.5;
  }
  return out;
}
const power = (x: Float32Array): number => {
  let sum = 0;
  for (const v of x) sum += v * v;
  return sum / Math.max(1, x.length);
};

class FakeBuffer {
  data = new Float32Array(0);
  constructor(readonly length: number) {}
  copyToChannel(data: Float32Array) {
    this.data = data.slice();
  }
}
class FakeSource {
  buffer: FakeBuffer | null = null;
  when = -1;
  stopped = false;
  stopAt: number | undefined = undefined;
  onended: (() => void) | null = null;
  connect() {}
  start(when?: number) {
    this.when = when ?? 0;
  }
  stop(when?: number) {
    this.stopped = true;
    this.stopAt = when;
  }
}
class FakeGain {
  gain = {
    value: 1,
    targets: [] as { target: number; at: number; constant: number }[],
    setTargetAtTime(target: number, at: number, constant: number) {
      this.targets.push({ target, at, constant });
    },
  };
  connect() {}
}
class FakeContext {
  currentTime = 0;
  destination = {};
  state = "running";
  outputLatency = 0;
  baseLatency = 0;
  sources: FakeSource[] = [];
  gains: FakeGain[] = [];
  constructor(
    readonly sampleRate = RATE,
    private readonly withGain = false,
  ) {
    if (!withGain) (this as { createGain?: unknown }).createGain = undefined;
  }
  createBuffer(_c: number, length: number) {
    return new FakeBuffer(length);
  }
  createBufferSource() {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  createGain() {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
  /** Sources that will really sound: not stopped before their start. */
  get live(): FakeSource[] {
    return this.sources.filter((s) => !s.stopped);
  }
}

const noGain = (rate = RATE) => {
  const ctx = new FakeContext(rate);
  (ctx as { createGain?: unknown }).createGain = undefined;
  return ctx;
};
const ramp = (length: number, value = 8000) => new Int16Array(length).fill(value);
const shaped = { joinMs: DEFAULT_JOIN_MS, edgeFadeMs: DEFAULT_EDGE_FADE_MS };

describe("the join maths (pure)", () => {
  it("the two equal-power curves keep constant power at every sample", () => {
    const { out, inn } = equalPowerCurves(64);
    for (let i = 0; i < 64; i += 1) {
      expect((out[i] ?? 0) ** 2 + (inn[i] ?? 0) ** 2).toBeCloseTo(1, 6);
    }
    expect(out[0]).toBeGreaterThan(0.99);
    expect(inn[0]).toBeLessThan(0.05);
    expect(out[63]).toBeLessThan(0.05);
    for (let i = 1; i < 64; i += 1) expect(out[i] ?? 0).toBeLessThan(out[i - 1] ?? 0);
    expect(equalPowerCurves(0).out).toHaveLength(0);
  });

  it("a seam of two uncorrelated signals keeps the power of either", () => {
    const tail = noise(2000, 11);
    const head = noise(2000, 97);
    const seam = joinSeam(tail, head);
    const reference = (power(tail) + power(head)) / 2;
    expect(power(seam) / reference).toBeGreaterThan(0.9);
    expect(power(seam) / reference).toBeLessThan(1.1);
  });

  it("joined clips lose no sample outside the seam and their durations add up", () => {
    const prev = noise(500, 1);
    const next = noise(300, 2);
    const joined = joinClips(prev, next, 64);
    expect(joined.length).toBe(500 + 300 - 64);
    expect(Array.from(joined.subarray(0, 436))).toEqual(Array.from(prev.subarray(0, 436)));
    expect(Array.from(joined.subarray(500))).toEqual(Array.from(next.subarray(64)));
    // The seam starts on the old clip and ends on the new one.
    expect(Math.abs((joined[436] ?? 0) - (prev[436] ?? 0))).toBeLessThan(0.05);
    expect(Math.abs((joined[499] ?? 0) - (next[63] ?? 0))).toBeLessThan(0.05);
  });

  it("no overlap is a plain concatenation, and an overlap longer than a clip is cut to it", () => {
    const a = noise(10, 3);
    const b = noise(6, 4);
    expect(Array.from(joinClips(a, b, 0))).toEqual([...a, ...b]);
    expect(joinClips(a, b, 0).length).toBe(16);
    expect(joinClips(a, b, 1000).length).toBe(10);
    expect(joinClips(new Float32Array(0), b, 8).length).toBe(6);
  });

  it("an edge fade leaves the original untouched and shapes only the edge", () => {
    const src = new Float32Array(100).fill(0.5);
    const fadedIn = fadeEdge(src, 20, "in");
    expect(src[0]).toBe(0.5);
    expect(fadedIn[0] ?? 1).toBeLessThan(0.05);
    expect(fadedIn[20]).toBe(0.5);
    const fadedOut = fadeEdge(src, 20, "out");
    expect(fadedOut[99] ?? 1).toBeLessThan(0.05);
    expect(fadedOut[79]).toBe(0.5);
    expect(fadeEdge(src, 500, "in")).toHaveLength(100);
  });

  it("converts a time to whole samples at the rate and never to a negative", () => {
    expect(msToSamples(8, 8000)).toBe(64);
    expect(msToSamples(4, 48000)).toBe(192);
    expect(msToSamples(0, 48000)).toBe(0);
    expect(msToSamples(Number.NaN, 48000)).toBe(0);
    expect(msToSamples(-5, 48000)).toBe(0);
    expect(msToSamples(0.01, 8000)).toBe(1);
  });
});

describe("the scheduler seams", () => {
  it("clips with no gap overlap by the join and the played time stays exact", () => {
    const ctx = noGain();
    const heard: { when: number; length: number }[] = [];
    const playback = new PcmPlayback(ctx as unknown as PcmContext, { rate: RATE, ...shaped });
    playback.onScheduled((when, pcm) => heard.push({ when, length: pcm.length }));
    expect(playback.enqueue(ramp(800))).toBe(true); // 100 ms
    expect(playback.enqueue(ramp(800))).toBe(true);
    expect(playback.lastOverlapMs()).toBe(8);
    // The second clip starts 8 ms before the first one ends; the pending tail of the first was replaced.
    expect(heard).toEqual([
      { when: 0, length: 800 },
      { when: 0.092, length: 800 },
    ]);
    expect(playback.lastSpan()).toEqual({ startMs: 92, endMs: 192 });
    expect(playback.queuedMs()).toBeCloseTo(192, 6);
    ctx.currentTime = 0.15;
    expect(playback.playedMs()).toBeCloseTo(150, 6);
    ctx.currentTime = 9;
    expect(playback.playedMs()).toBeCloseTo(192, 6);
  });

  it("sounds exactly the audio of both clips: the tail of the first never plays next to its replacement", () => {
    const ctx = noGain();
    const playback = new PcmPlayback(ctx as unknown as PcmContext, { rate: RATE, ...shaped });
    playback.enqueue(ramp(800, 10000));
    playback.enqueue(ramp(800, 10000));
    const cancelled = ctx.sources.filter((s) => s.stopped);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.when).toBeCloseTo(0.092, 9);
    const live = ctx.live.map((s) => s.buffer?.length ?? 0);
    // body of the first (736) + body of the second (736) + tail of the second (64) + the first clip's seam inside the second
    expect(live.reduce((a, b) => a + b, 0)).toBe(800 + 800 - 64);
  });

  it("a pause between clauses stays silence and is never crossfaded", () => {
    const ctx = noGain();
    const heard: { when: number; first: number }[] = [];
    const playback = new PcmPlayback(ctx as unknown as PcmContext, { rate: RATE, ...shaped });
    playback.onScheduled((when, pcm) => heard.push({ when, first: pcm[0] ?? 0 }));
    playback.enqueue(ramp(800));
    playback.enqueue(ramp(800), undefined, { gapMs: 50 });
    expect(playback.lastOverlapMs()).toBe(0);
    expect(playback.lastSpan()?.startMs).toBeCloseTo(150, 6);
    expect(playback.lastSpan()?.endMs).toBeCloseTo(250, 6);
    expect(playback.queuedMs()).toBeCloseTo(250, 6);
    // The silence is on the clock: played time moves through it but never passes the end of the speech.
    ctx.currentTime = 0.12;
    expect(playback.playedMs()).toBeCloseTo(120, 6);
    // After a pause the second clip fades in, and the first one's tail was re-placed with a fade-out.
    const secondHead = heard.find((h) => Math.abs(h.when - 0.15) < 1e-9);
    expect(Math.abs(secondHead?.first ?? 1e9)).toBeLessThan(500);
    expect(heard.some((h) => Math.abs(h.when - 0.092) < 1e-9)).toBe(true);
  });

  it("the first clip of an answer fades in; the rest of it is untouched", () => {
    const ctx = noGain();
    const heard: Int16Array[] = [];
    const playback = new PcmPlayback(ctx as unknown as PcmContext, { rate: RATE, ...shaped });
    playback.onScheduled((_w, pcm) => heard.push(pcm));
    playback.enqueue(ramp(800, 12000));
    const first = heard[0] ?? new Int16Array(0);
    expect(Math.abs(first[0] ?? 1e9)).toBeLessThan(700);
    for (let i = 1; i < 32; i += 1) expect(first[i] ?? 0).toBeGreaterThanOrEqual(first[i - 1] ?? 0);
    expect(first[32]).toBe(12000);
    expect(first[799]).toBe(12000);
  });

  it("does not crossfade into a tail that has already started: the clip is placed as it is", () => {
    const ctx = noGain();
    const heard: { when: number; first: number }[] = [];
    const playback = new PcmPlayback(ctx as unknown as PcmContext, { rate: RATE, ...shaped });
    playback.onScheduled((when, pcm) => heard.push({ when, first: pcm[0] ?? 0 }));
    playback.enqueue(ramp(800));
    ctx.currentTime = 0.095; // inside the 8 ms tail
    playback.enqueue(ramp(800, 9000));
    expect(playback.lastOverlapMs()).toBe(0);
    expect(heard[1]).toEqual({ when: 0.1, first: 9000 });
    expect(ctx.sources.filter((s) => s.stopped)).toHaveLength(0);
  });

  it("a clip too short for two overlaps is placed whole and cannot be crossfaded into", () => {
    const ctx = noGain();
    const playback = new PcmPlayback(ctx as unknown as PcmContext, { rate: RATE, ...shaped });
    playback.enqueue(ramp(100)); // 12.5 ms < 2 x 8 ms
    playback.enqueue(ramp(800));
    expect(playback.lastOverlapMs()).toBe(0);
    expect(ctx.sources).toHaveLength(3); // the short clip whole, then body and tail of the long one
    expect(playback.lastSpan()?.startMs).toBeCloseTo(12.5, 6);
  });

  it("without options every chunk is one source at its own start, exactly as before", () => {
    const ctx = noGain();
    const playback = new PcmPlayback(ctx as unknown as PcmContext, { rate: RATE });
    playback.enqueue(ramp(800));
    playback.enqueue(ramp(800));
    expect(ctx.sources.map((s) => s.when)).toEqual([0, 0.1]);
    expect(ctx.sources.map((s) => Math.round((s.buffer?.data[0] ?? 0) * 32767))).toEqual([
      8000, 8000,
    ]);
    expect(playback.lastOverlapMs()).toBe(0);
  });

  it("a stop fades the voice out over the edge fade when there is a gain stage, then starts clean", () => {
    const ctx = new FakeContext(RATE, true);
    const playback = new PcmPlayback(ctx as unknown as PcmContext, { rate: RATE, ...shaped });
    playback.enqueue(ramp(800));
    playback.enqueue(ramp(800));
    ctx.currentTime = 0.05;
    const played = playback.flush();
    expect(played).toBe(50);
    expect(ctx.gains[0]?.gain.targets).toEqual([{ target: 0, at: 0.05, constant: 0.004 / 5 }]);
    for (const source of ctx.live) expect(source.stopAt).toBeCloseTo(0.054, 9);
    // The next answer makes a new gain stage at full level; the faded one is left behind.
    playback.enqueue(ramp(800));
    expect(ctx.gains).toHaveLength(2);
    expect(ctx.gains[1]?.gain.value).toBe(1);
  });

  it("a stop with no gain stage, or no fade, stops every source at once", () => {
    const plain = noGain();
    const a = new PcmPlayback(plain as unknown as PcmContext, { rate: RATE, ...shaped });
    a.enqueue(ramp(800));
    a.flush();
    expect(plain.sources.every((s) => s.stopped && s.stopAt === undefined)).toBe(true);
    const gained = new FakeContext(RATE, true);
    const b = new PcmPlayback(gained as unknown as PcmContext, { rate: RATE });
    b.enqueue(ramp(800));
    b.flush();
    expect(gained.sources.every((s) => s.stopped && s.stopAt === undefined)).toBe(true);
    expect(gained.gains[0]?.gain.targets).toEqual([]);
  });

  it("a chunk of an answer that was stopped is refused, joins or not", () => {
    const ctx = noGain();
    const playback = new PcmPlayback(ctx as unknown as PcmContext, { rate: RATE, ...shaped });
    const generation = playback.currentGeneration;
    playback.enqueue(ramp(800), generation);
    playback.flush();
    expect(playback.enqueue(ramp(800), generation)).toBe(false);
    expect(playback.stats().dropped).toBe(1);
  });

  it("the listener hears the samples as placed, and a failing listener cannot stop the join", () => {
    const ctx = noGain();
    const playback = new PcmPlayback(ctx as unknown as PcmContext, { rate: RATE, ...shaped });
    playback.onScheduled(() => {
      throw new Error("listener");
    });
    expect(playback.enqueue(ramp(800))).toBe(true);
    expect(playback.enqueue(ramp(800))).toBe(true);
    expect(playback.lastOverlapMs()).toBe(8);
  });

  it("the pcm round trip of the float path keeps every unshaped sample exact", () => {
    const original = Int16Array.from([-32768, -1, 0, 1, 12345, 32767]);
    expect(Array.from(floatToPcm16(pcm16ToFloat(original)))).toEqual(Array.from(original));
  });
});

describe("backlog and underrun risk", () => {
  it("reports the scheduled but unplayed audio and a risk below the floor", () => {
    const ctx = noGain();
    const playback = new PcmPlayback(ctx as unknown as PcmContext, { rate: RATE });
    expect(playback.backlogMs()).toBe(0);
    expect(playback.underrunRisk()).toBe(false);
    playback.enqueue(ramp(2400)); // 300 ms
    expect(playback.backlogMs()).toBeCloseTo(300, 6);
    expect(playback.underrunRisk()).toBe(false);
    ctx.currentTime = 0.18; // 120 ms left: exactly the floor is not below it
    expect(playback.underrunRisk()).toBe(false);
    ctx.currentTime = 0.19;
    expect(playback.backlogMs()).toBeCloseTo(110, 6);
    expect(playback.underrunRisk()).toBe(true);
    expect(DEFAULT_UNDERRUN_FLOOR_MS).toBe(120);
    expect(playback.underrunRisk(100)).toBe(false);
    playback.flush();
    expect(playback.underrunRisk()).toBe(false);
    expect(playback.backlogMs()).toBe(0);
  });

  it("takes its floor from the options and does not stretch or change the audio", () => {
    const ctx = noGain();
    const playback = new PcmPlayback(ctx as unknown as PcmContext, {
      rate: RATE,
      underrunFloorMs: 400,
    });
    playback.enqueue(ramp(2400));
    expect(playback.underrunRisk()).toBe(true);
    expect(ctx.sources[0]?.buffer?.length).toBe(2400);
  });

  it("is exposed by the clip player as a getter and a number", () => {
    const ctx = noGain();
    const player = new PcmClipPlayer(ctx as unknown as PcmContext, { underrunFloorMs: 200 });
    expect(player.underrunRisk).toBe(false);
    player.start(ramp(800), RATE);
    expect(player.backlogMs()).toBeCloseTo(100, 6);
    expect(player.underrunRisk).toBe(true);
  });
});

describe("the clip player with joins", () => {
  const timers = () => ({
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined,
  });

  it("joins the clauses of an answer and keeps every clause's span and played time exact", () => {
    const ctx = noGain();
    const player = new PcmClipPlayer(ctx as unknown as PcmContext, {
      join: true,
      timers: timers(),
    });
    const one = player.start(ramp(800), RATE);
    const two = player.start(ramp(800), RATE);
    expect(one.overlapMs).toBe(0);
    expect(two.overlapMs).toBe(8);
    expect(one.span).toEqual({ startMs: 0, endMs: 100 });
    expect(two.span).toEqual({ startMs: 92, endMs: 192 });
    ctx.currentTime = 0.142;
    expect(two.playedMs()).toBeCloseTo(50, 6);
    expect(player.playedMs()).toBeCloseTo(142, 6);
    // The text record cuts at the clause that was heard to its end.
    const tracker = new PlayedTextTracker(() => 0);
    tracker.begin("r");
    tracker.startClip("One clause.", one.durationMs, undefined, 0, one.span);
    tracker.startClip("Two clauses.", two.durationMs, undefined, 0, two.span);
    expect(tracker.heardAtMs(100).text).toBe("One clause.");
    expect(tracker.heardAtMs(191).text).toBe("One clause.");
    expect(tracker.heardAtMs(192).text).toBe("One clause. Two clauses.");
  });

  it("a pause is silence: the next clause starts after it and its played time counts from there", () => {
    const ctx = noGain();
    const player = new PcmClipPlayer(ctx as unknown as PcmContext, {
      join: true,
      timers: timers(),
    });
    player.start(ramp(800), RATE);
    const two = player.start(ramp(800), RATE, 1, { gapMs: 60 });
    expect(two.overlapMs).toBe(0);
    expect(two.span).toEqual({ startMs: 160, endMs: 260 });
    ctx.currentTime = 0.16;
    expect(two.playedMs()).toBeCloseTo(0, 6);
    ctx.currentTime = 0.21;
    expect(two.playedMs()).toBeCloseTo(50, 6);
  });

  it("without the join option the butt joint and the start times are today's", () => {
    const ctx = noGain();
    const player = new PcmClipPlayer(ctx as unknown as PcmContext, { timers: timers() });
    player.start(ramp(800), RATE);
    const two = player.start(ramp(800), RATE);
    expect(two.overlapMs).toBe(0);
    expect(two.span).toEqual({ startMs: 100, endMs: 200 });
    expect(ctx.sources.map((s) => s.when)).toEqual([0, 0.1]);
  });
});

describe("one playback rate: the context's", () => {
  const sources = [22_050, 24_000, 44_100, 48_000];

  it.each(sources)(
    "plays a %i Hz clause on a context of every rate with the right length",
    (src) => {
      for (const target of sources) {
        const ctx = noGain(target);
        const player = new PcmClipPlayer(ctx as unknown as PcmContext, { join: true });
        const clip = player.start(ramp(Math.round(src / 2), 6000), src); // half a second
        expect(player.rate).toBe(target);
        expect(clip.durationMs).toBeGreaterThan(498);
        expect(clip.durationMs).toBeLessThan(502);
        expect(ctx.sources[0]?.buffer?.length).toBeGreaterThan(0);
        player.dispose();
      }
    },
  );

  it.each(sources)(
    "joins two %i Hz clauses on a 48 kHz context: durations add up less the overlap",
    (src) => {
      const ctx = noGain(48_000);
      const player = new PcmClipPlayer(ctx as unknown as PcmContext, { join: true });
      const one = player.start(ramp(src), src, 1); // one second
      const two = player.start(ramp(src), src, 1);
      expect(two.overlapMs).toBe(8);
      expect(one.durationMs + two.durationMs - two.overlapMs).toBeCloseTo(
        (two.span?.endMs ?? 0) - (one.span?.startMs ?? 0),
        1,
      );
      expect(player.backlogMs()).toBeCloseTo(1992, 0);
    },
  );

  it("uses one named fallback only when the context reports no usable rate", () => {
    expect(playRate({ sampleRate: 22_050 })).toBe(22_050);
    expect(playRate({})).toBe(PCM_FALLBACK_RATE);
    expect(playRate({ sampleRate: 0 })).toBe(PCM_FALLBACK_RATE);
    expect(playRate({ sampleRate: Number.NaN })).toBe(PCM_FALLBACK_RATE);
  });
});
