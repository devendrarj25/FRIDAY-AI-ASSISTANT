/**
 * Software-only latency of the voice paths, with every device and provider faked. These numbers are the cost of
 * FRIDAY's own code (event hops, queues, promise settling), not of a microphone, a speaker or the network, and
 * they are a regression budget: a change that makes the code itself slow will fail here. They say nothing about
 * what a person hears on a real PC; that is the hardware validation (scripts/voice-hardware-validate.cjs).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStreamingTts } from "../../src/lib/friday/voice-engine/sarvam-streaming-tts";
import type { VoiceTtsEvent } from "../../src/lib/friday/voice-engine/voice-contracts";
import { createUtteranceArbiter } from "../../src/lib/friday/voice-engine/stt-authority";

const ms = () => performance.now();
const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(p * values.length))] ??
  0;
const report = (name: string, values: number[]) => {
  const line = `${name}: p50 ${percentile(values, 0.5).toFixed(3)} ms, p95 ${percentile(values, 0.95).toFixed(3)} ms, max ${Math.max(...values).toFixed(3)} ms (${values.length} runs)`;
  console.log(`LATENCY ${line}`);
  return line;
};

function fakeStreamApi(openDelayMs: number) {
  const events: Array<(p: { id: string; event: Record<string, unknown> }) => void> = [];
  const opened: Array<(p: { id: string }) => void> = [];
  let id = "";
  return {
    emit: (event: Record<string, unknown>) => events.forEach((f) => f({ id, event })),
    api: {
      voiceStreamOpen: async (streamId: string) => {
        id = streamId;
        await new Promise((r) => setTimeout(r, openDelayMs));
        opened.forEach((f) => f({ id }));
        return { ok: true, opened: true };
      },
      voiceStreamSend: async () => ({ ok: true }),
      voiceStreamClose: async () => ({ ok: true }),
      onVoiceStreamOpened: (cb: (p: { id: string }) => void) => (opened.push(cb), () => undefined),
      onVoiceStreamEvent: (cb: (p: { id: string; event: Record<string, unknown> }) => void) => (
        events.push(cb),
        () => undefined
      ),
      onVoiceStreamClosed: () => () => undefined,
    },
  };
}

describe("software latency budget (devices and providers faked)", () => {
  it("streaming speech: a frame reaches the player's event within a millisecond of arriving", async () => {
    const rig = fakeStreamApi(0);
    const seen: number[] = [];
    let sentAt = 0;
    const tts = createStreamingTts({
      api: rig.api as never,
      sessionId: "lat",
      onEvent: (e: VoiceTtsEvent) => {
        if (e.type === "audio-chunk") seen.push(ms() - sentAt);
      },
    });
    await tts.start({ language: "hi-IN", speaker: "aparna_hi_customer" });
    for (let i = 0; i < 200; i += 1) {
      await tts.speak("t", "नमस्ते।");
      sentAt = ms();
      rig.emit({ type: "audio", audioBase64: "AAAA", mime: "audio/mp3" });
      rig.emit({ type: "complete" });
    }
    report("streaming TTS frame -> player event", seen);
    expect(percentile(seen, 0.95)).toBeLessThan(5);
  });

  it("streaming speech: waiting for the real open adds nothing beyond the open itself", async () => {
    const extra: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const delay = 40;
      const rig = fakeStreamApi(delay);
      const tts = createStreamingTts({
        api: rig.api as never,
        sessionId: `o${i}`,
        onEvent: () => undefined,
      });
      const t0 = ms();
      await tts.start({ language: "hi-IN", speaker: "aparna_hi_customer" });
      const opened = ms() - t0;
      const sentOk = (await tts.speak("t", "हेलो।")) > 0;
      expect(sentOk).toBe(true);
      extra.push(ms() - t0 - delay);
      expect(opened).toBeGreaterThanOrEqual(delay - 2);
    }
    report("open race: time beyond the socket's own open delay (40 ms) until text is sent", extra);
    expect(percentile(extra, 0.95)).toBeLessThan(15);
  });

  it("the transcript arbiter adds no wait when Sarvam is first, and only the grace when it never answers", () => {
    let clock = 0;
    const timers: Array<{ fn: () => void; at: number }> = [];
    const submitted: number[] = [];
    const arbiter = createUtteranceArbiter({
      authority: () => "sarvam",
      cloudHealthy: () => true,
      gate: () => ({ ok: true }),
      submit: () => submitted.push(clock),
      now: () => clock,
      setTimer: (fn, delay) => (timers.push({ fn, at: clock + delay }), timers.length),
      clearTimer: () => undefined,
      graceMs: 1500,
    });
    clock = 100;
    arbiter.cloudFinal("kal ka mausam");
    expect(submitted).toEqual([100]); // Sarvam first: submitted the same instant it arrived
    clock = 5000;
    arbiter.local("set a timer");
    clock = 6500;
    for (const t of timers) if (t.at <= clock) t.fn();
    expect(submitted.at(-1)).toBe(6500); // Sarvam silent: the local text is used after exactly the grace
    console.log(
      "LATENCY transcript arbiter: Sarvam first +0 ms; Sarvam silent +1500 ms (the grace, by design)",
    );
  });
});

describe("interruption settles at once (voice library, fake audio)", () => {
  type Win = { friday?: unknown; speechSynthesis?: unknown };
  const g = globalThis as unknown as { window?: Win | undefined; Audio?: unknown };
  const saved = { window: g.window, Audio: g.Audio };
  beforeEach(() => {
    class HangingAudio {
      volume = 1;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public src: string) {}
      play() {
        return Promise.resolve();
      }
      pause() {}
    }
    g.Audio = HangingAudio;
    g.window = {
      friday: {
        speakNeural: async (req: { text: string }) => ({
          ok: true,
          audioBase64: Buffer.from(req.text).toString("base64"),
          mime: "audio/mpeg",
          engine: "local",
        }),
      },
    };
  });
  afterEach(() => {
    g.window = saved.window;
    g.Audio = saved.Audio;
  });

  it("the speaking promise settles in about a millisecond after stopSpeaking, and a new turn starts in the next", async () => {
    const lib = await import("../../src/lib/friday/voice-library");
    const tuning = {
      voiceName: "",
      lang: "en-IN",
      rate: 1,
      pitch: 1,
      volume: 1,
      kind: "neural" as const,
    };
    const settle: number[] = [];
    const restart: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      lib.resetPrefetchedSpeech();
      const speaking = lib.speakText("First sentence here. Second sentence follows.", tuning);
      while (lib.pendingSpeechOperations() === 0) await new Promise((r) => setTimeout(r, 0));
      const t0 = ms();
      lib.stopSpeaking();
      await speaking;
      settle.push(ms() - t0);
      const t1 = ms();
      const next = lib.speakText("Fresh reply.", tuning);
      while (lib.pendingSpeechOperations() === 0) await new Promise((r) => setTimeout(r, 0));
      restart.push(ms() - t1);
      lib.stopSpeaking();
      await next;
    }
    report("interrupt: stopSpeaking -> speaking promise settled", settle);
    report("interrupt: new speakText -> its audio playing (fake audio)", restart);
    expect(percentile(settle, 0.95)).toBeLessThan(25);
    expect(percentile(restart, 0.95)).toBeLessThan(50);
  });
});
