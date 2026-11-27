/**
 * The default speaking voice is FRIDAY Voice: what the clip maker asks the speech bridge for with privacy mode on and
 * off, what a clause with no explicit voice gets, and how the conductor wires the ladder. Fake bridge, fake audio,
 * no network and no timers beyond the fake player's.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_PREFERENCES, preferences } from "../../src/lib/friday/preferences";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

type Win = { friday?: unknown; speechSynthesis?: unknown };
const g = globalThis as unknown as { window?: Win | undefined; Audio?: unknown };
const saved = { window: g.window, Audio: g.Audio };

beforeEach(async () => {
  class FakeAudio {
    volume = 1;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    play() {
      setTimeout(() => this.onended?.(), 2);
      return Promise.resolve();
    }
    pause() {}
  }
  g.Audio = FakeAudio;
  await preferences.hydrate();
  preferences.update({ voice: { ...DEFAULT_PREFERENCES.voice, models: [], activeId: "" } });
});
afterEach(() => {
  g.window = saved.window;
  g.Audio = saved.Audio;
});

async function askedVoices(
  tuning: Record<string, unknown>,
  privacyMode: boolean,
): Promise<string[]> {
  const { speakText, resetPrefetchedSpeech } = await import("../../src/lib/friday/voice-library");
  resetPrefetchedSpeech();
  preferences.setVoice({ privacyMode });
  const asked: string[] = [];
  g.window = {
    friday: {
      speakNeural: async (req: { text: string; voice?: string }) => {
        asked.push(req.voice ?? "");
        return {
          ok: true,
          audioBase64: Buffer.from(req.text).toString("base64"),
          mime: "audio/wav",
          engine: req.voice ? "edge-tts" : "supertonic",
          voice: req.voice ?? "",
          cloud: Boolean(req.voice),
        };
      },
    },
  };
  await speakText("Namaste, main FRIDAY hoon.", {
    voiceName: "",
    lang: "hi-IN",
    rate: 1,
    pitch: 1,
    volume: 1,
    ...tuning,
  } as never);
  preferences.setVoice({ privacyMode: false });
  return asked;
}

describe("what the speech bridge is asked for", () => {
  it("is FRIDAY Voice (no cloud voice id) for a local tuning, with privacy mode on or off", async () => {
    for (const privacyMode of [false, true]) {
      const asked = await askedVoices({ kind: "neural", allowCloud: !privacyMode }, privacyMode);
      expect(asked.length).toBeGreaterThanOrEqual(1);
      expect(
        asked.every((voice) => voice === ""),
        String(privacyMode),
      ).toBe(true);
    }
  });

  it("is FRIDAY Voice for a preview or a notification, which carry no voice kind at all", async () => {
    const asked = await askedVoices({ allowCloud: true }, false);
    expect(asked.length).toBeGreaterThanOrEqual(1);
    expect(asked.every((voice) => voice === "")).toBe(true);
  });

  it("asks the cloud only for an explicit Neural voice, and never under privacy mode", async () => {
    const own = await askedVoices(
      { kind: "neural", voiceName: "hi-IN-MadhurNeural", allowCloud: true },
      false,
    );
    expect(own.length).toBeGreaterThanOrEqual(1);
    expect(own.every((voice) => /Neural$/.test(voice))).toBe(true);
    const fallback = await askedVoices(
      { kind: "neural", voiceName: "hi-IN-SwaraNeural", allowCloud: true },
      false,
    );
    expect(fallback.every((voice) => voice === "hi-IN-SwaraNeural")).toBe(true);
    const private_ = await askedVoices(
      { kind: "neural", voiceName: "hi-IN-MadhurNeural", allowCloud: false },
      true,
    );
    expect(private_.every((voice) => voice === "")).toBe(true);
  });
});

describe("how the conductor wires the ladder", () => {
  const mode = read("src/lib/friday/assistant-mode.ts");
  const library = read("src/lib/friday/voice-library.ts");

  it("keeps FRIDAY Voice for a private line when it is ready, and the system voice only when it is not", () => {
    expect(mode).toMatch(
      /const systemVoice = fallen === "sapi" \|\| \(privacy && fallen !== "supertonic"\)/,
    );
    expect(mode).toMatch(/kind: \(systemVoice \? "system" : "neural"\)/);
    expect(library).toMatch(/privateVoice: "local"/);
  });

  it("takes the cloud rung only from an explicit Neural pick or when FRIDAY Voice cannot speak", () => {
    expect(mode).toMatch(/prefer: this\.ttsPrefer === "auto" && ownerPickedCloud \? "neural"/);
    expect(mode).toMatch(/voiceName: cloudFallbackVoice\(spokenLang\.lang\)/);
    expect(mode).toMatch(/allowCloud: fallen === "neural" && !privacy && !localOnly/);
  });

  it("reads FRIDAY Voice readiness as soon as the installer is subscribed", () => {
    // TEST_REWRITE_OK: readiness is recomputed from the install on every event (it can turn off), not only set true.
    expect(mode).toMatch(
      /this\.offlineVoiceReady = Boolean\(installer\.getSnapshot\(\)\.installed\["supertonic"\]\);\s*\}\);/,
    );
    expect(mode).not.toMatch(/installed\["supertonic"\]\) this\.offlineVoiceReady = true;/);
  });
});
