import { describe, expect, it } from "vitest";
import {
  base64ToPcm16,
  downmixToMono,
  floatToPcm16,
  pcm16ToBase64,
  pcm16ToFloat,
  samplesToMs,
  StreamResampler,
} from "../../src/lib/friday/voice-engine/audio-format";
import {
  PcmPlayback,
  type ContextLike,
  type SourceLike,
} from "../../src/lib/friday/voice-engine/playback-scheduler";
import {
  captureTapCount,
  noteCaptureFrame,
  subscribeCaptureFrames,
} from "../../src/lib/friday/pcm-capture";

describe("audio format", () => {
  it("round-trips PCM16 and clamps out-of-range samples", () => {
    const pcm = floatToPcm16([0, 0.5, -0.5, 1, -1, 2, -3]);
    expect([...pcm]).toEqual([0, 16384, -16384, 32767, -32768, 32767, -32768]);
    const back = pcm16ToFloat(pcm);
    expect(back[1]).toBeCloseTo(0.5, 3);
    expect(back[4]).toBeCloseTo(-1, 5);
  });

  it("round-trips base64 and ignores a stray odd byte", () => {
    const pcm = Int16Array.from([1, -2, 300, -32768, 32767]);
    expect([...base64ToPcm16(pcm16ToBase64(pcm))]).toEqual([...pcm]);
    expect(base64ToPcm16(btoa("abc")).length).toBe(1);
    expect(base64ToPcm16("").length).toBe(0);
  });

  it("encodes a large frame without overflowing the call stack", () => {
    const big = new Int16Array(200_000).fill(7);
    expect(base64ToPcm16(pcm16ToBase64(big)).length).toBe(200_000);
  });

  it("mixes stereo to mono explicitly", () => {
    expect([
      ...downmixToMono([
        [1, 0, -1],
        [0, 0, 1],
      ]),
    ]).toEqual([0.5, 0, 0]);
    expect(downmixToMono([]).length).toBe(0);
    expect([...downmixToMono([[0.25, 0.5]])]).toEqual([0.25, 0.5]);
  });

  it("downsamples 48k to 24k with the right length, in any frame size", () => {
    const rate = 48_000;
    const signal = Float32Array.from({ length: 4800 }, (_, i) =>
      Math.sin((2 * Math.PI * 440 * i) / rate),
    );
    const whole = new StreamResampler(rate, 24_000).push(signal);
    expect(Math.abs(whole.length - 2400)).toBeLessThanOrEqual(2);
    const parts = new StreamResampler(rate, 24_000);
    const joined: number[] = [];
    for (let at = 0; at < signal.length; at += 480)
      joined.push(...parts.push(signal.subarray(at, at + 480)));
    expect(Math.abs(joined.length - whole.length)).toBeLessThanOrEqual(2);
    for (let i = 0; i < Math.min(joined.length, whole.length) - 2; i += 1) {
      expect(joined[i]).toBeCloseTo(whole[i]!, 3);
    }
  });

  it("upsamples 16k to 24k and keeps a sine's shape", () => {
    const signal = Float32Array.from({ length: 1600 }, (_, i) =>
      Math.sin((2 * Math.PI * 200 * i) / 16_000),
    );
    const out = new StreamResampler(16_000, 24_000).push(signal);
    expect(Math.abs(out.length - 2400)).toBeLessThanOrEqual(2);
    expect(Math.max(...out)).toBeGreaterThan(0.95);
  });

  it("passes the same rate through and refuses a bad rate", () => {
    expect([...new StreamResampler(24_000, 24_000).push([0.1, 0.2])]).toEqual([
      expect.closeTo(0.1, 5),
      expect.closeTo(0.2, 5),
    ]);
    expect(() => new StreamResampler(0, 24_000)).toThrow();
    expect(samplesToMs(24_000, 24_000)).toBe(1000);
  });
});

function fakeContext() {
  const started: { when: number; length: number; stopped: boolean }[] = [];
  const ctx = {
    currentTime: 0,
    destination: {},
    createBuffer: (_c: number, length: number) => ({ length, copyToChannel: () => undefined }),
    createBufferSource: () => {
      const entry = { when: -1, length: 0, stopped: false };
      started.push(entry);
      const source: SourceLike = {
        buffer: null,
        connect: () => undefined,
        start: (when = 0) => {
          entry.when = when;
          entry.length = (source.buffer as { length: number }).length;
        },
        stop: () => void (entry.stopped = true),
        onended: null,
      };
      return source;
    },
  } as unknown as ContextLike & { currentTime: number };
  return { ctx, started };
}

describe("PcmPlayback", () => {
  const chunk = (ms: number) => new Int16Array((24_000 * ms) / 1000);

  it("places chunks back to back with no gap", () => {
    const { ctx, started } = fakeContext();
    const p = new PcmPlayback(ctx, { rate: 24_000 });
    ctx.currentTime = 1;
    p.enqueue(chunk(100));
    p.enqueue(chunk(100));
    expect(started.map((s) => s.when)).toEqual([1, 1.1]);
    expect(p.queuedMs()).toBeCloseTo(200, 0);
  });

  it("bounds the queue and counts what it refuses", () => {
    const { ctx } = fakeContext();
    const p = new PcmPlayback(ctx, { rate: 24_000, maxQueuedMs: 300 });
    expect(p.enqueue(chunk(200))).toBe(true);
    expect(p.enqueue(chunk(200))).toBe(false);
    expect(p.stats().dropped).toBe(1);
  });

  it("flush stops everything audible and reports what was played", () => {
    const { ctx, started } = fakeContext();
    const p = new PcmPlayback(ctx, { rate: 24_000 });
    ctx.currentTime = 2;
    p.enqueue(chunk(500));
    p.enqueue(chunk(500));
    ctx.currentTime = 2.3;
    expect(p.audible()).toBe(true);
    expect(p.flush()).toBe(300);
    expect(started.every((s) => s.stopped)).toBe(true);
    expect(p.audible()).toBe(false);
    expect(p.playedMs()).toBe(0);
    ctx.currentTime = 3;
    p.enqueue(chunk(100));
    expect(started.at(-1)?.when).toBe(3);
  });

  it("counts an underrun when the queue ran dry before the next chunk", () => {
    const { ctx, started } = fakeContext();
    const p = new PcmPlayback(ctx, { rate: 24_000 });
    ctx.currentTime = 0;
    p.enqueue(chunk(100));
    started[0]!.stopped = false;
    // the source ended
    (p as unknown as { sources: Set<unknown> }).sources.clear();
    ctx.currentTime = 0.5;
    p.enqueue(chunk(100));
    expect(p.stats().underruns).toBe(1);
    expect(started.at(-1)?.when).toBe(0.5);
  });

  it("ignores an empty chunk", () => {
    const { ctx, started } = fakeContext();
    expect(new PcmPlayback(ctx, { rate: 24_000 }).enqueue(new Int16Array())).toBe(true);
    expect(started).toEqual([]);
  });
});

describe("capture tap on the one microphone", () => {
  it("hears every frame, can be removed, and a failing listener cannot stop capture", () => {
    const heard: number[] = [];
    const off = subscribeCaptureFrames((s) => heard.push(s.length));
    const bad = subscribeCaptureFrames(() => {
      throw new Error("boom");
    });
    const before = captureTapCount();
    expect(() => noteCaptureFrame(new Float32Array(128), 1, 48_000)).not.toThrow();
    expect(heard).toEqual([128]);
    expect(captureTapCount()).toBe(before - 1);
    off();
    noteCaptureFrame(new Float32Array(64), 2, 48_000);
    expect(heard).toEqual([128]);
    bad();
  });

  it("allows only a few listeners", () => {
    const offs: (() => void)[] = [];
    expect(() => {
      for (let i = 0; i < 10; i += 1) offs.push(subscribeCaptureFrames(() => undefined));
    }).toThrow(/too many/);
    offs.forEach((o) => o());
    expect(captureTapCount()).toBe(0);
  });
});

import { LatencyMonitor, turnDurations } from "../../src/lib/friday/voice-engine/latency-monitor";
import {
  beginVoiceTurn,
  markTurnStage,
  resetVoiceTurns,
} from "../../src/lib/friday/voice-turn-trace";
import { voiceLatency } from "../../src/lib/friday/voice-engine/latency-monitor";

describe("latency monitor", () => {
  it("reports nothing when nothing was measured and never invents a value", () => {
    const m = new LatencyMonitor();
    expect(m.summary("heardToSpoken")).toBeNull();
    expect(m.line()).toBe("no finished turn measured yet");
    m.record("x", Number.NaN);
    m.record("x", -5);
    expect(m.summary("x")).toBeNull();
  });

  it("computes nearest-rank percentiles and keeps a bounded window", () => {
    const m = new LatencyMonitor();
    for (let i = 1; i <= 100; i += 1) m.record("t", i * 10);
    expect(m.summary("t")).toMatchObject({ count: 100, p50: 500, p95: 950, last: 1000, max: 1000 });
    for (let i = 0; i < 50; i += 1) m.record("t", 5);
    expect(m.summary("t")?.count).toBe(100);
  });

  it("measures only stages that really ran", () => {
    const rows = (spec: [string, number, boolean][]) => ({
      startedAt: 0,
      rows: spec.map(([stage, at, ok]) => ({
        stage: stage as never,
        at,
        ok,
        reason: "",
        detail: "",
      })),
    });
    expect(
      turnDurations(
        rows([
          ["heard", 100, true],
          ["routed", 150, true],
          ["model", 400, true],
          ["reply", 900, true],
          ["spoken", 1200, true],
        ]),
      ),
    ).toEqual({
      heardToRouted: 50,
      routedToModel: 250,
      modelToReply: 500,
      replyToSpoken: 300,
      heardToSpoken: 1100,
    });
    expect(
      turnDurations(
        rows([
          ["heard", 100, true],
          ["routed", 150, false],
        ]),
      ),
    ).toEqual({});
  });

  it("learns from finished turns of the real turn trace", () => {
    resetVoiceTurns();
    voiceLatency.reset();
    beginVoiceTurn(1000);
    markTurnStage("heard", true, "", "", 1000);
    markTurnStage("routed", true, "", "", 1040);
    markTurnStage("spoken", true, "", "", 2100);
    beginVoiceTurn(5000);
    expect(voiceLatency.summary("heardToSpoken")).toMatchObject({ count: 1, last: 1100 });
    resetVoiceTurns();
    voiceLatency.reset();
  });
});
