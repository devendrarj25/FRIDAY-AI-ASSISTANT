import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { DEFAULT_PREFERENCES, preferences } from "../../src/lib/friday/preferences";
import {
  bytesToPcm16,
  PcmClipPlayer,
  pcm16ToWavBase64,
  windowLevels,
  type PcmContext,
  type PcmTimers,
} from "../../src/lib/friday/voice-engine/pcm-clip-player";

const root = resolve(import.meta.dirname, "../..");
const source = (rel: string) => readFileSync(resolve(root, rel), "utf8").replace(/\r\n/g, "\n");

class FakeSource {
  buffer: unknown = null;
  when: number | null = null;
  stopped = false;
  onended: (() => void) | null = null;
  connect() {}
  start(when?: number) {
    this.when = when ?? 0;
  }
  stop() {
    this.stopped = true;
  }
}

class FakeContext {
  static made: FakeContext[] = [];
  currentTime = 0;
  sampleRate = 48_000;
  state: string = "running";
  destination = {};
  sources: FakeSource[] = [];
  lengths: number[] = [];
  breakSources = false;
  constructor() {
    FakeContext.made.push(this);
  }
  createBuffer(_channels: number, length: number) {
    this.lengths.push(length);
    return { copyToChannel: () => {} };
  }
  createBufferSource() {
    if (this.breakSources) throw new Error("no audio output device");
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  resume() {
    return Promise.resolve();
  }
}

/** Timers that only move when the test says so. */
function fakeTimers() {
  let now = 0;
  let id = 0;
  const timeouts = new Map<number, { at: number; fn: () => void }>();
  const intervals = new Map<number, { every: number; next: number; fn: () => void }>();
  const timers: PcmTimers = {
    setTimeout: (fn, ms) => {
      id += 1;
      timeouts.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (handle) => void timeouts.delete(handle as number),
    setInterval: (fn, ms) => {
      id += 1;
      intervals.set(id, { every: ms, next: now + ms, fn });
      return id;
    },
    clearInterval: (handle) => void intervals.delete(handle as number),
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [
        ...[...timeouts.entries()].map(([k, v]) => ({ k, at: v.at, kind: "t" as const })),
        ...[...intervals.entries()].map(([k, v]) => ({ k, at: v.next, kind: "i" as const })),
      ]
        .filter((entry) => entry.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      if (due.kind === "t") {
        const t = timeouts.get(due.k);
        timeouts.delete(due.k);
        t?.fn();
      } else {
        const i = intervals.get(due.k);
        if (i) {
          i.next += i.every;
          i.fn();
        }
      }
    }
    now = target;
  };
  return { timers, advance, pending: () => timeouts.size + intervals.size };
}

const tone = (samples: number, value = 8000) => new Int16Array(samples).fill(value);

describe("PcmClipPlayer (fake context, fake clock)", () => {
  it("resamples to the context rate, schedules the clip and ends when its audio is over", async () => {
    const ctx = new FakeContext();
    const clock = fakeTimers();
    const player = new PcmClipPlayer(ctx as unknown as PcmContext, { timers: clock.timers });
    const clip = player.start(tone(44_100), 44_100, 1);
    // one second at 44.1 kHz is one second at 48 kHz, within a sample
    expect(Math.abs((ctx.lengths[0] ?? 0) - 48_000)).toBeLessThanOrEqual(2);
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0]?.when).toBe(0);
    expect(Math.round(clip.durationMs)).toBe(1000);
    let ended = false;
    void clip.ended.then(() => (ended = true));
    clock.advance(999);
    await Promise.resolve();
    expect(ended).toBe(false);
    clock.advance(2);
    await clip.ended;
    expect(ended).toBe(true);
    expect(clock.pending()).toBe(0);
  });

  it("puts the next clause right behind the first one on the audio clock", () => {
    const ctx = new FakeContext();
    const player = new PcmClipPlayer(ctx as unknown as PcmContext, { timers: fakeTimers().timers });
    player.start(tone(48_000), 48_000);
    player.start(tone(24_000), 48_000);
    expect(ctx.sources.map((s) => s.when)).toEqual([0, 1]);
    expect(player.stats().queuedMs).toBe(1500);
  });

  it("stop flushes every audible source at once, reports what was played and settles the waiting clip", async () => {
    const ctx = new FakeContext();
    const clock = fakeTimers();
    const player = new PcmClipPlayer(ctx as unknown as PcmContext, { timers: clock.timers });
    const clip = player.start(tone(48_000), 48_000);
    ctx.currentTime = 0.25;
    expect(player.stop()).toBe(250);
    expect(ctx.sources.every((s) => s.stopped)).toBe(true);
    await clip.ended;
    expect(clock.pending()).toBe(0);
    // what was cut off cannot continue, and the next clause starts clean
    const next = player.start(tone(480), 48_000);
    expect(ctx.sources).toHaveLength(2);
    expect(ctx.sources[1]?.stopped).toBe(false);
    next.stop();
  });

  it("scales the samples to the clause's volume and keeps the level in range", () => {
    const quiet = new FakeContext();
    const loud = new FakeContext();
    const seen: number[][] = [];
    for (const [ctx, volume] of [
      [quiet, 0.25],
      [loud, 1],
    ] as const) {
      const clock = fakeTimers();
      const levels: number[] = [];
      const player = new PcmClipPlayer(ctx as unknown as PcmContext, {
        timers: clock.timers,
        onLevel: (rms) => levels.push(rms),
      });
      player.start(tone(48_000, 16_000), 48_000, volume);
      clock.advance(100);
      seen.push(levels);
    }
    const [q, l] = seen;
    expect(q?.[0]).toBeGreaterThan(0);
    expect((q?.[0] ?? 0) * 4).toBeCloseTo(l?.[0] ?? 0, 2);
    expect(Math.max(...(l ?? [0]))).toBeLessThanOrEqual(1);
  });

  it("publishes the measured loudness while it plays and zero when it stops", () => {
    const ctx = new FakeContext();
    const clock = fakeTimers();
    const levels: number[] = [];
    const player = new PcmClipPlayer(ctx as unknown as PcmContext, {
      timers: clock.timers,
      onLevel: (rms) => levels.push(rms),
    });
    const loud = tone(2400, 20_000);
    const silent = tone(2400, 0);
    const both = new Int16Array(4800);
    both.set(loud, 0);
    both.set(silent, 2400);
    player.start(both, 48_000);
    clock.advance(50);
    clock.advance(50);
    expect(levels[0]).toBeGreaterThan(0.5);
    expect(levels[1]).toBe(0);
    player.stop();
    expect(levels.at(-1)).toBe(0);
  });

  it("refuses an empty clip, a clip with no rate, and a clip past the queue bound", () => {
    const ctx = new FakeContext();
    const player = new PcmClipPlayer(ctx as unknown as PcmContext, {
      timers: fakeTimers().timers,
      maxQueuedMs: 1000,
    });
    expect(() => player.start(new Int16Array(0), 48_000)).toThrow();
    expect(() => player.start(tone(10), 0)).toThrow();
    expect(() => player.start(tone(96_000), 48_000)).toThrow(/refused/);
    expect(ctx.sources).toHaveLength(0);
    expect(player.stats().dropped).toBe(1);
  });

  it("is ready only when the context runs: a suspended one is resumed, a closed one is refused", async () => {
    const ctx = new FakeContext();
    ctx.state = "suspended";
    ctx.resume = () => {
      ctx.state = "running";
      return Promise.resolve();
    };
    const player = new PcmClipPlayer(ctx as unknown as PcmContext, { timers: fakeTimers().timers });
    await expect(player.ready()).resolves.toBeUndefined();
    ctx.state = "closed";
    await expect(player.ready()).rejects.toThrow(/closed/);
  });

  it("never waits for a context that will not start: it is refused after the timeout", async () => {
    const ctx = new FakeContext();
    ctx.state = "suspended";
    ctx.resume = () => new Promise<void>(() => undefined); // no user gesture: the promise never settles
    const clock = fakeTimers();
    const player = new PcmClipPlayer(ctx as unknown as PcmContext, { timers: clock.timers });
    const waiting = player.ready(500);
    const outcome = expect(waiting).rejects.toThrow(/did not start/);
    clock.advance(501);
    await outcome;
    expect(clock.pending()).toBe(0);
  });

  it("dispose stops everything and refuses every later clip", () => {
    const ctx = new FakeContext();
    const player = new PcmClipPlayer(ctx as unknown as PcmContext, { timers: fakeTimers().timers });
    player.start(tone(4800), 48_000);
    player.dispose();
    expect(ctx.sources[0]?.stopped).toBe(true);
    expect(() => player.start(tone(10), 48_000)).toThrow();
  });
});

describe("raw sample helpers", () => {
  it("reads little-endian bytes as samples, whatever the alignment, and drops a stray last byte", () => {
    const bytes = new Uint8Array([0, 0, 0xff, 0x7f, 0x00, 0x80, 0x34]);
    expect(Array.from(bytesToPcm16(bytes))).toEqual([0, 32767, -32768]);
    const backing = new Uint8Array([9, 0x10, 0x00, 0x20, 0x00]);
    expect(Array.from(bytesToPcm16(backing.subarray(1)))).toEqual([16, 32]);
    expect(bytesToPcm16(new Uint8Array(0))).toHaveLength(0);
  });

  it("wraps samples in a WAV file the page audio element can play", () => {
    const wav = Buffer.from(pcm16ToWavBase64(new Int16Array([1, -2, 3]), 44_100), "base64");
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(44_100);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(40)).toBe(6);
    expect(wav.length).toBe(50);
    expect(wav.readInt16LE(46)).toBe(-2);
  });

  it("measures the loudness of each window", () => {
    const levels = windowLevels(new Int16Array([16384, 16384, 0, 0]), 40, 50);
    expect(levels).toHaveLength(2);
    expect(levels[0]).toBeCloseTo(0.5, 3);
    expect(levels[1]).toBe(0);
  });
});

describe("speakText through the raw sample path (real module, fake devices)", () => {
  type Win = Record<string, unknown> & { AudioContext?: unknown };
  const g = globalThis as unknown as { window?: Win | undefined; Audio?: unknown };
  const saved = { window: g.window, Audio: g.Audio };
  const tuning = {
    voiceName: "",
    lang: "en-IN",
    rate: 1,
    pitch: 1,
    volume: 0.8,
    kind: "neural" as const,
  };
  let asked: string[];
  let wavAsked: string[];
  let played: string[];
  let lib: typeof import("../../src/lib/friday/voice-library");

  const pcmReply = (samples = 441, rate = 44_100) => {
    const view = new Int16Array(samples).fill(3000);
    return {
      ok: true,
      engine: "supertonic-3",
      voice: "F2",
      sampleRate: rate,
      pcm: new Uint8Array(view.buffer),
    };
  };

  beforeEach(async () => {
    FakeContext.made = [];
    asked = [];
    wavAsked = [];
    played = [];
    class FakeAudio {
      volume = 1;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public src: string) {
        played.push(src);
      }
      play() {
        setTimeout(() => this.onended?.(), 2);
        return Promise.resolve();
      }
      pause() {}
    }
    g.Audio = FakeAudio;
    lib = await import("../../src/lib/friday/voice-library");
    lib.resetPrefetchedSpeech();
    lib.resetPcmPlayback();
    preferences.update({ voice: { ...DEFAULT_PREFERENCES.voice, pcmPlayback: true } });
  });
  afterEach(() => {
    lib.stopSpeaking();
    lib.resetPcmPlayback();
    g.window = saved.window;
    g.Audio = saved.Audio;
    preferences.update({ voice: { ...DEFAULT_PREFERENCES.voice } });
  });

  const bridge = (over: Record<string, unknown> = {}): Win => ({
    AudioContext: FakeContext,
    friday: {
      speakNeuralPcm: async (req: { text: string }) => {
        asked.push(req.text);
        return pcmReply();
      },
      speakNeural: async (req: { text: string }) => {
        wavAsked.push(req.text);
        return {
          ok: true,
          audioBase64: Buffer.from(req.text).toString("base64"),
          mime: "audio/wav",
          engine: "supertonic-3",
          voice: "F2",
        };
      },
      ...over,
    },
  });

  it("is off by default: nothing asks the raw sample op and the file path plays", async () => {
    g.window = bridge();
    preferences.update({ voice: { ...DEFAULT_PREFERENCES.voice } });
    expect(DEFAULT_PREFERENCES.voice.pcmPlayback).toBe(false);
    expect(DEFAULT_PREFERENCES.voice.fastFirstClause).toBe(false);
    await lib.speakText("Hello there my friend.", tuning);
    expect(asked).toEqual([]);
    expect(wavAsked).toHaveLength(1);
    expect(FakeContext.made.every((ctx) => ctx.sources.length === 0)).toBe(true);
  });

  it("schedules the first clause before the second one has been made, then ends in order", async () => {
    let release: (value: unknown) => void = () => undefined;
    const second = new Promise((resolve) => (release = resolve));
    let calls = 0;
    g.window = bridge({
      speakNeuralPcm: async (req: { text: string }) => {
        asked.push(req.text);
        calls += 1;
        return calls === 1 ? pcmReply() : second;
      },
    });
    const events: string[] = [];
    const speaking = lib.speakText("Namaste, kaise hain aap. The report is ready now.", tuning, {
      onFirstAudio: () => events.push("audio"),
      onStart: () => events.push("start"),
      onEnd: () => events.push("end"),
    });
    await vi.waitFor(() => expect(FakeContext.made[0]?.sources).toHaveLength(1));
    // the first sample is scheduled while the second clause is still being synthesised
    expect(asked).toHaveLength(2);
    expect(events).toEqual(["audio", "start"]);
    release(pcmReply());
    const how = await speaking;
    expect(how).toBe("neural");
    expect(events).toEqual(["audio", "start", "end"]);
    expect(FakeContext.made[0]?.sources).toHaveLength(2);
    expect(played).toEqual([]);
    expect(wavAsked).toEqual([]);
    expect(lib.lastClipUsedPcm()).toBe(true);
    expect(lib.pcmPlaybackNote()).toBe("");
    expect(lib.lastSpeechRoute().engine).toBe("supertonic-3");
  });

  it("uses it only for the local voice: a cloud voice, SAPI and a voice file keep their path", async () => {
    g.window = bridge();
    await lib.speakText("Hello there my friend.", { ...tuning, voiceName: "en-IN-NeerjaNeural" });
    await lib.speakText("Hello there my friend.", { ...tuning, kind: "system" });
    expect(asked).toEqual([]);
    expect(wavAsked).toHaveLength(2);
  });

  it("falls back to the file path for that clause when the raw sample op fails, and stays there with a reason", async () => {
    g.window = bridge({
      speakNeuralPcm: async (req: { text: string }) => {
        asked.push(req.text);
        return { ok: false, reason: "worker is not running" };
      },
    });
    const how = await lib.speakText("Hello there my friend.", tuning);
    expect(how).toBe("neural");
    expect(asked).toHaveLength(1);
    expect(wavAsked).toEqual(["Hello there my friend."]);
    expect(played).toHaveLength(1);
    expect(lib.pcmPlaybackNote()).toMatch(
      /off for this session \(synthesis: worker is not running\)/,
    );
    // the session decision holds: later clauses never ask again
    await lib.speakText("And one more sentence here.", tuning);
    expect(asked).toHaveLength(1);
    expect(wavAsked).toHaveLength(2);
  });

  it("a thrown error and a reply with no samples fall back the same way", async () => {
    g.window = bridge({
      speakNeuralPcm: async () => {
        throw new Error("ipc closed");
      },
    });
    await lib.speakText("Hello there my friend.", tuning);
    expect(wavAsked).toHaveLength(1);
    expect(lib.pcmPlaybackNote()).toContain("ipc closed");
    lib.resetPcmPlayback();
    expect(lib.pcmPlaybackNote()).toBe("");
    g.window = bridge({ speakNeuralPcm: async () => ({ ...pcmReply(), pcm: new Uint8Array(0) }) });
    await lib.speakText("Hello again my friend.", tuning);
    expect(wavAsked).toHaveLength(2);
    expect(lib.pcmPlaybackNote()).toContain("no samples");
  });

  it("when the audio output cannot start, this clause plays from the same samples as a WAV and the session falls back", async () => {
    g.window = bridge({});
    const Broken = class extends FakeContext {
      override breakSources = true;
    };
    (g.window as Win).AudioContext = Broken;
    const events: string[] = [];
    const how = await lib.speakText("Hello there my friend.", tuning, {
      onStart: () => events.push("start"),
      onEnd: () => events.push("end"),
    });
    expect(how).toBe("neural");
    expect(events).toEqual(["start", "end"]);
    expect(played).toHaveLength(1);
    expect(played[0]).toMatch(/^data:audio\/wav;base64,UklG/);
    expect(wavAsked).toEqual([]);
    expect(lib.pcmPlaybackNote()).toMatch(/playback: no audio output device/);
    expect(lib.lastClipUsedPcm()).toBe(false);
  });

  it("does nothing without an audio context in this window (the old path plays, no failure is recorded)", async () => {
    g.window = bridge();
    delete (g.window as Win).AudioContext;
    await lib.speakText("Hello there my friend.", tuning);
    expect(asked).toEqual([]);
    expect(wavAsked).toHaveLength(1);
    expect(lib.pcmPlaybackNote()).toBe("");
  });

  it("stopSpeaking flushes the scheduler at once and the waiting speech settles as dropped", async () => {
    g.window = bridge({
      speakNeuralPcm: async () => pcmReply(44_100 * 5), // five seconds
    });
    const events: string[] = [];
    const speaking = lib.speakText("Hello there my friend.", tuning, {
      onStart: () => events.push("start"),
      onEnd: () => events.push("end"),
    });
    await vi.waitFor(() => expect(FakeContext.made[0]?.sources).toHaveLength(1));
    expect(lib.pendingSpeechOperations()).toBeGreaterThan(0);
    lib.stopSpeaking();
    expect(FakeContext.made[0]?.sources[0]?.stopped).toBe(true);
    expect(await speaking).toBe("none");
    expect(lib.pendingSpeechOperations()).toBe(0);
    expect(events).not.toContain("end");
    // a fresh reply plays on a clean scheduler
    g.window = bridge();
    await lib.speakText("Fresh reply.", tuning);
    expect(FakeContext.made[0]?.sources.at(-1)?.stopped).toBe(false);
  });

  it("a stop that lands while the clause is still being made plays nothing", async () => {
    let release: (value: unknown) => void = () => undefined;
    const pending = new Promise((resolve) => (release = resolve));
    g.window = bridge({
      speakNeuralPcm: async (req: { text: string }) => {
        asked.push(req.text);
        return pending;
      },
    });
    const speaking = lib.speakText("Hello there my friend.", tuning);
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    lib.stopSpeaking();
    release(pcmReply());
    expect(await speaking).toBe("none");
    expect(FakeContext.made.every((ctx) => ctx.sources.length === 0)).toBe(true);
    expect(played).toEqual([]);
  });
});

describe("wiring of the two opt-in settings (source-pinned; the live path cannot run here)", () => {
  it("both settings default off, are in the flow registry and have one toggle row each", () => {
    const prefs = source("src/lib/friday/preferences.ts");
    expect(prefs).toMatch(/fastFirstClause: boolean;/);
    expect(prefs).toMatch(/pcmPlayback: boolean;/);
    expect(prefs).toMatch(/fastFirstClause: false,/);
    expect(prefs).toMatch(/pcmPlayback: false,/);
    const registry = source("src/lib/friday/flow-registry.gen.ts");
    expect(registry).toContain('"voice.fastFirstClause"');
    expect(registry).toContain('"voice.pcmPlayback"');
    const ui = source("src/components/friday/settings/VoiceSettings.tsx");
    expect(ui.match(/prefs\.voice\.fastFirstClause === true/g)).toHaveLength(1);
    expect(ui.match(/prefs\.voice\.pcmPlayback === true/g)).toHaveLength(1);
    expect(ui).toContain("preferences.setVoice({ fastFirstClause:");
    expect(ui).toContain("preferences.setVoice({ pcmPlayback:");
  });

  it("the live answer takes the small first clause only when the setting is on, and the rest is unchanged", () => {
    const mode = source("src/lib/friday/assistant-mode.ts");
    expect(mode).toContain('from "./voice-engine/clause-chunker"');
    expect(mode).toMatch(
      /const fast = this\.voicedChars === 0 && preferences\.getSnapshot\(\)\.voice\.fastFirstClause === true;\s*const cut = fast \? firstClauseCut\(text, \{ final \}\) : null;/,
    );
    // the stamp, the cursor and the speaking happen in this order at the first cut
    expect(mode).toMatch(
      /if \(cut\) \{\s*this\.turnStages\.mark\("firstClauseReady"\);\s*this\.voicedChars \+= cut\.consumed;\s*this\.voicedPrefix = text\.slice\(0, this\.voicedChars\);\s*for \(const part of splitLongSpeech\(cut\.spoken\)\) this\.speak\(part\);/,
    );
    // everything after the first clause is still takeSpeakable, and the old early clause is the fallback only
    expect(mode).toMatch(/let chunk = takeSpeakable\(pending, final\);/);
    expect(mode).toMatch(/!fast && this\.realtimeActive\(\)/);
    // a short answer that was spoken whole by the first cut still gets its chart offer at the end
    expect(mode).toContain("if (!chunk.spoken && !cut) return;");
  });

  it("the first audio from the engine is stamped for both playback paths, from the same hook", () => {
    const mode = source("src/lib/friday/assistant-mode.ts");
    expect(mode).toMatch(
      /onFirstAudio: \(\) => \{\s*if \(gen === this\.speechGen\) this\.turnStages\.mark\("ttsFirstAudioReceived"\);/,
    );
    const lib = source("src/lib/friday/voice-library.ts");
    expect(lib).toMatch(/hooks\.onFirstAudio\?\.\(\);\s*playback\.onStart\(\);/);
    // the raw sample path shares speakText's start, end, duck and stop hooks with the file path
    expect(lib).toContain("playPcmClip(clip, plan.volume, stale, plan.text)");
    expect(lib).toMatch(/pcmPlayer\?\.stop\(\);/);
  });

  it("the raw sample path never runs for a cloud voice or in privacy mode, and is never a second capture", () => {
    const lib = source("src/lib/friday/voice-library.ts");
    const wanted = /function pcmWanted[\s\S]*?\n\}\n/.exec(lib)?.[0] ?? "";
    expect(wanted).toContain("voice.pcmPlayback === true");
    expect(wanted).toContain('tuning.kind === "neural"');
    expect(wanted).toContain('plan.cloudVoice === ""');
    expect(lib).not.toMatch(/getUserMedia/);
  });
});
