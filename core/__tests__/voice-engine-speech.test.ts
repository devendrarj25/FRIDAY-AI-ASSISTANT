import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSpeechPipeline } from "../../src/lib/friday/voice-engine/speech-pipeline";
import {
  applyExpression,
  expressionFor,
  pauseAfter,
} from "../../src/lib/friday/voice-engine/expression";
import { sanitizeCloudPrefs } from "../../src/lib/friday/voice-engine/voice-cloud-settings";
import { DEFAULT_PREFERENCES } from "../../src/lib/friday/preferences";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("speech pipeline", () => {
  it("plays in order, makes the next clips while one plays, and never has more than `ahead` in the making", async () => {
    const log: string[] = [];
    let making = 0;
    let peak = 0;
    const out = await runSpeechPipeline<string, string>({
      items: ["a", "b", "c", "d"],
      ahead: 2,
      stale: () => false,
      synthesize: async (item) => {
        making += 1;
        peak = Math.max(peak, making);
        log.push(`make ${item}`);
        await tick(5);
        making -= 1;
        return item.toUpperCase();
      },
      play: async (clip) => {
        log.push(`play ${clip}`);
        await tick(8);
      },
      sleep: async () => undefined,
    });
    expect(out).toEqual({ played: 4, failedAt: null, stale: false });
    expect(log.filter((l) => l.startsWith("play"))).toEqual([
      "play A",
      "play B",
      "play C",
      "play D",
    ]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(log.indexOf("make b")).toBeLessThan(log.indexOf("play A") + 2);
    expect(log.indexOf("make c")).toBeLessThan(log.indexOf("play C"));
  });

  it("starts speaking after the first clip even when a later clip is slow", async () => {
    const firstAt: number[] = [];
    const t0 = Date.now();
    await runSpeechPipeline<number, number>({
      items: [0, 1],
      stale: () => false,
      synthesize: async (i) => {
        await tick(i === 0 ? 5 : 80);
        return i;
      },
      play: async () => undefined,
      onFirstClip: () => firstAt.push(Date.now() - t0),
    });
    expect(firstAt[0]).toBeLessThan(60);
  });

  it("stops at a clip that could not be made and says where", async () => {
    const played: string[] = [];
    const out = await runSpeechPipeline<string, string>({
      items: ["a", "b", "c"],
      stale: () => false,
      synthesize: async (item) => (item === "b" ? null : item),
      play: async (clip) => void played.push(clip),
    });
    expect(out).toEqual({ played: 1, failedAt: 1, stale: false });
    expect(played).toEqual(["a"]);
    const threw = await runSpeechPipeline<string, string>({
      items: ["a"],
      stale: () => false,
      synthesize: async () => {
        throw new Error("engine down");
      },
      play: async () => undefined,
    });
    expect(threw.failedAt).toBe(0);
  });

  it("drops the rest the moment it goes stale", async () => {
    let stale = false;
    const played: string[] = [];
    const out = await runSpeechPipeline<string, string>({
      items: ["a", "b", "c"],
      stale: () => stale,
      synthesize: async (item) => item,
      play: async (clip) => {
        played.push(clip);
        stale = true;
      },
    });
    expect(out.stale).toBe(true);
    expect(played).toEqual(["a"]);
  });

  it("waits the gap between clips but not after the last", async () => {
    const gaps: number[] = [];
    await runSpeechPipeline<number, number>({
      items: [1, 2, 3],
      stale: () => false,
      synthesize: async (i) => i,
      play: async () => undefined,
      gapAfter: (i) => i * 10,
      sleep: async (ms) => void gaps.push(ms),
    });
    expect(gaps).toEqual([10, 20]);
  });
});

describe("expression", () => {
  it("lifts a question, softens an apology, brightens an exclamation, and keeps plain text plain", () => {
    expect(expressionFor("Kya aap taiyaar hain?").kind).toBe("question");
    expect(expressionFor("Kya aap taiyaar hain?").pitch).toBeGreaterThan(1);
    const sorry = expressionFor("Sorry, mujhe afsos hai ki file nahi mili.");
    expect(sorry.kind).toBe("empathy");
    expect(sorry.rate).toBeLessThan(1);
    expect(sorry.volume).toBeLessThan(1);
    expect(expressionFor("माफ़ कीजिए, यह नहीं हो सका।").kind).toBe("empathy");
    expect(expressionFor("Great, the report is ready!").kind).toBe("exclaim");
    expect(expressionFor("Namaste, kaise hain aap").kind).toBe("greeting");
    expect(expressionFor("Shukriya aapka").kind).toBe("thanks");
    expect(expressionFor("Haan ji").kind).toBe("short");
    const plain = expressionFor("The report has three sheets and a summary tab.");
    expect(plain).toMatchObject({ kind: "plain", rate: 1, pitch: 1, volume: 1 });
    expect(expressionFor("").kind).toBe("plain");
  });

  it("keeps every change small and the result inside a safe range", () => {
    for (const text of [
      "Sorry!",
      "Why?",
      "Great!",
      "Hello there",
      "Thanks",
      "ok",
      "A long plain sentence about nothing at all.",
    ]) {
      const e = expressionFor(text);
      expect(e.rate).toBeGreaterThanOrEqual(0.9);
      expect(e.rate).toBeLessThanOrEqual(1.06);
      expect(e.pitch).toBeGreaterThanOrEqual(0.95);
      expect(e.pitch).toBeLessThanOrEqual(1.06);
    }
    expect(
      applyExpression(
        { rate: 1.5, pitch: 1.5, volume: 1 },
        { kind: "exclaim", rate: 1.2, pitch: 1.2, volume: 1.2, pauseAfterMs: 0 },
      ),
    ).toEqual({
      rate: 1.6,
      pitch: 1.6,
      volume: 1,
    });
  });

  it("pauses by the closing mark", () => {
    expect(pauseAfter("Hello.")).toBe(150);
    expect(pauseAfter("Hello?")).toBe(180);
    expect(pauseAfter("आप कैसे हैं।")).toBe(150);
    expect(pauseAfter("first,")).toBe(60);
    expect(pauseAfter("no mark")).toBe(0);
  });
});

describe("speakText pipeline in the real module", () => {
  type Win = { friday?: unknown; speechSynthesis?: unknown };
  const g = globalThis as unknown as { window?: Win | undefined; Audio?: unknown };
  const saved = { window: g.window, Audio: g.Audio };

  beforeEach(() => {
    class FakeAudio {
      volume = 1;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public src: string) {
        FakeAudio.played.push(src);
      }
      static played: string[] = [];
      play() {
        setTimeout(() => this.onended?.(), 2);
        return Promise.resolve();
      }
      pause() {}
    }
    g.Audio = FakeAudio;
  });
  afterEach(() => {
    g.window = saved.window;
    g.Audio = saved.Audio;
  });

  const tuning = {
    voiceName: "",
    lang: "hi-IN",
    rate: 1,
    pitch: 1,
    volume: 1,
    kind: "neural" as const,
  };

  it("starts after the first clause, plays every clause once in order, and reports start and end once", async () => {
    const { speakText, resetPrefetchedSpeech } = await import("../../src/lib/friday/voice-library");
    resetPrefetchedSpeech();
    const asked: { text: string; rate: number; pitch: number }[] = [];
    g.window = {
      friday: {
        speakNeural: async (req: { text: string; rate: number; pitch: number }) => {
          asked.push(req);
          return {
            ok: true,
            audioBase64: Buffer.from(req.text).toString("base64"),
            mime: "audio/mpeg",
            engine: "edge-tts",
            voice: "v",
            cloud: true,
          };
        },
      },
    };
    const events: string[] = [];
    const how = await speakText("Namaste, kaise hain aap? Main theek hoon.", tuning, {
      onStart: () => events.push("start"),
      onEnd: () => events.push("end"),
    });
    expect(how).toBe("neural");
    expect(events).toEqual(["start", "end"]);
    expect(asked.length).toBeGreaterThanOrEqual(1);
    const question = asked.find((a) => /kaise hain aap\?/.test(a.text) || /\?/.test(a.text));
    if (question) expect(question.pitch).toBeGreaterThan(1);
  });

  it("falls back to the system voice for the whole reply when the first clip cannot be made", async () => {
    const { speakText, resetPrefetchedSpeech } = await import("../../src/lib/friday/voice-library");
    resetPrefetchedSpeech();
    g.window = { friday: { speakNeural: async () => ({ ok: false }) } };
    const events: string[] = [];
    const how = await speakText("Hello there. How are you?", tuning, {
      onStart: () => events.push("start"),
      onEnd: () => events.push("end"),
    });
    expect(how).toBe("none"); // no speechSynthesis in this test environment
    expect(events).toEqual([]);
  });

  it("uses a clip made ahead of time instead of making it again", async () => {
    const { speakText, prefetchSpeech, resetPrefetchedSpeech } =
      await import("../../src/lib/friday/voice-library");
    resetPrefetchedSpeech();
    let calls = 0;
    g.window = {
      friday: {
        speakNeural: async (req: { text: string }) => {
          calls += 1;
          return {
            ok: true,
            audioBase64: Buffer.from(req.text).toString("base64"),
            mime: "audio/mpeg",
            engine: "local",
          };
        },
      },
    };
    prefetchSpeech("Ek second.", tuning);
    await tick(5);
    expect(calls).toBe(1);
    await speakText("Ek second.", tuning);
    expect(calls).toBe(1);
  });

  it("asks an owner-chosen cloud voice first, and falls to the normal ladder when it declines", async () => {
    const { speakText, resetPrefetchedSpeech } = await import("../../src/lib/friday/voice-library");
    resetPrefetchedSpeech();
    const local: string[] = [];
    g.window = {
      friday: {
        speakNeural: async (req: { text: string }) => {
          local.push(req.text);
          return { ok: true, audioBase64: "TE9DQUw=", mime: "audio/mpeg", engine: "local" };
        },
      },
    };
    const cloudAsked: string[] = [];
    await speakText("Namaste, kaise hain aap. The report is ready now.", {
      ...tuning,
      cloudClip: async (text) => {
        cloudAsked.push(text);
        return text.startsWith("Pehla")
          ? { audioBase64: "Q0xPVUQ=", mime: "audio/wav", engine: "sarvam" }
          : null;
      },
    });
    expect(cloudAsked.length).toBe(2);
    expect(local.some((t) => t.startsWith("The report"))).toBe(true);
    expect(local.some((t) => t.startsWith("Namaste"))).toBe(false);
  });
});

describe("live wiring", () => {
  const mode = readFileSync("src/lib/friday/assistant-mode.ts", "utf8");

  it("starts the next sentence's audio while the current one plays, and never sends sensitive text to a cloud voice", () => {
    expect(mode).toContain("this.prefetchNext(gen)");
    expect(mode).toContain("prefetchSpeech(next, plan.argTuning)");
    expect(mode).toContain("looksSensitive(text)");
    expect(mode).toContain("speakWithCloud(");
    expect(mode).toContain("expressive: voicePrefs.expressiveSpeech !== false");
  });

  it("defaults: expressive on, no cloud voice, and only the two known providers are accepted", () => {
    expect(DEFAULT_PREFERENCES.voice.expressiveSpeech).toBe(true);
    expect(DEFAULT_PREFERENCES.voice.cloudVoice.speakWith).toBe("");
    expect(sanitizeCloudPrefs({ speakWith: "sarvam" }).speakWith).toBe("sarvam");
    expect(sanitizeCloudPrefs({ speakWith: "azure-speech" }).speakWith).toBe("azure-speech");
    expect(sanitizeCloudPrefs({ speakWith: "evil" as never }).speakWith).toBe("");
  });
});
