import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CaptureTap } from "../../src/lib/friday/pcm-capture";
import { StageClock, LatencyMonitor } from "../../src/lib/friday/voice-engine/latency-monitor";
import { createRealtimeStt } from "../../src/lib/friday/voice-engine/sarvam-realtime-stt";
import { createStreamingTts } from "../../src/lib/friday/voice-engine/sarvam-streaming-tts";
import {
  GenerationGuard,
  TurnFinalizer,
  type VoiceTranscriptEvent,
  type VoiceTtsEvent,
} from "../../src/lib/friday/voice-engine/voice-contracts";
import {
  FrameAssembler,
  createWakeFrameFeed,
} from "../../src/lib/friday/voice-engine/voice-frame-assembler";

/** A fake main process: records what the renderer sends and lets a test push provider events back. */
function fakeApi(openResult: { ok: boolean; error?: string } = { ok: true }) {
  const opened: Array<(p: { id: string }) => void> = [];
  const events: Array<(p: { id: string; event: { type: string } }) => void> = [];
  const closed: Array<(p: { id: string; code: number; retry: boolean; reason: string }) => void> =
    [];
  const sent: Array<{ id: string; message: Record<string, unknown> }> = [];
  const opens: Array<{ id: string; kind: string; options: Record<string, unknown> }> = [];
  const closes: string[] = [];
  let hold: (() => void) | null = null;
  const api = {
    voiceStreamOpen: async (id: string, kind: "stt" | "tts", options: Record<string, unknown>) => {
      opens.push({ id, kind, options });
      return openResult;
    },
    voiceStreamSend: async (id: string, message: Record<string, unknown>) => {
      sent.push({ id, message });
      if (hold) await new Promise<void>((r) => (hold = r));
      return { ok: true };
    },
    voiceStreamClose: async (id: string) => {
      closes.push(id);
      return { ok: true };
    },
    onVoiceStreamOpened: (cb: (p: { id: string }) => void) => {
      opened.push(cb);
      return () => void opened.splice(opened.indexOf(cb), 1);
    },
    onVoiceStreamEvent: (cb: (p: { id: string; event: { type: string } }) => void) => {
      events.push(cb);
      return () => void events.splice(events.indexOf(cb), 1);
    },
    onVoiceStreamClosed: (
      cb: (p: { id: string; code: number; retry: boolean; reason: string }) => void,
    ) => {
      closed.push(cb);
      return () => void closed.splice(closed.indexOf(cb), 1);
    },
  };
  return {
    api,
    sent,
    opens,
    closes,
    open: (id: string) => opened.slice().forEach((f) => f({ id })),
    emit: (id: string, event: { type: string } & Record<string, unknown>) =>
      events.slice().forEach((f) => f({ id, event })),
    close: (id: string, retry: boolean, reason = "closed") =>
      closed.slice().forEach((f) => f({ id, code: retry ? 1011 : 1003, retry, reason })),
    stall: () => {
      hold = () => undefined;
    },
    listeners: () => opened.length + events.length + closed.length,
  };
}

const META = { sequence: 1, sampleStart: 0 };
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("turn and generation guards", () => {
  it("hands one final transcript on exactly once", () => {
    const f = new TurnFinalizer();
    expect(f.finalizeOnce("s", "t1")).toBe(true);
    expect(f.finalizeOnce("s", "t1")).toBe(false);
    expect(f.finalizeOnce("s", "t2")).toBe(true);
  });

  it("makes a cancelled generation stale", () => {
    const g = new GenerationGuard();
    const first = g.next();
    expect(g.isCurrent(first)).toBe(true);
    expect(g.cancel()).toBe(first);
    expect(g.isCurrent(first)).toBe(false);
  });
});

describe("realtime speech to text (renderer)", () => {
  async function started(extra: Partial<Parameters<typeof createRealtimeStt>[0]> = {}) {
    const rig = fakeApi();
    const transcripts: VoiceTranscriptEvent[] = [];
    const finals: string[] = [];
    const billed: number[] = [];
    const status: string[] = [];
    const clock = new StageClock(() => 0);
    const stt = createRealtimeStt({
      api: rig.api,
      sessionId: "sess",
      now: () => 100,
      clock,
      onTranscript: (e) => transcripts.push(e),
      onFinalTurn: (e) => finals.push(e.text),
      onBilledSeconds: (s) => billed.push(s),
      onStatus: (s) => status.push(s),
      setTimer: (fn) => {
        fn();
        return 1;
      },
      ...extra,
    });
    const out = await stt.start({ language: "auto", keyterms: ["FRIDAY"] });
    const id = rig.opens[0]!.id;
    rig.open(id);
    return { rig, stt, transcripts, finals, billed, status, clock, id, out };
  }

  it("opens a 16 kHz stream with the owner's options, never a key", async () => {
    const { rig, out } = await started();
    expect(out.ok).toBe(true);
    expect(rig.opens[0]).toMatchObject({
      kind: "stt",
      options: {
        language: "auto",
        model: "saaras:v4",
        streamType: "fast",
        sampleRate: 16000,
        keyterms: ["FRIDAY"],
      },
    });
    expect(JSON.stringify(rig.opens[0])).not.toMatch(/api-subscription|sk-/);
  });

  it("shows partials as provisional, ignores repeats, and finalises one turn once", async () => {
    const { rig, id, transcripts, finals, clock } = await started();
    rig.emit(id, { type: "partial", text: "open" });
    rig.emit(id, { type: "partial", text: "open" }); // same text again
    rig.emit(id, { type: "partial", text: "open chrome", language: "en-IN" });
    rig.emit(id, { type: "final", text: "open chrome", language: "en-IN" });
    rig.emit(id, { type: "final", text: "open chrome" }); // a second final for the next turn
    expect(transcripts.map((t) => [t.type, t.text, t.turnId, t.revision])).toEqual([
      ["partial", "open", "t0", 1],
      ["partial", "open chrome", "t0", 2],
      ["final", "open chrome", "t0", 3],
      ["final", "open chrome", "t1", 1],
    ]);
    expect(finals).toEqual(["open chrome", "open chrome"]);
    expect(clock.at("sttPartialFirstReceived")).toBe(100);
    expect(clock.at("sttFinalReceived")).toBe(100);
  });

  it("does not act on an empty final and reports the billed seconds", async () => {
    const { rig, id, finals, billed } = await started();
    rig.emit(id, { type: "final", text: "  " });
    rig.emit(id, { type: "end", audioSeconds: 7.5 });
    expect(finals).toEqual([]);
    expect(billed).toEqual([7.5]);
  });

  it("resamples 48 kHz capture to 16 kHz PCM16 before it labels it 16 kHz", async () => {
    const { rig, stt } = await started();
    const frame = new Float32Array(4800).map((_, i) => Math.sin(i / 20));
    expect(stt.pushFrame(frame, 48000)).toBe(true);
    await tick();
    const audio = rig.sent.find((s) => s.message["type"] === "audio")!;
    const bytes = Buffer.from(String(audio.message["audioBase64"]), "base64");
    expect(bytes.length / 2).toBeGreaterThan(1590);
    expect(bytes.length / 2).toBeLessThanOrEqual(1601); // 4800 samples at 48 kHz = about 1600 at 16 kHz
  });

  it("bounds the send queue and counts what it drops", async () => {
    const { rig, stt } = await started({ maxInFlight: 2 });
    rig.stall();
    const frame = new Float32Array(480).fill(0.1);
    const taken = [
      stt.pushFrame(frame, 16000),
      stt.pushFrame(frame, 16000),
      stt.pushFrame(frame, 16000),
    ];
    expect(taken).toEqual([true, true, false]);
    expect(stt.stats().dropped).toBe(1);
  });

  it("will not send before the stream is open", async () => {
    const rig = fakeApi();
    const stt = createRealtimeStt({ api: rig.api, sessionId: "s", onTranscript: () => undefined });
    expect(stt.pushFrame(new Float32Array(160), 16000)).toBe(false);
  });

  it("retries a retryable close, but not a refused key or option", async () => {
    const { rig, id, status } = await started({ maxRetries: 2 });
    rig.close(id, true, "internal error");
    await tick();
    expect(status).toContain("retrying");
    expect(rig.opens).toHaveLength(2);
    const next = rig.opens[1]!.id;
    rig.close(next, false, "the key was refused");
    await tick();
    expect(status.at(-1)).toBe("failed");
    expect(rig.opens).toHaveLength(2); // no third attempt
  });

  it("reports a refusal from the main process and stops cleanly", async () => {
    const rig = fakeApi({ ok: false, error: "Keep speech on this PC is on" });
    const status: Array<[string, string | undefined]> = [];
    const stt = createRealtimeStt({
      api: rig.api,
      sessionId: "s",
      onTranscript: () => undefined,
      onStatus: (s, d) => status.push([s, d]),
    });
    const out = await stt.start();
    expect(out).toEqual({ ok: false, error: "Keep speech on this PC is on" });
    expect(status.at(-1)).toEqual(["failed", "Keep speech on this PC is on"]);
    expect(rig.listeners()).toBe(0);
  });

  it("stop closes the stream, removes its listeners and ignores later events", async () => {
    const { rig, stt, id, transcripts } = await started();
    await stt.stop();
    expect(rig.closes).toEqual([id]);
    expect(rig.listeners()).toBe(0);
    rig.emit(id, { type: "partial", text: "late" });
    expect(transcripts).toEqual([]);
  });
});

describe("streaming text to speech (renderer)", () => {
  async function started() {
    const rig = fakeApi();
    const events: VoiceTtsEvent[] = [];
    const guard = new GenerationGuard();
    const clock = new StageClock(() => 5);
    const tts = createStreamingTts({
      api: rig.api,
      sessionId: "sess",
      guard,
      clock,
      now: () => 5,
      onEvent: (e) => events.push(e),
    });
    await tts.start({ language: "hi-IN", speaker: "aparna_hi_customer" });
    const id = rig.opens[0]!.id;
    rig.open(id);
    return { rig, tts, events, guard, clock, id };
  }

  it("sends text then flush, and passes frames on in order with a sequence", async () => {
    const { rig, tts, events, id, clock } = await started();
    const gen = await tts.speak("t1", "नमस्ते। मैं FRIDAY हूँ।");
    expect(gen).toBeGreaterThan(0);
    expect(rig.sent.map((s) => s.message["type"])).toEqual(["text", "flush"]);
    rig.emit(id, { type: "audio", audioBase64: "AAA=", mime: "audio/mp3" });
    rig.emit(id, { type: "audio", audioBase64: "BBB=", mime: "audio/mp3" });
    rig.emit(id, { type: "complete" });
    expect(events.map((e) => e.type)).toEqual([
      "request-started",
      "audio-chunk",
      "audio-chunk",
      "utterance-complete",
    ]);
    const chunks = events.filter((e) => e.type === "audio-chunk") as Array<
      Extract<VoiceTtsEvent, { type: "audio-chunk" }>
    >;
    expect(chunks.map((c) => c.sequence)).toEqual([1, 2]);
    expect(clock.at("ttsRequestStarted")).toBe(5);
    expect(clock.at("ttsFirstAudioReceived")).toBe(5);
    expect(clock.at("playbackFirstSample")).toBeNull(); // a request or a received chunk is not a sound
  });

  it("drops late frames of a cancelled generation and still plays the next unit", async () => {
    const { rig, tts, events, id } = await started();
    await tts.speak("t1", "पहला वाक्य।");
    rig.emit(id, { type: "audio", audioBase64: "AAA=" });
    const old = tts.cancel("t1");
    rig.emit(id, { type: "audio", audioBase64: "LATE" }); // arrives after the cancel
    rig.emit(id, { type: "complete" }); // the cancelled unit finishes at the provider
    const next = await tts.speak("t1", "दूसरा वाक्य।");
    expect(next).not.toBe(old);
    rig.emit(id, { type: "audio", audioBase64: "NEW=" });
    rig.emit(id, { type: "complete" });
    const audio = events.filter((e) => e.type === "audio-chunk") as Array<
      Extract<VoiceTtsEvent, { type: "audio-chunk" }>
    >;
    expect(audio.map((a) => a.audioBase64)).toEqual(["AAA=", "NEW="]);
    expect(events.some((e) => e.type === "cancelled")).toBe(true);
    expect(events.filter((e) => e.type === "utterance-complete")).toHaveLength(1);
  });

  it("classifies a provider error so the caller can fall back at the right place", async () => {
    const { rig, tts, events, id } = await started();
    await tts.speak("t1", "hello");
    rig.emit(id, { type: "error", code: 429, message: "quota" });
    await tts.speak("t1", "again");
    rig.emit(id, { type: "error", code: 401, message: "key" });
    const errors = events.filter((e) => e.type === "error") as Array<
      Extract<VoiceTtsEvent, { type: "error" }>
    >;
    expect(errors.map((e) => [e.category, e.retryable])).toEqual([
      ["quota", false],
      ["auth", false],
    ]);
  });

  it("fails the waiting units as a network error when the socket closes", async () => {
    const { rig, tts, events, id } = await started();
    await tts.speak("t1", "hello");
    rig.close(id, true, "dropped");
    const err = events.find((e) => e.type === "error") as Extract<VoiceTtsEvent, { type: "error" }>;
    expect(err).toMatchObject({ category: "network", retryable: true });
    expect(tts.pending()).toBe(0);
  });

  it("refuses an oversized unit and empty text", async () => {
    const { tts, events } = await started();
    expect(await tts.speak("t1", "   ")).toBe(0);
    expect(await tts.speak("t1", "x".repeat(2501))).toBe(0);
    expect(events.some((e) => e.type === "error" && e.category === "config")).toBe(true);
  });
});

describe("stage clock", () => {
  it("stamps each stage once and measures only gaps that really happened", () => {
    let now = 0;
    const clock = new StageClock(() => now);
    now = 10;
    clock.mark("ttsRequestStarted");
    now = 410;
    clock.mark("ttsFirstAudioReceived");
    now = 500;
    clock.mark("audioFirstDecoded");
    now = 520;
    expect(clock.mark("ttsFirstAudioReceived")).toBe(false); // first stamp wins
    clock.mark("playbackFirstSample");
    expect(clock.durations()).toEqual({ ttsFirstChunk: 400, ttsDecode: 90, firstAudible: 510 });
    const monitor = new LatencyMonitor();
    clock.finish(monitor);
    expect(monitor.summary("ttsFirstChunk")?.last).toBe(400);
    expect(monitor.summary("audibleStop")).toBeNull(); // never measured, never invented
  });

  it("measures the audible stop from the interrupt candidate to the last audible sample", () => {
    const clock = new StageClock(() => 0);
    clock.mark("interruptCandidate", 1000);
    clock.mark("interruptConfirmed", 1150);
    clock.mark("playbackLastAudibleSample", 1210);
    expect(clock.durations()).toEqual({ audibleStop: 210, interruptConfirm: 150 });
  });
});

describe("wake frame feed", () => {
  it("cuts capture frames into 160 ms chunks of 16 kHz PCM16", () => {
    const a = new FrameAssembler(2);
    expect(a.push(new Float32Array(4800), 48000)).toHaveLength(0); // 1600 samples at 16 kHz: not yet 2560
    const chunks = a.push(new Float32Array(9600), 48000); // 3200 more
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    for (const c of chunks) expect(c.length).toBe(2560);
    expect(a.held).toBeLessThan(2560);
  });

  function feed(
    allowed: { on: boolean },
    reply: { ok: boolean; detected?: boolean; score?: number; reason?: string },
  ) {
    const sent: Array<Record<string, unknown>> = [];
    const taps: CaptureTap[] = [];
    const woke: Array<{ score: number; atMono: number }> = [];
    const status: string[] = [];
    const f = createWakeFrameFeed({
      sessionId: "w",
      wakeWord: "friday",
      allowed: () => allowed.on,
      onWake: (i) => woke.push(i),
      onStatus: (s) => status.push(s),
      api: {
        scoreWakeFrames: async (p) => {
          sent.push(p as Record<string, unknown>);
          return { engine: "openwakeword", frames: 2, ...reply };
        },
      },
      subscribe: (tap) => {
        taps.push(tap);
        return () => void taps.splice(taps.indexOf(tap), 1);
      },
    });
    return { f, sent, taps, woke, status };
  }

  it("sends nothing while the policy does not allow listening, and resets the worker when it stops", async () => {
    const allowed = { on: true };
    const { f, sent, taps, status } = feed(allowed, { ok: true, detected: false, score: 0.1 });
    f.start();
    taps[0]!(new Float32Array(2560), 16000, 1, META);
    await tick();
    expect(sent.some((p) => p["pcmBase64"])).toBe(true);
    allowed.on = false; // muted or tray paused
    const before = sent.length;
    taps[0]!(new Float32Array(2560), 16000, 2, META);
    await tick();
    expect(sent.slice(before).every((p) => p["reset"] === true)).toBe(true);
    expect(status).toEqual(["listening", "blocked"]);
  });

  it("reports a wake with its capture time, and only while still allowed", async () => {
    const allowed = { on: true };
    const { f, taps, woke } = feed(allowed, { ok: true, detected: true, score: 0.91 });
    f.start();
    taps[0]!(new Float32Array(2560), 16000, 777, META);
    await tick();
    expect(woke).toEqual([{ score: 0.91, atMono: 777 }]);
  });

  it("says once that live scoring is unavailable and stops sending", async () => {
    const allowed = { on: true };
    const { f, sent, taps, status } = feed(allowed, {
      ok: false,
      reason: "needs an openWakeWord model",
    });
    f.start();
    taps[0]!(new Float32Array(2560), 16000, 1, META);
    await tick();
    taps[0]!(new Float32Array(2560), 16000, 2, META);
    await tick();
    expect(status).toContain("unavailable");
    expect(sent.filter((p) => p["pcmBase64"])).toHaveLength(1);
    expect(f.stats().unavailable).toBe(true);
  });

  it("stop unsubscribes from the capture", () => {
    const { f, taps } = feed({ on: true }, { ok: true });
    f.start();
    expect(taps).toHaveLength(1);
    f.stop();
    expect(taps).toHaveLength(0);
  });
});

describe("streaming speak (clip source)", () => {
  const b64 = (s: string) => btoa(s);

  async function rigStream(
    rest = async () => ({ ok: true, audioBase64: "REST", mime: "audio/wav" }),
  ) {
    const { createStreamingSpeak } =
      await import("../../src/lib/friday/voice-engine/streaming-speak");
    const rig = fakeApi();
    const notes: string[] = [];
    const speaker = createStreamingSpeak({
      api: rig.api as never,
      rest,
      note: (l) => notes.push(l),
      timeoutMs: 20,
      setTimer: (fn, ms) => setTimeout(fn, ms),
    });
    return { rig, speaker, notes };
  }

  it("joins the frames of a clause into one clip and reuses one connection", async () => {
    const { rig, speaker } = await rigStream();
    const request = { text: "नमस्ते।", language: "hi-IN", speaker: "aparna_hi_customer" };
    const first = speaker.speak("sarvam", request);
    await tick();
    const id = rig.opens[0]!.id;
    rig.open(id);
    await tick();
    rig.emit(id, { type: "audio", audioBase64: b64("AB"), mime: "audio/mp3" });
    rig.emit(id, { type: "audio", audioBase64: b64("CD"), mime: "audio/mp3" });
    rig.emit(id, { type: "complete" });
    expect(await first).toEqual({ ok: true, audioBase64: b64("ABCD"), mime: "audio/mp3" });
    const second = speaker.speak("sarvam", { ...request, text: "दूसरा।" });
    await tick();
    rig.emit(id, { type: "audio", audioBase64: b64("EF"), mime: "audio/mp3" });
    rig.emit(id, { type: "complete" });
    expect((await second).audioBase64).toBe(b64("EF"));
    expect(rig.opens).toHaveLength(1); // no new socket for the second clause
  });

  it("opens one stream for two clauses asked at once (the next clause is made while one plays)", async () => {
    const { rig, speaker } = await rigStream();
    const request = { text: "पहला।", language: "hi-IN", speaker: "aparna_hi_customer" };
    const first = speaker.speak("sarvam", request);
    const second = speaker.speak("sarvam", { ...request, text: "दूसरा।" });
    await tick();
    await tick();
    expect(rig.opens).toHaveLength(1); // not two sockets, the second orphaning the first
    rig.open(rig.opens[0]!.id);
    await tick();
    const id = rig.opens[0]!.id;
    rig.emit(id, { type: "audio", audioBase64: b64("ONE"), mime: "audio/mp3" });
    rig.emit(id, { type: "complete" });
    rig.emit(id, { type: "audio", audioBase64: b64("TWO"), mime: "audio/mp3" });
    rig.emit(id, { type: "complete" });
    expect((await first).audioBase64).toBe(b64("ONE"));
    expect((await second).audioBase64).toBe(b64("TWO"));
  });

  it("changes language on the open socket (Hindi then English in one reply) instead of reconnecting", async () => {
    const { rig, speaker } = await rigStream();
    const base = { speaker: "aparna_hi_customer", pace: 1 };
    const first = speaker.speak("sarvam", { ...base, text: "नमस्ते।", language: "hi-IN" });
    await tick();
    const id = rig.opens[0]!.id;
    rig.open(id);
    await tick();
    rig.emit(id, { type: "audio", audioBase64: b64("HI"), mime: "audio/mp3" });
    rig.emit(id, { type: "complete" });
    await first;
    const second = speaker.speak("sarvam", {
      ...base,
      text: "Your report is ready.",
      language: "en-IN",
    });
    await tick();
    await tick();
    expect(rig.opens).toHaveLength(1); // the same socket
    expect(rig.sent.map((m) => m.message["type"])).toEqual([
      "text",
      "flush",
      "config",
      "text",
      "flush",
    ]);
    expect(rig.sent[2]!.message).toMatchObject({ type: "config", language: "en-IN" });
    rig.emit(id, { type: "audio", audioBase64: b64("EN"), mime: "audio/mp3" });
    rig.emit(id, { type: "complete" });
    expect((await second).audioBase64).toBe(b64("EN"));
  });

  it("reopens only for another voice", async () => {
    const { rig, speaker } = await rigStream();
    const run = (speakerName: string) =>
      speaker.speak("sarvam", { text: "x", language: "hi-IN", speaker: speakerName });
    const a = run("aparna_hi_customer");
    await tick();
    rig.open(rig.opens[0]!.id);
    await tick();
    rig.emit(rig.opens[0]!.id, { type: "audio", audioBase64: b64("A"), mime: "audio/mp3" });
    rig.emit(rig.opens[0]!.id, { type: "complete" });
    await a;
    const b = run("ritu_hi_customer");
    await tick();
    await tick();
    expect(rig.opens).toHaveLength(2);
    expect(rig.closes).toHaveLength(1);
    rig.open(rig.opens[1]!.id);
    await tick();
    rig.emit(rig.opens[1]!.id, { type: "audio", audioBase64: b64("B"), mime: "audio/mp3" });
    rig.emit(rig.opens[1]!.id, { type: "complete" });
    expect((await b).audioBase64).toBe(b64("B"));
  });

  it("uses the one-shot call when the voice is not a v4 persona", async () => {
    const { rig, speaker } = await rigStream();
    const out = await speaker.speak("sarvam", {
      text: "hi",
      language: "hi-IN",
      speaker: "anushka",
    });
    expect(out.audioBase64).toBe("REST");
    expect(rig.opens).toHaveLength(0);
  });

  it("falls back to the one-shot call when the stream is refused, errors, or is silent", async () => {
    const refused = await rigStream();
    refused.rig.api.voiceStreamOpen = async () => ({
      ok: false,
      error: "Keep speech on this PC is on",
    });
    expect(
      (
        await refused.speaker.speak("sarvam", {
          text: "hi",
          language: "hi-IN",
          speaker: "aparna_hi_customer",
        })
      ).audioBase64,
    ).toBe("REST");
    expect(refused.notes.join(" ")).toMatch(/not opened/);

    const silent = await rigStream();
    const run = silent.speaker.speak("sarvam", {
      text: "hi",
      language: "hi-IN",
      speaker: "aparna_hi_customer",
    });
    await tick();
    silent.rig.open(silent.rig.opens[0]!.id);
    expect((await run).audioBase64).toBe("REST"); // timed out with no frame
    expect(silent.notes.join(" ")).toMatch(/did not answer/);
  });

  it("is not used for another provider", async () => {
    const { speaker } = await rigStream();
    expect(
      (await speaker.speak("azure-speech", { text: "hi", language: "hi-IN" })).audioBase64,
    ).toBe("REST");
  });
});

describe("live wake wiring keeps the single microphone and the saved policy", () => {
  it("never opens a microphone and obeys mute, pause, speaking and the hands-free setting", async () => {
    const feed = readFileSync("src/lib/friday/voice-engine/voice-frame-assembler.ts", "utf8");
    expect(feed).not.toMatch(/getUserMedia/);
    expect(feed).toMatch(/subscribeCaptureFrames/);
    const assistant = readFileSync("src/lib/friday/assistant-mode.ts", "utf8");
    const gate = assistant.slice(
      assistant.indexOf("private ensureLiveWake"),
      assistant.indexOf("private stopLiveWake"),
    );
    for (const needle of [
      "state.paused",
      "state.muted",
      "state.speaking",
      "state.handsFree",
      "voice.liveWake",
    ])
      expect(gate).toContain(needle);
    expect(assistant).toMatch(
      /private enterAuto\(\) \{\s*this\.armPushToTalk\(\);\s*this\.ensureLiveWake\(\);/,
    );
    expect(assistant).toMatch(/this\.stopLiveWake\(\);/);
  });

  it("ends the cloud caption stream the moment privacy mode or its switches are turned off", () => {
    const text = readFileSync("src/lib/friday/assistant-mode.ts", "utf8");
    const tap = text.slice(
      text.indexOf("this.captionOff = subscribeCaptureFrames"),
      text.indexOf("private async stopCloudCaptions"),
    );
    expect(tap).toContain("live.privacyMode === true");
    expect(tap).toContain("live.cloudVoice.cloudEnabled");
    expect(tap).toContain("live.cloudVoice.streamCaptions");
    expect(tap.indexOf("stopCloudCaptions")).toBeLessThan(tap.indexOf("pushFrame"));
  });

  it("gives the caption recogniser her name and the wake word as vocabulary", () => {
    const text = readFileSync("src/lib/friday/assistant-mode.ts", "utf8");
    const start = text.slice(text.indexOf("const keyterms ="), text.indexOf("if (!opened.ok)"));
    expect(start).toContain("voice.addressName");
    expect(start).toContain("voice.wakeWord");
    expect(start).toContain("keyterms");
  });

  it("stamps the caption stream on the turn clock so the self-test can pass on a real measurement", () => {
    const text = readFileSync("src/lib/friday/assistant-mode.ts", "utf8");
    const make = text.slice(
      text.indexOf("const stt = createRealtimeStt({"),
      text.indexOf("const opened = await stt.start"),
    );
    expect(make).toContain("clock: this.turnStages");
  });

  it("keeps live wake and the cloud paths off by default", async () => {
    const { DEFAULT_VOICE_CLOUD_PREFS } =
      await import("../../src/lib/friday/voice-engine/voice-cloud-settings");
    expect(DEFAULT_VOICE_CLOUD_PREFS.streaming).toBe(false);
    expect(DEFAULT_VOICE_CLOUD_PREFS.streamCaptions).toBe(false);
    const prefs = readDefaultVoice();
    expect(prefs.liveWake).toBe(false);
  });
});

function readDefaultVoice(): { liveWake: boolean } {
  // The default preference object is the source of truth; read its text so this stays a pure check.
  const text = readFileSync("src/lib/friday/preferences.ts", "utf8");
  return { liveWake: /liveWake: true/.test(text) ? true : !/liveWake: false/.test(text) };
}

describe("progressive playback (a clause plays while it arrives)", () => {
  function fakeMedia(supported = true) {
    const log: string[] = [];
    class FakeBuffer {
      updating = false;
      listeners: Array<() => void> = [];
      appended: Uint8Array[] = [];
      appendBuffer(data: Uint8Array) {
        this.appended.push(data);
        this.updating = true;
        queueMicrotask(() => {
          this.updating = false;
          this.listeners.forEach((fn) => fn());
        });
      }
      addEventListener(name: string, fn: () => void) {
        if (name === "updateend") this.listeners.push(fn); // only the write-finished event is simulated
      }
    }
    class FakeSource {
      static isTypeSupported = () => supported;
      readyState = "closed";
      buffer = new FakeBuffer();
      opened: Array<() => void> = [];
      constructor() {
        FakeSource.last = this;
      }
      static last: FakeSource | null = null;
      addSourceBuffer(type: string) {
        log.push(`buffer ${type}`);
        return this.buffer;
      }
      endOfStream() {
        this.readyState = "ended";
        log.push("end");
      }
      addEventListener(_n: string, fn: () => void) {
        this.opened.push(fn);
      }
      open() {
        this.readyState = "open";
        this.opened.forEach((fn) => fn());
      }
    }
    class FakeAudio {
      src = "";
      preload = "";
      addEventListener() {}
    }
    const impl = {
      MediaSource: FakeSource,
      Audio: FakeAudio,
      URL: {
        createObjectURL: () => "blob:fake",
        revokeObjectURL: (u: string) => void log.push(`revoke ${u}`),
      },
    };
    return { impl: impl as never, FakeSource, log };
  }

  it("appends pieces in order, waits for each write, and ends the stream after the last", async () => {
    const { ProgressiveAudio } =
      await import("../../src/lib/friday/voice-engine/progressive-audio");
    const m = fakeMedia();
    const p = new ProgressiveAudio(m.impl);
    p.append(new Uint8Array([1]));
    p.append(new Uint8Array([2])); // arrives before the source is open
    m.FakeSource.last!.open();
    p.append(new Uint8Array([3]));
    p.end();
    await tick();
    await tick();
    expect(m.FakeSource.last!.buffer.appended.map((b) => b[0])).toEqual([1, 2, 3]);
    expect(m.log).toContain("buffer audio/mpeg");
    expect(m.log).toContain("end");
    expect(p.isFailed).toBe(false);
  });

  it("is only used when the browser says it can play mp3 through a media source", async () => {
    const { progressiveSupported } =
      await import("../../src/lib/friday/voice-engine/progressive-audio");
    expect(progressiveSupported(fakeMedia(true).impl)).toBe(true);
    expect(progressiveSupported(fakeMedia(false).impl)).toBe(false);
    expect(progressiveSupported(null)).toBe(false);
  });

  it("hands the player a clip at the first piece and keeps feeding it until the clause completes", async () => {
    const { createStreamingSpeak } =
      await import("../../src/lib/friday/voice-engine/streaming-speak");
    const m = fakeMedia();
    const rig = fakeApi();
    const speaker = createStreamingSpeak({
      api: rig.api as never,
      rest: async () => ({ ok: true, audioBase64: "REST", mime: "audio/wav" }),
      media: m.impl,
      timeoutMs: 50,
    });
    const run = speaker.speak("sarvam", {
      text: "नमस्ते।",
      language: "hi-IN",
      speaker: "aparna_hi_customer",
    });
    await tick();
    const id = rig.opens[0]!.id;
    rig.open(id);
    await tick();
    rig.emit(id, { type: "audio", audioBase64: btoa("AB"), mime: "audio/mp3" });
    const early = await run; // resolved at the first piece, before the clause is complete
    expect(early).toMatchObject({ ok: true, audioBase64: "", mime: "audio/mp3" });
    expect(early.audio).toBeTruthy();
    m.FakeSource.last!.open();
    rig.emit(id, { type: "audio", audioBase64: btoa("CD"), mime: "audio/mp3" });
    rig.emit(id, { type: "complete" });
    await tick();
    await tick();
    expect(m.FakeSource.last!.buffer.appended.map((b) => String.fromCharCode(...b))).toEqual([
      "AB",
      "CD",
    ]);
    expect(m.log).toContain("end");
  });

  it("joins the pieces as before when progressive playback is not available", async () => {
    const { createStreamingSpeak } =
      await import("../../src/lib/friday/voice-engine/streaming-speak");
    const rig = fakeApi();
    const speaker = createStreamingSpeak({
      api: rig.api as never,
      rest: async () => ({ ok: true, audioBase64: "REST", mime: "audio/wav" }),
      media: fakeMedia(false).impl,
      timeoutMs: 50,
    });
    const run = speaker.speak("sarvam", {
      text: "hi",
      language: "hi-IN",
      speaker: "aparna_hi_customer",
    });
    await tick();
    const id = rig.opens[0]!.id;
    rig.open(id);
    await tick();
    rig.emit(id, { type: "audio", audioBase64: btoa("AB"), mime: "audio/mp3" });
    rig.emit(id, { type: "complete" });
    expect(await run).toEqual({ ok: true, audioBase64: btoa("AB"), mime: "audio/mp3" });
  });
});
