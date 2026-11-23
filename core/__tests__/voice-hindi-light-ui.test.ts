/**
 * The optional light Hindi voice on the app side: the stored switch, the pure choice for a clause, the request the
 * speak path builds (the engine goes only with Devanagari-only Hindi clauses), the honest fallback line, and the
 * settings row. Fake devices only; nothing here is heard.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_PREFERENCES, preferences } from "../../src/lib/friday/preferences";
import {
  HINDI_LIGHT_ENGINE,
  HINDI_LIGHT_MODEL_ID,
  chooseHindiLightVoice,
  hindiLightFallbackNote,
  hindiLightSpeakable,
} from "../../src/lib/friday/tts-ladder";

const read = (rel: string) =>
  readFileSync(resolve(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

describe("voice.hindiLightVoice preference", () => {
  afterEach(() => preferences.update({ voice: { ...DEFAULT_PREFERENCES.voice } }));

  it("is off by default and an old stored shape reads the default", () => {
    expect(DEFAULT_PREFERENCES.voice.hindiLightVoice).toBe(false);
    const { hindiLightVoice: _gone, ...oldVoice } = DEFAULT_PREFERENCES.voice;
    preferences.importJson(JSON.stringify({ voice: { ...oldVoice, wakeWord: "jarvis" } }));
    expect(preferences.getSnapshot().voice.wakeWord).toBe("jarvis");
    expect(preferences.getSnapshot().voice.hindiLightVoice).toBe(false);
  });

  it("accepts only a real true; junk becomes false; a single other switch never turns it on or off", () => {
    preferences.setVoice({ hindiLightVoice: true });
    expect(preferences.getSnapshot().voice.hindiLightVoice).toBe(true);
    preferences.setVoice({ speechPrep: false });
    expect(preferences.getSnapshot().voice.hindiLightVoice).toBe(true);
    preferences.importJson(JSON.stringify({ voice: { hindiLightVoice: "yes" } }));
    expect(preferences.getSnapshot().voice.hindiLightVoice).toBe(false);
    preferences.importJson(JSON.stringify({ voice: { hindiLightVoice: 1 } }));
    expect(preferences.getSnapshot().voice.hindiLightVoice).toBe(false);
  });

  it("is a known key of the flow registry", () => {
    expect(read("src/lib/friday/flow-registry.gen.ts")).toContain('"voice.hindiLightVoice"');
  });
});

describe("hindiLightSpeakable mirrors the kernel rule", () => {
  it("accepts a line fully in Devanagari, danda and comma included", () => {
    expect(hindiLightSpeakable("नमस्ते, आप कैसे हैं।")).toBe(true);
  });
  it("refuses Latin, digits, empty and punctuation-only lines", () => {
    for (const line of ["hello", "नमस्ते friday", "आज 5 बजे", "५ बजे", "", "  ", "...", "।"]) {
      expect(hindiLightSpeakable(line), line).toBe(false);
    }
  });
});

describe("chooseHindiLightVoice", () => {
  const base = {
    enabled: true,
    installed: true as boolean | null,
    local: true,
    lang: "hi-IN",
    text: "नमस्ते दोस्त।",
  };
  it("uses the light voice for a Devanagari-only Hindi clause when it is on and installed", () => {
    expect(chooseHindiLightVoice(base)).toEqual({ use: true, note: "" });
  });
  it("setting off: never, and no note", () => {
    expect(chooseHindiLightVoice({ ...base, enabled: false })).toEqual({ use: false, note: "" });
  });
  it("not installed: the usual voice, and the reason is said", () => {
    const out = chooseHindiLightVoice({ ...base, installed: false });
    expect(out.use).toBe(false);
    expect(out.note).toMatch(/not downloaded/);
  });
  it("installed state not known yet: it asks, and the kernel answers for itself", () => {
    expect(chooseHindiLightVoice({ ...base, installed: null }).use).toBe(true);
  });
  it("a cloud-voiced clause, English text and a mixed line never use it", () => {
    expect(chooseHindiLightVoice({ ...base, local: false }).use).toBe(false);
    expect(chooseHindiLightVoice({ ...base, lang: "en-IN", text: "Hello there." }).use).toBe(false);
    expect(chooseHindiLightVoice({ ...base, text: "नमस्ते friday" }).use).toBe(false);
    expect(chooseHindiLightVoice({ ...base, lang: "en-IN" }).use).toBe(false);
  });
  it("knows its engine and model names", () => {
    expect(HINDI_LIGHT_ENGINE).toBe("hindi-light");
    expect(HINDI_LIGHT_MODEL_ID).toBe("hindi-light-tts");
  });
});

describe("hindiLightFallbackNote", () => {
  it("is empty when the light voice spoke", () => {
    expect(hindiLightFallbackNote({ engine: "hindi-light" })).toBe("");
  });
  it("names the reason the kernel gave, and still speaks when none is given", () => {
    expect(
      hindiLightFallbackNote({ engine: "supertonic-3", fallback: "hindi-light-not-installed" }),
    ).toMatch(/not downloaded/);
    expect(
      hindiLightFallbackNote({ engine: "supertonic-3", fallback: "hindi-light-failed" }),
    ).toMatch(/failed/);
    expect(hindiLightFallbackNote({ engine: "supertonic-3" })).toMatch(/no reason was given/);
    expect(hindiLightFallbackNote({ fallback: "weird<code>" })).toMatch(/weird/);
  });
});

describe("speakText builds the engine request only for Hindi-script clauses", () => {
  type Win = Record<string, unknown> & { AudioContext?: unknown };
  const g = globalThis as unknown as { window?: Win | undefined; Audio?: unknown };
  const saved = { window: g.window, Audio: g.Audio };
  const tuning = {
    voiceName: "",
    lang: "hi-IN",
    rate: 1,
    pitch: 1,
    volume: 0.8,
    kind: "neural" as const,
  };
  type Req = { text: string; engine?: string; lang?: string };
  let pcmAsked: Req[];
  let wavAsked: string[];
  let lib: typeof import("../../src/lib/friday/voice-library");

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

  const reply = (engine: string, extra: Record<string, unknown> = {}) => {
    const view = new Int16Array(441).fill(3000);
    return {
      ok: true,
      engine,
      voice: "F2",
      sampleRate: 44_100,
      pcm: new Uint8Array(view.buffer),
      ...extra,
    };
  };

  const bridge = (over: Record<string, unknown> = {}): Win => ({
    AudioContext: FakeContext,
    friday: {
      speakNeuralPcm: async (req: Req) => {
        pcmAsked.push(req);
        return reply(req.engine === "hindi-light" ? "hindi-light" : "supertonic-3");
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

  beforeEach(async () => {
    pcmAsked = [];
    wavAsked = [];
    class FakeAudio {
      volume = 1;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public src: string) {}
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
    lib.setHindiLightInstalledProbe(() => true);
    preferences.update({ voice: { ...DEFAULT_PREFERENCES.voice, hindiLightVoice: true } });
  });
  afterEach(() => {
    lib.stopSpeaking();
    lib.resetPcmPlayback();
    lib.setHindiLightInstalledProbe(null);
    g.window = saved.window;
    g.Audio = saved.Audio;
    preferences.update({ voice: { ...DEFAULT_PREFERENCES.voice } });
  });

  it("asks for the light voice for a Devanagari-only clause, and the route names the engine that spoke", async () => {
    g.window = bridge();
    const how = await lib.speakText("नमस्ते दोस्त।", tuning);
    expect(how).toBe("neural");
    expect(pcmAsked).toHaveLength(1);
    expect(pcmAsked[0]?.engine).toBe("hindi-light");
    expect(lib.lastSpeechRoute().engine).toBe("hindi-light");
    expect(lib.hindiLightNote()).toBe("");
    expect(wavAsked).toEqual([]);
  });

  it("sends no engine for English, mixed, or when the setting is off, and a reply stays the same", async () => {
    preferences.setVoice({ pcmPlayback: true });
    g.window = bridge();
    await lib.speakText("Hello there my friend.", { ...tuning, lang: "en-IN" });
    await lib.speakText("नमस्ते friday।", tuning);
    preferences.setVoice({ hindiLightVoice: false });
    await lib.speakText("नमस्ते दोस्त।", tuning);
    expect(pcmAsked.length).toBeGreaterThan(0);
    for (const req of pcmAsked) expect("engine" in req).toBe(false);
  });

  it("asks per clause: only the Devanagari-only clause of a mixed reply carries the engine", async () => {
    g.window = bridge();
    await lib.speakText("नमस्ते दोस्त। Hello there my friend.", tuning);
    const byText = new Map(pcmAsked.map((req) => [req.text, req.engine]));
    expect(byText.get("नमस्ते दोस्त।")).toBe("hindi-light");
    expect(byText.get("Hello there my friend.")).toBeUndefined();
  });

  it("does not ask when the Models page says it is not installed, and says so", async () => {
    lib.setHindiLightInstalledProbe(() => false);
    preferences.setVoice({ pcmPlayback: true });
    g.window = bridge();
    await lib.speakText("नमस्ते दोस्त।", tuning);
    expect(pcmAsked[0]).toBeDefined();
    expect("engine" in (pcmAsked[0] as Req)).toBe(false);
    expect(lib.hindiLightNote()).toMatch(/not downloaded/);
  });

  it("a cloud voice for the clause never carries the engine", async () => {
    g.window = bridge();
    await lib.speakText("नमस्ते दोस्त।", { ...tuning, voiceName: "hi-IN-SwaraNeural" });
    expect(pcmAsked.filter((req) => req.engine)).toEqual([]);
  });

  it("privacy mode keeps the local engine allowed (it runs on this PC) and the clause still carries it", async () => {
    preferences.setVoice({ privacyMode: true });
    g.window = bridge();
    await lib.speakText("नमस्ते दोस्त।", { ...tuning, allowCloud: false });
    expect(pcmAsked[0]?.engine).toBe("hindi-light");
  });

  it("a fallback reply (the standard voice spoke) is played and said in the note, never silent", async () => {
    g.window = bridge({
      speakNeuralPcm: async (req: Req) => {
        pcmAsked.push(req);
        return reply("supertonic-3", { fallback: "hindi-light-not-installed" });
      },
    });
    const how = await lib.speakText("नमस्ते दोस्त।", tuning);
    expect(how).toBe("neural");
    expect(lib.lastSpeechRoute().engine).toBe("supertonic-3");
    expect(lib.hindiLightNote()).toMatch(/not downloaded/);
    expect(wavAsked).toEqual([]);
  });

  it("when the raw sample op fails the clause is made again as a file with the old path, and the engine is not asked", async () => {
    g.window = bridge({
      speakNeuralPcm: async (req: Req) => {
        pcmAsked.push(req);
        return { ok: false, reason: "worker is not running" };
      },
    });
    const how = await lib.speakText("नमस्ते दोस्त।", tuning);
    expect(how).toBe("neural");
    expect(wavAsked).toEqual(["नमस्ते दोस्त।"]);
    expect(lib.pcmPlaybackNote()).toMatch(/worker is not running/);
  });
});

describe("the settings row and the docs", () => {
  it("has one honest switch row wired to the stored key", () => {
    const source = read("src/components/friday/settings/VoiceSettings.tsx");
    expect(source).toContain(
      "Use the light Hindi voice for Hindi (optional download, CC-BY-4.0 credit: Sulabh Katiyar, AI4Bharat Rasa)",
    );
    expect(source).toContain("on={prefs.voice.hindiLightVoice === true}");
    expect(source).toContain(
      "preferences.setVoice({ hindiLightVoice: prefs.voice.hindiLightVoice !== true })",
    );
    expect(source).toMatch(/Off by default and not yet heard on your PC/);
  });
});
