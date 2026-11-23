/**
 * Per-utterance cancel in the renderer: every raw-sample clause carries the id of its utterance, a stop tells the
 * local voice to drop that utterance, and a clause answered "cancelled" is neither a failure of PCM playback nor a
 * reason to make the same stale clause again as a WAV.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_PREFERENCES, preferences } from "../../src/lib/friday/preferences";

type Win = Record<string, unknown>;
const g = globalThis as unknown as { window?: Win | undefined; Audio?: unknown };

class FakeSource {
  onended: (() => void) | null = null;
  connect() {}
  start() {}
  stop() {}
}
class FakeContext {
  currentTime = 0;
  sampleRate = 48_000;
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

const tuning = {
  rate: 1,
  pitch: 1,
  volume: 1,
  voiceName: "",
  lang: "en-IN",
  kind: "neural" as const,
};

type Req = { text: string; utt?: string; seq?: number };
const UTT = /^[A-Za-z0-9_-]{1,64}$/;

describe("per-utterance cancel in the renderer", () => {
  const saved = { window: g.window, Audio: g.Audio };
  let pcmAsked: Req[];
  let cancels: Array<{ utt: string }>;
  let wavAsked: string[];
  let lib: typeof import("../../src/lib/friday/voice-library");

  const pcmReply = () => ({
    ok: true,
    engine: "supertonic-3",
    voice: "F2",
    sampleRate: 44_100,
    pcm: new Uint8Array(new Int16Array(441).fill(3000).buffer),
  });
  const bridge = (over: Record<string, unknown> = {}): Win => ({
    AudioContext: FakeContext,
    friday: {
      speakNeuralPcm: async (req: Req) => {
        pcmAsked.push(req);
        return pcmReply();
      },
      cancelNeuralPcm: async (req: { utt: string }) => {
        cancels.push(req);
        return { ok: true, ...req };
      },
      speakNeural: async (req: { text: string }) => {
        wavAsked.push(req.text);
        return { ok: true, audioBase64: "AAAA", mime: "audio/wav", engine: "supertonic-3" };
      },
      ...over,
    },
  });

  beforeEach(async () => {
    pcmAsked = [];
    cancels = [];
    wavAsked = [];
    g.Audio = class {
      volume = 1;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      play() {
        setTimeout(() => this.onended?.(), 2);
        return Promise.resolve();
      }
      pause() {}
    };
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

  it("tags every clause of one utterance with one clean id, and a later utterance with another", async () => {
    g.window = bridge();
    await lib.speakText("Hello there my friend. How are you doing today?", tuning);
    expect(pcmAsked.length).toBeGreaterThanOrEqual(1);
    const first = pcmAsked[0]?.utt ?? "";
    expect(first).toMatch(UTT);
    expect(pcmAsked.every((req) => req.utt === first)).toBe(true);
    lib.stopSpeaking();
    pcmAsked = [];
    await lib.speakText("A new reply starts here.", tuning);
    const second = pcmAsked[0]?.utt ?? "";
    expect(second).toMatch(UTT);
    expect(second).not.toBe(first);
  });

  it("tells the local voice to drop the utterance when speech is stopped, once, with the id it used", async () => {
    g.window = bridge();
    await lib.speakText("Hello there my friend.", tuning);
    const used = pcmAsked[0]?.utt ?? "";
    expect(cancels).toEqual([]);
    lib.stopSpeaking();
    expect(cancels).toEqual([{ utt: used }]);
    lib.stopSpeaking();
    expect(cancels).toHaveLength(1);
  });

  it("asks for no cancel when no raw-sample clause was ever requested", () => {
    g.window = bridge();
    lib.stopSpeaking();
    expect(cancels).toEqual([]);
  });

  it("survives a bridge with no cancel, or one that throws or rejects", async () => {
    g.window = bridge({ cancelNeuralPcm: undefined });
    await lib.speakText("Hello there my friend.", tuning);
    expect(() => lib.stopSpeaking()).not.toThrow();
    lib.resetPcmPlayback();
    g.window = bridge({
      cancelNeuralPcm: () => {
        throw new Error("ipc closed");
      },
    });
    await lib.speakText("Hello again my friend.", tuning);
    expect(() => lib.stopSpeaking()).not.toThrow();
    lib.resetPcmPlayback();
    g.window = bridge({ cancelNeuralPcm: () => Promise.reject(new Error("gone")) });
    await lib.speakText("Hello once more my friend.", tuning);
    expect(() => lib.stopSpeaking()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 5));
  });

  it("a clause answered cancelled is not a PCM failure and is not made again as a WAV", async () => {
    let release: (value: unknown) => void = () => {};
    g.window = bridge({
      speakNeuralPcm: (req: Req) => {
        pcmAsked.push(req);
        return new Promise((resolve) => (release = resolve));
      },
    });
    const speaking = lib.speakText("Hello there my friend.", tuning);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(pcmAsked).toHaveLength(1);
    lib.stopSpeaking();
    expect(cancels).toEqual([{ utt: pcmAsked[0]?.utt ?? "?" }]);
    release({ ok: false, engine: "local", cloud: false, reason: "cancelled", cancelled: true });
    await speaking;
    expect(wavAsked).toEqual([]);
    expect(lib.pcmPlaybackNote()).toBe("");
    // The session still plays raw samples afterwards.
    g.window = bridge();
    pcmAsked = [];
    await lib.speakText("The next reply is fine.", tuning);
    expect(pcmAsked).toHaveLength(1);
    expect(lib.pcmPlaybackNote()).toBe("");
  });

  it("a cancelled answer with no stop in between is still not a failure of PCM playback", async () => {
    g.window = bridge({
      speakNeuralPcm: async () => ({ ok: false, reason: "cancelled", cancelled: true }),
    });
    await lib.speakText("Hello there my friend.", tuning);
    expect(lib.pcmPlaybackNote()).toBe("");
  });
});
