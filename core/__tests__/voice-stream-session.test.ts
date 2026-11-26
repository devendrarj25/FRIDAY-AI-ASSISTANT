/**
 * The renderer's streaming-ear session: open, chunked feed, partials into live words, an EndOfTurn endpoint that ends
 * the utterance, and the final text standing in for the decode. A fake bridge, no timers, no microphone.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  STREAM_MAX_CHUNK_MS,
  STREAM_MIN_CHUNK_MS,
  STREAM_RATE,
  SttStreamSession,
  pcm16Base64,
  streamEarlyRead,
  streamLocale,
  streamPartialUpdate,
  streamWanted,
  type StreamBridge,
  type StreamEndpoint,
} from "../../src/lib/friday/voice-engine/stream-session";
import type { LiveWordsUpdate } from "../../src/lib/friday/voice-engine/live-words";

const root = resolve(__dirname, "../..");
const sttSource = readFileSync(resolve(root, "src/lib/friday/voice-stt.ts"), "utf8");
const modeSource = readFileSync(resolve(root, "src/lib/friday/assistant-mode.ts"), "utf8");

const ms = (n: number) => new Float32Array(Math.round((n / 1000) * STREAM_RATE)).fill(0.25);
const flush = () => new Promise((r) => setTimeout(r, 0));

type Feed = { streamId: string; pcm: string };

function fakeBridge(
  script: { events?: (n: number) => { type: string; [k: string]: unknown }[] } = {},
) {
  const calls = {
    open: [] as unknown[],
    feed: [] as Feed[],
    close: [] as unknown[],
    inFlight: 0,
    peak: 0,
  };
  let release: (() => void) | null = null;
  let hold = false;
  const bridge: StreamBridge = {
    openSttStream: async (payload) => {
      calls.open.push(payload);
      return {
        ok: true,
        streamId: payload.streamId || "s1",
        engine: "stream-ear-nemotron",
        chunkMs: 160,
      };
    },
    feedSttStream: async (payload) => {
      calls.feed.push(payload);
      calls.inFlight += 1;
      calls.peak = Math.max(calls.peak, calls.inFlight);
      if (hold) await new Promise<void>((r) => (release = r));
      calls.inFlight -= 1;
      return {
        ok: true,
        events: script.events?.(calls.feed.length) ?? [],
        text: "",
        committed: "",
      };
    },
    closeSttStream: async (payload) => {
      calls.close.push(payload);
      return { ok: true, final: true, text: " कल meeting है ", words: [], audioMs: 1200, rtf: 0.2 };
    },
  };
  return {
    bridge,
    calls,
    holdFeeds: (on: boolean) => {
      hold = on;
    },
    releaseFeed: () => {
      const r = release;
      release = null;
      r?.();
    },
  };
}

const samplesOf = (b64: string) => Buffer.from(b64, "base64").length / 2;

describe("stream-session: plan helpers", () => {
  it("maps the recognition language to a forced locale", () => {
    expect(streamLocale("hi-IN")).toBe("hi");
    expect(streamLocale("en-US")).toBe("en");
    expect(streamLocale("hinglish")).toBe("hi-en");
    expect(streamLocale("hi-Latn")).toBe("hi-en");
    expect(streamLocale("")).toBe("");
    expect(streamLocale("fr-FR")).toBe("");
  });

  it("wants the ear only for a real engine choice; off, absent and junk are off", () => {
    for (const on of ["auto", "nemotron", "stream-ear-nemotron"])
      expect(streamWanted(on)).toBe(true);
    for (const off of ["off", undefined, null, "", "whisper", 1])
      expect(streamWanted(off)).toBe(false);
  });

  it("encodes floats as int16 little-endian base64, clipped", () => {
    const b64 = pcm16Base64(new Float32Array([0, 1, -1, 2, -2, 0.5]));
    const bytes = Buffer.from(b64, "base64");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = Array.from({ length: 6 }, (_, i) => view.getInt16(i * 2, true));
    expect(out).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
  });

  it("turns a kernel partial into the live-words update (committed settled, the rest dim)", () => {
    const update = streamPartialUpdate(
      {
        type: "partial",
        text: "chrome kholo aur",
        committed: "chrome kholo",
        stable: "aur",
        volatile: "",
        revision: 2,
      },
      3,
      "hi",
    );
    expect(update).toEqual({
      settled: "chrome kholo",
      shown: "chrome kholo aur",
      unstable: "aur",
      stable: "aur",
      revision: 2,
      passes: 3,
      language: "hi",
    });
  });
});

describe("stream-session: open, feed, close", () => {
  it("opens local-only with the endpointer, the locale and the hotwords", async () => {
    const fake = fakeBridge();
    const session = new SttStreamSession({ bridge: fake.bridge, streamId: "dictation 1/x" });
    expect(
      await session.open({ streamEngine: "auto", locale: "hi-en", hotwords: ["FRIDAY"] }),
    ).toBe(true);
    expect(fake.calls.open).toEqual([
      {
        streamId: "dictation1x",
        streamEngine: "auto",
        locale: "hi-en",
        hotwords: ["FRIDAY"],
        endpoint: true,
        localOnly: true,
      },
    ]);
    expect(session.state).toBe("open");
    expect(session.live).toBe(true);
  });

  it("feeds 80-320 ms chunks, one request in flight, audio pushed while opening is kept", async () => {
    const fake = fakeBridge();
    const session = new SttStreamSession({ bridge: fake.bridge });
    const opened = session.open({ streamEngine: "nemotron", locale: "en" });
    session.push(ms(100)); // arrives before the open answers
    await opened;
    await flush();
    fake.holdFeeds(true);
    session.push(ms(1000));
    await flush();
    session.push(ms(500));
    await flush();
    fake.holdFeeds(false);
    for (let i = 0; i < 20; i += 1) {
      fake.releaseFeed();
      await flush();
    }
    expect(fake.calls.peak).toBe(1);
    const sizes = fake.calls.feed.map((f) => samplesOf(f.pcm));
    for (const n of sizes) {
      expect(n).toBeGreaterThanOrEqual((STREAM_MIN_CHUNK_MS / 1000) * STREAM_RATE);
      expect(n).toBeLessThanOrEqual((STREAM_MAX_CHUNK_MS / 1000) * STREAM_RATE);
    }
    const final = await session.close();
    const total = fake.calls.feed.reduce((sum, f) => sum + samplesOf(f.pcm), 0);
    expect(total).toBe(ms(1600).length); // nothing lost, nothing sent twice
    expect(final?.text).toBe("कल meeting है");
    expect(fake.calls.close).toEqual([{ streamId: "s1", finalize: true }]);
    expect(session.state).toBe("closed");
  });

  it("partials reach onPartial as live words; EndOfTurn ends the turn, TurnResumed takes it back", async () => {
    const script = (n: number) =>
      n === 1
        ? [{ type: "partial", text: "kal ki", committed: "kal", stable: "ki", volatile: "" }]
        : n === 2
          ? [{ type: "endpoint", event: "EndOfTurn", reason: "silence", silenceMs: 600 }]
          : [{ type: "endpoint", event: "TurnResumed" }];
    const fake = fakeBridge({ events: script });
    const partials: LiveWordsUpdate[] = [];
    const endpoints: StreamEndpoint[] = [];
    const session = new SttStreamSession({
      bridge: fake.bridge,
      onPartial: (u) => partials.push(u),
      onEndpoint: (e) => endpoints.push(e),
    });
    await session.open({ streamEngine: "auto", locale: "hi" });
    session.push(ms(160));
    await flush();
    expect(partials[0]?.settled).toBe("kal");
    expect(partials[0]?.shown).toBe("kal ki");
    expect(session.endOfTurn).toBe(false);
    session.push(ms(160));
    await flush();
    expect(session.endOfTurn).toBe(true);
    expect(endpoints[0]).toEqual({
      event: "EndOfTurn",
      reason: "silence",
      silenceMs: 600,
      audioMs: null,
    });
    session.push(ms(160));
    await flush();
    expect(session.endOfTurn).toBe(false);
  });

  it("the feed reply's endpoint verdict alone also ends the turn", async () => {
    const fake = fakeBridge();
    fake.bridge.feedSttStream = async () => ({
      ok: true,
      events: [],
      endpoint: { event: "EndOfTurn", reason: "eou" },
    });
    const session = new SttStreamSession({ bridge: fake.bridge });
    await session.open({ streamEngine: "auto", locale: "en" });
    session.push(ms(160));
    await flush();
    expect(session.endOfTurn).toBe(true);
  });

  it("the final becomes a transcribe-shaped early read the dictation queue adopts", async () => {
    const read = streamEarlyRead(
      Promise.resolve({
        text: "open chrome",
        words: [],
        audioMs: 900,
        rtf: 0.1,
        engine: "stream-ear-nemotron",
        locale: "en",
      }),
    );
    expect(read.source).toBe("stream");
    expect(await read.take()).toEqual({
      ok: true,
      text: "open chrome",
      language: "en",
      engine: "stream-ear-nemotron",
    });
  });
});

describe("stream-session: wiring in the dictation and the conductor", () => {
  it("only a PCM-ring segment opens a stream, fed from the existing segment tick (no new timer)", () => {
    expect(sttSource).toMatch(
      /this\.pcmSegment = true;\s*this\.recorder = null;\s*this\.openStream\(\);/,
    );
    const tick = sttSource.slice(
      sttSource.indexOf("private evaluateSegment("),
      sttSource.indexOf("private async requestTurnScore("),
    );
    expect(tick).toMatch(/this\.feedStream\(\);/);
    const open = sttSource.slice(
      sttSource.indexOf("private openStream("),
      sttSource.indexOf("private feedStream("),
    );
    expect(open).not.toMatch(/setInterval|setTimeout|getUserMedia|micStream/);
  });

  it("an EndOfTurn endpoint closes the segment, except a push-to-talk hold", () => {
    expect(sttSource).toMatch(
      /if \(this\.streamSession\?\.endOfTurn && !this\.pttSegment\) \{\s*this\.finishSegment\("stream-endpoint"\);\s*return;/,
    );
  });

  it("the stream is closed when the segment ends and its final rides the early-read slot", () => {
    const finish = sttSource.slice(
      sttSource.indexOf("private finishSegment("),
      sttSource.indexOf("private evaluateSegment("),
    );
    expect(finish).toMatch(/const streamed = this\.takeStreamRead\(\);/);
    expect(finish).toMatch(/streamed \?\? sealed/);
    expect(finish).toMatch(/this\.dropStream\("dropped"\)/);
    expect(sttSource).toMatch(/return streamEarlyRead\(session\.close\(true\)\);/);
    // While the ear reads, the ordinary early read does not start a second decode.
    expect(sttSource).toMatch(
      /maybeReadEarly\([^)]*\) \{\s*\/\/[^\n]*\n\s*if \(this\.streamSession\?\.live\) return;/,
    );
    const stop = sttSource.slice(
      sttSource.indexOf("  stop() {"),
      sttSource.indexOf("private releaseLease()"),
    );
    expect(stop).toMatch(/this\.dropStream\("stopped"\)/);
  });

  it("the conductor asks only in Auto mode and only when voice.streamEngine is on; partials take the live-words path", () => {
    const plan = modeSource.slice(
      modeSource.indexOf("private streamPlan()"),
      modeSource.indexOf("private streamPlan()") + 700,
    );
    expect(plan).toMatch(
      /if \(!streamWanted\(voice\.streamEngine\) \|\| this\.state\.mode !== "auto"\) return null;/,
    );
    expect(plan).toMatch(/locale: streamLocale\(voice\.recognitionLang\)/);
    expect(modeSource).toMatch(/streamPlan: \(\) => this\.streamPlan\(\),/);
    expect(modeSource).toMatch(
      /onStreamPartial: \(update\) => \{\s*this\.startLiveWords\(\);\s*this\.liveWords\?\.show\(update\);\s*\}/,
    );
    const live = modeSource.slice(
      modeSource.indexOf("private startLiveWords()"),
      modeSource.indexOf("private stopLiveWords("),
    );
    // The follower is built (so the caption and the barge-in gate get the stream's words) but runs no pass of its own.
    expect(live).toMatch(
      /\}\);\s*\/\/[^\n]*\n\s*if \(streamWanted\(preferences\.getSnapshot\(\)\.voice\.streamEngine\)\) return;\s*this\.liveWords\.start\(/,
    );
  });

  it("the conductor listens to the turn protocol once, and an eager endpoint has its own switch (off by default)", () => {
    expect(modeSource).toMatch(
      /this\.turnStreamOff \?\?= subscribeStreamTurns\(\(turn\) => this\.noteStreamTurn\(turn\)\);/,
    );
    expect(modeSource).toMatch(
      /const earsEager = viaTurn && preferences\.getSnapshot\(\)\.voice\.ears\.eagerTurn === true;\s*if \(!earsEager && preferences\.getSnapshot\(\)\.voice\.eagerTurn !== true\) return;/,
    );
    const eager = modeSource.slice(
      modeSource.indexOf("private planTurnDraft("),
      modeSource.indexOf("private noteStreamTurn("),
    );
    // An eager endpoint only ever starts the Brain's text-only draft: never the conduct preview, never a tool.
    expect(eager).toMatch(/preview\.handled/);
    expect(eager).not.toMatch(/brain\.send|startVoiceTask|runTool/);
  });

  it("LiveWords.show hands a stream partial to the same update path as a pass", async () => {
    const { LiveWords } = await import("../../src/lib/friday/voice-engine/live-words");
    const seen: LiveWordsUpdate[] = [];
    const follower = new LiveWords({
      audioSince: () => ({ samples: new Float32Array(0), rate: STREAM_RATE }),
      transcribe: async () => ({ ok: false }),
      encodeWav: () => new Uint8Array(0),
      speaking: () => true,
      onUpdate: (u) => seen.push(u),
    });
    const update = streamPartialUpdate({ text: "kal ki", committed: "kal" }, 1, "hi");
    follower.show(update);
    expect(seen).toEqual([update]);
    expect(follower.isActive()).toBe(false);
  });
});
