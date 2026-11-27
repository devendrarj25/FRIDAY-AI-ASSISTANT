/**
 * When no engine can speak a line, the failure names what is missing: a Devanagari line says that no Hindi voice is
 * installed and where to install one. The raw-sample player's session decision is forgotten when Auto starts and
 * when the speaker worker restarts. The system-voice rung asks for the language the line is written in. The output
 * check is given the real sink id from the cached device list. Fake devices and fake speech only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reset = vi.fn();
let outcome: "none" | "ok" = "none";
vi.mock("../../src/lib/friday/voice-library", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/friday/voice-library")>();
  return {
    ...original,
    resetPcmPlayback: () => reset(),
    speakText: async () => outcome,
  };
});

import { assistantMode } from "../../src/lib/friday/assistant-mode";
import { preferences } from "../../src/lib/friday/preferences";
import { autonomy } from "../../src/lib/friday/self/autonomy";
import {
  cachedOutputSinkId,
  dominantScript,
  fallbackUtterLang,
  noVoiceFailure,
  voiceForLanguage,
} from "../../src/lib/friday/tts-ladder";

type Driver = {
  state: Record<string, unknown> & { mode: string; error: string | null };
  speechGen: number;
  playSpoken: (text: string, gen: number, sensitive?: boolean) => Promise<void>;
  requestTtsRestart: () => void;
  emit: () => void;
};
const d = assistantMode as unknown as Driver;
(globalThis as unknown as { window?: unknown }).window ??= globalThis;

beforeEach(async () => {
  await preferences.hydrate();
  preferences.setVoice({ hinglish: false, speechLang: "en-US", speakReplies: true });
  autonomy.reset();
  Object.assign(d.state, { mode: "auto", error: null });
  d.emit = () => undefined;
  reset.mockClear();
  outcome = "none";
});

afterEach(() => {
  delete (globalThis as unknown as { friday?: unknown }).friday;
  autonomy.reset();
  vi.restoreAllMocks();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("tts-failed names what is missing", () => {
  it("a Devanagari line says no Hindi voice is installed", async () => {
    await d.playSpoken("नमस्ते, आप कैसे हैं", d.speechGen);
    await settle();
    expect(d.state.error).toMatch(/Hindi voice/i);
    expect(d.state.error).toMatch(/Install Manager/i);
  });

  it("an English line keeps the generic install-a-voice line", async () => {
    await d.playSpoken("Hello there, how are you", d.speechGen);
    await settle();
    expect(d.state.error).toMatch(/install a voice/i);
    expect(d.state.error).not.toMatch(/Hindi/i);
  });

  it("the local failure reason is on the error and the status line", async () => {
    (d as unknown as { offlineVoiceReason: string }).offlineVoiceReason = "model files missing";
    await d.playSpoken("Hello there", d.speechGen);
    await settle();
    expect(d.state.error).toMatch(/model files missing/);
    expect(String(d.state["status"])).toMatch(/model files missing/);
    (d as unknown as { offlineVoiceReason: string }).offlineVoiceReason = "";
  });

  it("the helper reads the dominant script", () => {
    expect(dominantScript("नमस्ते friend")).toBe("devanagari");
    expect(dominantScript("hello नमस्ते")).toBe("devanagari");
    expect(dominantScript("hello there friend नमस्ते")).toBe("latin");
    expect(dominantScript("123 ...")).toBe("none");
    expect(noVoiceFailure("नमस्ते")).toMatch(/Hindi/);
  });
});

describe("the raw-sample player is forgotten at a new session", () => {
  it("Auto start forgets it", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g["addEventListener"] ??= () => undefined;
    g["removeEventListener"] ??= () => undefined;
    (d as unknown as { enterAuto: () => void }).enterAuto();
    expect(reset).toHaveBeenCalled();
  });

  it("a speaker restart forgets it", async () => {
    (globalThis as unknown as { friday?: unknown }).friday = {
      restartTts: async () => ({ ok: true, state: "running" }),
    };
    d.requestTtsRestart();
    await settle();
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe("the system voice asks for the language the line is written in", () => {
  it("English Latin text under the Hindi tag asks for en-IN; Devanagari always asks hi-IN", () => {
    expect(fallbackUtterLang("Good morning, how are you", "hi-IN")).toBe("en-IN");
    expect(fallbackUtterLang("सुप्रभात, आप कैसे हैं", "en-IN")).toBe("hi-IN");
    expect(fallbackUtterLang("Good morning", "en-US")).toBe("en-US");
    expect(fallbackUtterLang("42", "hi-IN")).toBe("hi-IN");
    expect(fallbackUtterLang("hello", "")).toBe("en-IN");
  });

  it("the en-in to hi-IN mapping itself is unchanged", () => {
    expect(voiceForLanguage("en-IN").lang).toBe("hi-IN");
    expect(voiceForLanguage("hinglish").lang).toBe("hi-IN");
    expect(voiceForLanguage("en-US").lang).toBe("en-IN");
  });
});

describe("the output check gets the real sink id", () => {
  const out = (id: string, isDefault = false) => ({ id, isDefault });
  it("unknown (never read, unreadable, or not permitted) is 'default'", () => {
    expect(cachedOutputSinkId("", null)).toBe("default");
    expect(cachedOutputSinkId("", { enumerated: false, permitted: false, outputs: [] })).toBe(
      "default",
    );
    expect(
      cachedOutputSinkId("", { enumerated: true, permitted: false, outputs: [out("a")] }),
    ).toBe("default");
  });

  it("permission granted and no outputs is '' (no output device)", () => {
    expect(cachedOutputSinkId("", { enumerated: true, permitted: true, outputs: [] })).toBe("");
  });

  it("a known list names the saved speaker, else the default one", () => {
    const facts = {
      enumerated: true,
      permitted: true,
      outputs: [out("hdmi"), out("speakers", true)],
    };
    expect(cachedOutputSinkId("hdmi", facts)).toBe("hdmi");
    expect(cachedOutputSinkId("gone", facts)).toBe("speakers");
    expect(cachedOutputSinkId("", facts)).toBe("speakers");
  });
});
