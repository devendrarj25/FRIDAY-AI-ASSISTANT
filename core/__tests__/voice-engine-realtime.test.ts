import { describe, expect, it } from "vitest";
import {
  createRealtimeVoice,
  type RealtimeVoiceDeps,
  type RealtimeVoiceRequest,
} from "../../src/lib/friday/voice-engine/realtime-voice";
import {
  PcmPlayback,
  type ContextLike,
} from "../../src/lib/friday/voice-engine/playback-scheduler";
import {
  base64ToPcm16,
  floatToPcm16,
  pcm16ToBase64,
  pcm16ToFloat,
} from "../../src/lib/friday/voice-engine/audio-format";
import {
  DEFAULT_CLOUD_SETTINGS,
  UsageLedger,
  type VoiceCloudSettings,
} from "../../src/lib/friday/voice-engine/voice-provider-router";

const gate = {
  engine: "cloud-realtime" as const,
  url: "wss://x/realtime",
  surface: "auto" as const,
  paused: false,
  paidAccess: true,
  cloudKey: true,
  privacyMode: false,
  sessionConsent: true,
  halted: false,
};

const cloud: VoiceCloudSettings = {
  ...DEFAULT_CLOUD_SETTINGS,
  cloudEnabled: true,
  allowedProviders: ["openai"],
  keyPresent: { openai: true },
  dailyRequests: 5,
  monthlyRequests: 50,
  monthlyAudioMinutes: 30,
  paidAllowed: true,
  paidApproved: true,
  spendLimitUsd: 2,
};

function rig(over: { ok?: boolean; maxInflight?: number; settings?: Partial<typeof cloud> } = {}) {
  const sources: { stopped: boolean }[] = [];
  let time = 0;
  const ctx = {
    get currentTime() {
      return time;
    },
    destination: {},
    createBuffer: (_c: number, length: number) => ({ length, copyToChannel: () => undefined }),
    createBufferSource: () => {
      const entry = { stopped: false };
      sources.push(entry);
      return {
        buffer: null,
        connect: () => undefined,
        start: () => undefined,
        stop: () => void (entry.stopped = true),
        onended: null,
      };
    },
  } as unknown as ContextLike;
  const playback = new PcmPlayback(ctx, { rate: 24_000 });
  const ledger = new UsageLedger(() => Date.parse("2026-05-05T10:00:00Z"));
  let tap: (s: ArrayLike<number>, rate: number, at: number) => void = () => undefined;
  let unsubscribed = false;
  const sentAudio: string[] = [];
  const release: (() => void)[] = [];
  let startInput: Parameters<RealtimeVoiceDeps["start"]>[0] | null = null;
  let stopped = false;
  let clock = 0;
  const deps: RealtimeVoiceDeps = {
    start: async (input) => {
      startInput = input;
      if (over.ok === false) return { ok: false, reasons: ["could not connect"] };
      return {
        ok: true,
        handle: {
          session: () => ({}) as never,
          sendAudio: (b64: string) => {
            sentAudio.push(b64);
            return new Promise<void>((r) => release.push(r));
          },
          bargeIn: async () => undefined,
          stop: async () => void (stopped = true),
        },
      };
    },
    subscribe: (fn) => {
      tap = fn;
      return () => void (unsubscribed = true);
    },
    playback,
    ledger,
    now: () => clock,
    ...(over.maxInflight ? { maxInflight: over.maxInflight } : {}),
  };
  const request = (): RealtimeVoiceRequest => ({
    gate,
    cloud: { provider: "openai", model: "m" },
    settings: { instructions: "x" },
    router: {
      cloud: { ...cloud, ...over.settings },
      privacyMode: false,
      billingAllowsPaid: true,
      online: true,
    },
  });
  return {
    voice: createRealtimeVoice(deps),
    request,
    ledger,
    sentAudio,
    sources,
    playback,
    tick: (ms: number) => (clock += ms),
    setTime: (t: number) => (time = t),
    tap: (s: ArrayLike<number>, rate = 48_000) => tap(s, rate, 0),
    release: () => release.splice(0).forEach((r) => r()),
    input: () => startInput!,
    flags: () => ({ unsubscribed, stopped }),
  };
}

describe("realtime voice session", () => {
  it("refuses a cloud session the router does not allow, without opening anything", async () => {
    for (const settings of [
      { cloudEnabled: false },
      { allowedProviders: [] },
      { keyPresent: {} },
      { paidApproved: false },
      { dailyRequests: 0 },
    ]) {
      const r = rig({ settings });
      const out = await r.voice.start(r.request());
      expect(out.ok).toBe(false);
      expect(r.sentAudio).toEqual([]);
    }
  });

  it("sends microphone frames resampled to 24 kHz PCM16 and counts the request", async () => {
    const r = rig();
    expect(await r.voice.start(r.request())).toEqual({ ok: true });
    r.tap(new Float32Array(4800).fill(0.5), 48_000);
    expect(r.sentAudio).toHaveLength(1);
    const pcm = base64ToPcm16(r.sentAudio[0]!);
    expect(Math.abs(pcm.length - 2400)).toBeLessThanOrEqual(2);
    expect(pcm[10]).toBeGreaterThan(16000);
    expect(r.ledger.usage("openai").day).toBe(1);
  });

  it("drops frames instead of queueing when the provider falls behind", async () => {
    const r = rig({ maxInflight: 2 });
    await r.voice.start(r.request());
    for (let i = 0; i < 5; i += 1) r.tap(new Float32Array(480).fill(0.1));
    expect(r.sentAudio).toHaveLength(2);
    expect(r.voice.stats().droppedFrames).toBe(3);
    r.release();
    await new Promise((res) => setTimeout(res, 0));
    r.tap(new Float32Array(480).fill(0.1));
    expect(r.sentAudio).toHaveLength(3);
  });

  it("sends nothing while muted", async () => {
    const r = rig();
    await r.voice.start(r.request());
    r.voice.setMuted(true);
    r.tap(new Float32Array(480).fill(0.1));
    expect(r.sentAudio).toEqual([]);
    r.voice.setMuted(false);
    r.tap(new Float32Array(480).fill(0.1));
    expect(r.sentAudio).toHaveLength(1);
  });

  it("plays answer audio and flushes the speaker first on a barge-in, returning what was heard", async () => {
    const r = rig();
    await r.voice.start(r.request());
    const answer = pcm16ToBase64(new Int16Array(24_000));
    r.setTime(1);
    r.input().onAudio?.(answer);
    r.setTime(1.4);
    expect(r.playback.audible()).toBe(true);
    expect(r.input().onBargeIn?.()).toBe(400);
    expect(r.sources.every((s) => s.stopped)).toBe(true);
    expect(r.voice.stats().bargeIns).toBe(1);
  });

  it("stops: releases the microphone listener, the speaker and the provider, and adds the minutes", async () => {
    const r = rig();
    let stopReason = "";
    await r.voice.start({ ...r.request(), onStop: (why) => (stopReason = why) });
    r.tick(90_000);
    await r.voice.stop("owner stopped");
    expect(r.flags()).toEqual({ unsubscribed: true, stopped: true });
    expect(r.ledger.usage("openai").audioMinutes).toBeCloseTo(1.5, 5);
    expect(r.voice.stats().running).toBe(false);
    r.tap(new Float32Array(480).fill(0.1));
    expect(r.sentAudio).toEqual([]);
    expect(stopReason).toBe("");
  });

  it("ends when the provider ends, and reports why", async () => {
    const r = rig();
    let stopReason = "";
    await r.voice.start({ ...r.request(), onStop: (why) => (stopReason = why) });
    r.input().onStop?.("the connection closed");
    await new Promise((res) => setTimeout(res, 0));
    expect(stopReason).toBe("the connection closed");
    expect(r.flags().unsubscribed).toBe(true);
  });

  it("returns the reasons when the connection fails and does not stay running", async () => {
    const r = rig({ ok: false });
    expect(await r.voice.start(r.request())).toEqual({ ok: false, reasons: ["could not connect"] });
    expect(r.voice.stats().running).toBe(false);
    expect(r.ledger.usage("openai").day).toBe(0);
  });

  it("refuses a second start while one is running", async () => {
    const r = rig();
    await r.voice.start(r.request());
    expect((await r.voice.start(r.request())).ok).toBe(false);
  });
});

describe("realtime voice recovery", () => {
  function recoverable(starts: ("ok" | "fail")[]) {
    const stops: string[] = [];
    const waits: number[] = [];
    const handles: { stopped: boolean }[] = [];
    const ledger = new UsageLedger(() => Date.parse("2026-05-05T10:00:00Z"));
    let i = 0;
    let lastStop: ((reason: string) => void) | undefined;
    const ctx = {
      currentTime: 0,
      destination: {},
      createBuffer: () => ({ copyToChannel: () => undefined }),
      createBufferSource: () => ({
        buffer: null,
        connect: () => undefined,
        start: () => undefined,
        stop: () => undefined,
        onended: null,
      }),
    } as unknown as ContextLike;
    const voice = createRealtimeVoice({
      start: async (input) => {
        lastStop = input.onStop;
        const mode = starts[i++] ?? "fail";
        if (mode === "fail") return { ok: false, reasons: ["offline"] };
        const h = { stopped: false };
        handles.push(h);
        return {
          ok: true,
          handle: {
            session: () => ({}) as never,
            sendAudio: async () => undefined,
            bargeIn: async () => undefined,
            stop: async () => void (h.stopped = true),
          },
        };
      },
      subscribe: () => () => undefined,
      playback: new PcmPlayback(ctx, { rate: 24_000 }),
      ledger,
      now: () => 0,
      recovery: { max: 2, baseMs: 100, sleep: async (ms) => void waits.push(ms) },
    });
    const request: RealtimeVoiceRequest = {
      gate,
      cloud: { provider: "openai", model: "m" },
      settings: { instructions: "x" },
      router: { cloud, privacyMode: false, billingAllowsPaid: true, online: true },
      onStop: (why) => stops.push(why),
    };
    return {
      voice,
      request,
      stops,
      waits,
      handles,
      ledger,
      drop: (why: string) => lastStop?.(why),
    };
  }

  it("reconnects after a drop with a doubling wait, counting each connection as a request", async () => {
    const r = recoverable(["ok", "ok"]);
    await r.voice.start(r.request);
    r.drop("the connection closed");
    await new Promise((res) => setTimeout(res, 5));
    expect(r.waits).toEqual([100]);
    expect(r.handles.map((h) => h.stopped)).toEqual([true, false]);
    expect(r.voice.stats().running).toBe(true);
    expect(r.ledger.usage("openai").day).toBe(2);
    expect(r.stops).toEqual([]);
  });

  it("gives up after the bounded number of tries and says why", async () => {
    const r = recoverable(["ok", "fail", "fail"]);
    await r.voice.start(r.request);
    r.drop("the connection closed");
    await new Promise((res) => setTimeout(res, 5));
    expect(r.stops.at(-1)).toMatch(/reconnect refused: offline/);
    expect(r.voice.stats().running).toBe(false);
  });

  it("does not reconnect when the owner stopped it", async () => {
    const r = recoverable(["ok", "ok"]);
    await r.voice.start(r.request);
    await r.voice.stop("owner stopped");
    expect(r.waits).toEqual([]);
    expect(r.handles).toHaveLength(1);
  });

  it("does not reconnect when the router now refuses (quota used up)", async () => {
    const r = recoverable(["ok", "ok"]);
    await r.voice.start({
      ...r.request,
      router: { ...r.request.router, cloud: { ...cloud, dailyRequests: 1 } },
    });
    r.drop("the connection closed");
    await new Promise((res) => setTimeout(res, 5));
    expect(r.stops.at(-1)).toMatch(/reconnect refused: daily quota/);
    expect(r.handles).toHaveLength(1);
  });
});

describe("realtime voice with the echo canceller", () => {
  const RATE = 24_000;

  function echoRig(withEcho: boolean) {
    // Everything on one clock in seconds: the audio clock equals the microphone clock.
    let ctxTime = 0;
    const scheduled: { when: number; pcm: Int16Array }[] = [];
    const context = {
      get currentTime() {
        return ctxTime;
      },
      destination: {},
      createBuffer: (_c: number, length: number) => ({ length, copyToChannel: () => undefined }),
      createBufferSource: () => ({
        buffer: null,
        connect: () => undefined,
        start: () => undefined,
        stop: () => undefined,
        onended: null,
      }),
    } as unknown as ContextLike;
    const playback = new PcmPlayback(context, { rate: RATE, maxQueuedMs: 8000 });
    const sent: Int16Array[] = [];
    let tap: (s: ArrayLike<number>, rate: number, at: number) => void = () => undefined;
    const voice = createRealtimeVoice({
      start: async () => ({
        ok: true,
        handle: {
          session: () => ({}) as never,
          sendAudio: async (b64: string) => void sent.push(base64ToPcm16(b64)),
          bargeIn: async () => undefined,
          stop: async () => undefined,
        },
      }),
      subscribe: (fn) => {
        tap = fn;
        return () => undefined;
      },
      playback,
      ledger: new UsageLedger(() => Date.parse("2026-05-05T10:00:00Z")),
      maxInflight: 1000,
      ...(withEcho ? { echo: { contextToMono: (s: number) => s * 1000 } } : {}),
    });
    return {
      voice,
      playback,
      sent,
      scheduled,
      setTime: (t: number) => (ctxTime = t),
      tap: (s: ArrayLike<number>, at: number) => tap(s, RATE, at),
    };
  }

  /** Answer audio the model "speaks", then the microphone hears it back 80 ms late and quieter. */
  async function simulate(withEcho: boolean) {
    const r = echoRig(withEcho);
    expect(
      (
        await r.voice.start({
          gate,
          cloud: { provider: "openai", model: "m" },
          settings: { instructions: "x" },
          router: { cloud, privacyMode: false, billingAllowsPaid: true, online: true },
        })
      ).ok,
    ).toBe(true);
    const seconds = 8;
    const total = seconds * RATE;
    let s = 99;
    const rand = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0xffffffff - 0.5;
    const far = new Float32Array(total);
    let lp = 0;
    for (let i = 0; i < total; i += 1) {
      const t = i / RATE;
      lp = lp * 0.55 + rand() * 0.9;
      far[i] = lp * Math.max(0, Math.sin(2 * Math.PI * 3.2 * t)) * 0.9;
    }
    const delay = Math.round(0.08 * RATE);
    const micFrame = 480; // 20 ms
    let scheduledTo = 0;
    for (let at = 0; at < total; at += micFrame) {
      const now = at / RATE;
      r.setTime(now);
      // the model's audio is always about 400 ms ahead of the speaker
      while (scheduledTo < Math.min(total, at + Math.round(0.4 * RATE))) {
        const end = Math.min(total, scheduledTo + 4800);
        r.playback.enqueue(floatToPcm16(far.subarray(scheduledTo, end)));
        scheduledTo = end;
      }
      const frame = new Float32Array(micFrame);
      for (let i = 0; i < micFrame; i += 1) {
        const j = at + i - delay;
        frame[i] = j >= 0 ? 0.5 * far[j]! : 0;
      }
      r.tap(frame, now * 1000 + (micFrame / RATE) * 1000);
    }
    const flat = Float32Array.from(r.sent.flatMap((p) => [...pcm16ToFloat(p)]));
    return { flat, stats: r.voice.stats() };
  }

  const power = (a: Float32Array, from: number, to: number) => {
    let acc = 0;
    for (let i = from; i < to; i += 1) acc += a[i]! * a[i]!;
    return acc / Math.max(1, to - from);
  };

  it("sends far less of FRIDAY's own voice with the canceller on than with it off", async () => {
    const off = await simulate(false);
    const on = await simulate(true);
    const from = 6 * RATE;
    const to = 8 * RATE - 480;
    //
    const reduction = 10 * Math.log10(power(off.flat, from, to) / power(on.flat, from, to));
    expect(reduction).toBeGreaterThan(12);
    expect(on.stats.echo).not.toBeNull();
    expect(off.stats.echo).toBeNull();
  });

  it("keeps the canceller running while frames are muted, so it is ready the moment sending resumes", async () => {
    const r = echoRig(true);
    await r.voice.start({
      gate,
      cloud: { provider: "openai", model: "m" },
      settings: { instructions: "x" },
      router: { cloud, privacyMode: false, billingAllowsPaid: true, online: true },
    });
    r.voice.setMuted(true);
    r.tap(new Float32Array(480).fill(0.1), 20);
    expect(r.sent).toEqual([]);
    expect(r.voice.stats().echo?.erleDb).toBeNull();
  });
});
