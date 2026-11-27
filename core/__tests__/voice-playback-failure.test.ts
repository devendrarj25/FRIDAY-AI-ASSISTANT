import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { DEFAULT_PREFERENCES, preferences } from "../../src/lib/friday/preferences";

type Win = Record<string, unknown>;
const g = globalThis as unknown as {
  window?: Win | undefined;
  Audio?: unknown;
  SpeechSynthesisUtterance?: unknown;
};
const saved = { window: g.window, Audio: g.Audio, Utter: g.SpeechSynthesisUtterance };
const tuning = {
  voiceName: "",
  lang: "en-IN",
  rate: 1,
  pitch: 1,
  volume: 0.8,
  kind: "neural" as const,
};

class FakeSource {
  onended: (() => void) | null = null;
  buffer: unknown = null;
  connect() {}
  start() {}
  stop() {}
}
class FakeContext {
  currentTime = 0;
  sampleRate = 44_100;
  state = "running";
  destination = {};
  createBuffer() {
    return { copyToChannel: () => {} };
  }
  createBufferSource() {
    return new FakeSource();
  }
  resume() {
    return Promise.resolve();
  }
}

/** Page timers that follow whatever clock the test installed. */
const pageTimers = {
  setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(id),
};

const pcmReply = () => {
  const view = new Int16Array(441).fill(3000);
  return {
    ok: true,
    engine: "supertonic-3",
    voice: "F2",
    sampleRate: 44_100,
    pcm: new Uint8Array(view.buffer),
  };
};

describe("a clip that never sounded is not reported as spoken", () => {
  let lib: typeof import("../../src/lib/friday/voice-library");
  let playMode: "ok" | "reject" | "error";
  let spoke: string[];

  const synthWindow = (voices: Array<{ name: string; lang: string }>, endsAfter: number | null) => {
    class FakeUtterance {
      lang = "";
      rate = 1;
      pitch = 1;
      volume = 1;
      voice: unknown = null;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onboundary: (() => void) | null = null;
      constructor(public text: string) {}
    }
    g.SpeechSynthesisUtterance = FakeUtterance;
    const synth = {
      cancelled: 0,
      getVoices: () => voices,
      cancel() {
        this.cancelled += 1;
      },
      speak(u: FakeUtterance) {
        spoke.push(u.text);
        u.onstart?.();
        if (endsAfter !== null) setTimeout(() => u.onend?.(), endsAfter);
      },
    };
    return synth;
  };

  beforeEach(async () => {
    spoke = [];
    playMode = "ok";
    class FakeAudio {
      volume = 1;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public src: string) {}
      play() {
        if (playMode === "reject") return Promise.reject(new Error("NotAllowedError"));
        if (playMode === "error") setTimeout(() => this.onerror?.(), 1);
        else setTimeout(() => this.onended?.(), 1);
        return Promise.resolve();
      }
      pause() {}
    }
    g.Audio = FakeAudio;
    lib = await import("../../src/lib/friday/voice-library");
    lib.resetPrefetchedSpeech();
    lib.resetPcmPlayback();
    preferences.update({ voice: { ...DEFAULT_PREFERENCES.voice, pcmPlayback: false } });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    lib.stopSpeaking();
    lib.resetPcmPlayback();
    g.window = saved.window;
    g.Audio = saved.Audio;
    g.SpeechSynthesisUtterance = saved.Utter;
    preferences.update({ voice: { ...DEFAULT_PREFERENCES.voice } });
  });

  const neuralWindow = (extra: Win = {}): Win => ({
    friday: {
      speakNeural: async (req: { text: string }) => ({
        ok: true,
        audioBase64: Buffer.from(req.text).toString("base64"),
        mime: "audio/wav",
        engine: "supertonic-3",
        voice: "F2",
      }),
    },
    ...extra,
  });

  it("a refused play() is a failed speech: the result is none and the start is closed", async () => {
    g.window = neuralWindow();
    playMode = "reject";
    const events: string[] = [];
    const how = await lib.speakText("Hello there my friend.", tuning, {
      onStart: () => events.push("start"),
      onEnd: () => events.push("end"),
    });
    expect(how).toBe("none");
    expect(events).toEqual(["start", "end"]);
  });

  it("an element error falls back to the system voice and says so", async () => {
    const synth = synthWindow([{ name: "Zira", lang: "en-US" }], 1);
    g.window = neuralWindow({ speechSynthesis: synth, ...pageTimers });
    playMode = "error";
    const how = await lib.speakText("Hello there my friend.", tuning);
    expect(how).toBe("system");
    expect(spoke).toEqual(["Hello there my friend."]);
  });

  it("a clip that plays to its end is still neural", async () => {
    g.window = neuralWindow();
    expect(await lib.speakText("Hello there my friend.", tuning)).toBe("neural");
  });

  it("one raw-sample failure turns PCM off only for a cool-down, then it comes back", async () => {
    let asked = 0;
    let fail = true;
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    g.window = neuralWindow({
      AudioContext: FakeContext,
      friday: {
        speakNeuralPcm: async () => {
          asked += 1;
          return fail ? { ok: false, reason: "worker is not running" } : pcmReply();
        },
        speakNeural: async (req: { text: string }) => ({
          ok: true,
          audioBase64: Buffer.from(req.text).toString("base64"),
          mime: "audio/wav",
          engine: "supertonic-3",
          voice: "F2",
        }),
      },
    });
    preferences.update({ voice: { ...DEFAULT_PREFERENCES.voice, pcmPlayback: true } });
    await lib.speakText("Hello there my friend.", tuning);
    expect(asked).toBe(1);
    expect(lib.pcmPlaybackNote()).toMatch(/worker is not running/);
    // inside the cool-down nothing asks again
    now += 10_000;
    await lib.speakText("Hello again my friend.", tuning);
    expect(asked).toBe(1);
    // after it, raw samples are tried again and a success clears the note
    fail = false;
    now += lib.pcmCoolDownMs(1);
    expect(lib.pcmPlaybackNote()).toBe("");
    await lib.speakText("Hello once more my friend.", tuning);
    expect(asked).toBe(2);
    expect(lib.lastClipUsedPcm()).toBe(true);
    expect(lib.pcmPlaybackNote()).toBe("");
  });

  it("the cool-down grows with failures in a row and is capped", () => {
    expect(lib.pcmCoolDownMs(1)).toBe(30_000);
    expect(lib.pcmCoolDownMs(2)).toBe(60_000);
    expect(lib.pcmCoolDownMs(3)).toBe(120_000);
    expect(lib.pcmCoolDownMs(30)).toBe(600_000);
  });

  it("resetPcmPlayback brings raw samples back at once", async () => {
    let asked = 0;
    g.window = neuralWindow({
      AudioContext: FakeContext,
      friday: {
        speakNeuralPcm: async () => {
          asked += 1;
          return { ok: false, reason: "worker is not running" };
        },
        speakNeural: async () => ({
          ok: true,
          audioBase64: "AA==",
          mime: "audio/wav",
          engine: "x",
        }),
      },
    });
    preferences.update({ voice: { ...DEFAULT_PREFERENCES.voice, pcmPlayback: true } });
    await lib.speakText("Hello there my friend.", tuning);
    expect(asked).toBe(1);
    lib.resetPcmPlayback();
    expect(lib.pcmPlaybackNote()).toBe("");
    await lib.speakText("Hello there my friend again.", tuning);
    expect(asked).toBe(2);
  });

  it("the system-voice watchdog cancels the synth and its time follows the text length", async () => {
    vi.useFakeTimers();
    const synth = synthWindow([{ name: "Zira", lang: "en-US" }], null);
    g.window = { speechSynthesis: synth, ...pageTimers };
    const long = "word ".repeat(200).trim();
    const speaking = lib.speakText(long, { ...tuning, kind: "system" });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(synth.cancelled).toBe(0);
    await vi.advanceTimersByTimeAsync(lib.systemVoiceTimeoutMs(long.length, 1));
    await speaking;
    expect(synth.cancelled).toBeGreaterThanOrEqual(1);
    expect(lib.systemVoiceTimeoutMs(10, 1)).toBeLessThan(lib.systemVoiceTimeoutMs(1000, 1));
    expect(lib.systemVoiceTimeoutMs(10_000_000, 1)).toBe(300_000);
  });

  it("Devanagari with no Hindi voice installed reports none and speaks nothing", async () => {
    const synth = synthWindow([{ name: "Zira", lang: "en-US" }], 1);
    g.window = { speechSynthesis: synth, ...pageTimers };
    const how = await lib.speakText("नमस्ते, आप कैसे हैं?", { ...tuning, kind: "system" });
    expect(how).toBe("none");
    expect(spoke).toEqual([]);
    const withHindi = synthWindow([{ name: "Swara", lang: "hi-IN" }], 1);
    g.window = { speechSynthesis: withHindi, ...pageTimers };
    expect(await lib.speakText("नमस्ते, आप कैसे हैं?", { ...tuning, kind: "system" })).toBe("system");
  });
});

describe("no screen button speaks around the Auto-only and mute gates", () => {
  const flow = readFileSync(
    resolve(import.meta.dirname, "../../src/components/friday/FlowStudio.tsx"),
    "utf8",
  );

  it("the Flow Studio Speak button goes through speakSample, never straight to the voice bridge", () => {
    expect(flow).not.toMatch(/\.speakNeural\s*\(/);
    expect(flow).toMatch(/speakSample\(/);
    expect(flow).toMatch(/activeVoiceSettings\(\)/);
  });
});
