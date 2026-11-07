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
import { pcm16ToBase64, base64ToPcm16 } from "../../src/lib/friday/voice-engine/audio-format";
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
  let release: (() => void)[] = [];
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
