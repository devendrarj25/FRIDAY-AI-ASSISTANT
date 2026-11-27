/**
 * The renderer side of the speaking engine's honesty: tags never reach a voice that cannot take them, a warm-up is
 * retried, the Doctor rows tell a cold view, a failed call and an unready engine apart, a refused or muted line
 * leaves no tag mark behind, and the Settings previews are labelled, icon-only per row and gated on Auto mode.
 * The bridge is a fake and nothing here reads the clock, the network or a model.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_PREFERENCES, preferences } from "../../src/lib/friday/preferences";
import {
  fridayVoiceRows,
  readFridayVoiceStatus,
} from "../../src/lib/friday/voice-diagnostics-rows";
import { fridayVoiceDoctorRows, noteFridayVoiceStatus } from "../../src/lib/friday/voice-doctor";
import { localVoicePickerState } from "../../src/lib/friday/voice-engine/friday-voice-profile";

const root = resolve(import.meta.dirname, "../..");
const source = (rel: string) => readFileSync(resolve(root, rel), "utf8").replace(/\r\n/g, "\n");

type Win = Record<string, unknown> & { AudioContext?: unknown };
const g = globalThis as unknown as {
  window?: Win | undefined;
  Audio?: unknown;
  SpeechSynthesisUtterance?: unknown;
};

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
const pcmReply = (engine: string) => ({
  ok: true,
  engine,
  voice: "friday",
  sampleRate: 44_100,
  pcm: new Uint8Array(new Int16Array(441).fill(3000).buffer),
});

describe("tags stay off what cannot take them", () => {
  const saved = {
    window: g.window,
    Audio: g.Audio,
    Utterance: g.SpeechSynthesisUtterance,
  };
  const tuning = {
    voiceName: "",
    lang: "hi-IN",
    rate: 1,
    pitch: 1,
    volume: 0.8,
    kind: "neural" as const,
    deliveryTags: true,
  };
  let lib: typeof import("../../src/lib/friday/voice-library");
  let pcmAsked: Array<{ text: string; engine?: string; trusted?: boolean }>;
  let spoken: string[];

  beforeEach(async () => {
    pcmAsked = [];
    spoken = [];
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
    g.SpeechSynthesisUtterance = saved.Utterance;
    preferences.update({ voice: { ...DEFAULT_PREFERENCES.voice } });
  });

  it("a tagged Devanagari clause goes to the light Hindi voice as plain words", async () => {
    g.window = {
      AudioContext: FakeContext,
      friday: {
        speakNeuralPcm: async (req: { text: string; engine?: string; trusted?: boolean }) => {
          pcmAsked.push(req);
          return pcmReply(req.engine === "hindi-light" ? "hindi-light" : "friday-voice");
        },
        speakNeural: async () => ({ ok: false, reason: "not used" }),
      },
    };
    await lib.speakText("[warm] नमस्ते दोस्त।", tuning);
    expect(pcmAsked).toHaveLength(1);
    expect(pcmAsked[0]?.engine).toBe("hindi-light");
    expect(pcmAsked[0]?.text).toBe("नमस्ते दोस्त।");
    expect(pcmAsked[0]?.trusted).toBeUndefined();
  });

  it("the last system-voice fallback speaks the words without any tag", async () => {
    g.SpeechSynthesisUtterance = class {
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onboundary: ((event: unknown) => void) | null = null;
      lang = "";
      rate = 1;
      pitch = 1;
      volume = 1;
      voice: unknown = null;
      constructor(public text: string) {}
    };
    const win: Win = {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      speechSynthesis: {
        getVoices: () => [],
        cancel: () => {},
        speak: (utter: { text: string; onstart?: () => void; onend?: () => void }) => {
          spoken.push(utter.text);
          setTimeout(() => {
            utter.onstart?.();
            utter.onend?.();
          }, 1);
        },
      },
      friday: {
        speakNeuralPcm: async () => ({ ok: false, reason: "worker is not running" }),
        speakNeural: async () => ({ ok: false, reason: "no local voice" }),
      },
    };
    g.window = win;
    const how = await lib.speakText("[warm] Hello there my friend. [soft] How are you?", tuning);
    expect(how).toBe("system");
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toBe("Hello there my friend. How are you?");
    expect(spoken[0]).not.toMatch(/[[\]]/);
  });
});

describe("the voice engine warm-up is retried until it works", () => {
  type Warm = { warm?: boolean };
  let lib: typeof import("../../src/lib/friday/voice-prewarm");
  const saved = g.window;
  const state = { mode: "auto", micOpen: true, held: false, localVoice: true };
  let asked: Warm[];
  let warmOk: boolean;

  beforeEach(async () => {
    asked = [];
    warmOk = false;
    lib = await import("../../src/lib/friday/voice-prewarm");
    lib.cancelPrewarm();
    lib.resetVoiceEngineWarm();
    preferences.update({ voice: { ...DEFAULT_PREFERENCES.voice } });
    g.window = {
      friday: {
        sttStatus: async () => ({ available: true, ready: true, model: "base" }),
        transcribe: async () => ({ ok: true, text: "" }),
        scoreTurn: async () => ({ ok: true, ready: true, probability: 0.9 }),
        neuralVoiceStatus: async () => ({ available: true }),
        speakNeuralPcm: async (req: Warm) => {
          asked.push(req);
          if (req.warm === true) return warmOk ? { ok: true } : { ok: false, reason: "not ready" };
          return pcmReply("friday-voice");
        },
      },
    };
  });
  afterEach(() => {
    lib.cancelPrewarm();
    lib.resetVoiceEngineWarm();
    g.window = saved;
  });

  it("asks again on the next prewarm after a failure, then stops once it worked", async () => {
    await lib.startPrewarm(state);
    lib.cancelPrewarm();
    warmOk = true;
    await lib.startPrewarm(state);
    lib.cancelPrewarm();
    await lib.startPrewarm(state);
    expect(asked.filter((req) => req.warm === true)).toHaveLength(2);
  });

  it("gives up after three failed tries in one run", async () => {
    for (let i = 0; i < 5; i += 1) {
      await lib.startPrewarm(state);
      lib.cancelPrewarm();
    }
    expect(asked.filter((req) => req.warm === true)).toHaveLength(3);
  });

  it("is source-pinned: the flag is set only after the engine said ok", () => {
    const src = source("src/lib/friday/voice-prewarm.ts");
    const body = src.slice(src.indexOf("async function warmVoiceEngineOnce"));
    expect(body.indexOf("await api")).toBeLessThan(body.indexOf("engineWarmed = true"));
  });
});

describe("the FRIDAY Voice Doctor rows", () => {
  const ready = {
    engine: "friday-voice",
    own: true,
    ready: true,
    voiceId: "friday",
    sampleRate: 44100,
    recipeVersion: 3,
  };

  it("says when the view is cold, and not when the worker answered live", () => {
    const cold = fridayVoiceRows(readFridayVoiceStatus({ ...ready, live: false }));
    expect(cold[0]?.value).toMatch(/cold view/);
    const live = fridayVoiceRows(readFridayVoiceStatus({ ...ready, live: true }));
    expect(live[0]?.value).not.toMatch(/cold view/);
    const unknown = fridayVoiceRows(readFridayVoiceStatus(ready));
    expect(unknown[0]?.value).not.toMatch(/cold view/);
  });

  it("separates installed-but-not-ready from not installed", () => {
    const unready = fridayVoiceRows(
      readFridayVoiceStatus({ ...ready, ready: false, reason: "model failed to load" }),
    );
    expect(unready[0]?.value).toMatch(/installed but not ready.*model failed to load/);
    expect(unready[0]?.value).not.toMatch(/not installed/);
    expect(unready[1]?.value).toMatch(/installed but not ready/);
    const missing = fridayVoiceRows(readFridayVoiceStatus({ engine: "none", reason: "no folder" }));
    expect(missing[0]?.value).toMatch(/^not installed/);
    expect(missing[0]?.value).not.toMatch(/installed but not ready/);
  });

  it("reports the live failure count of the running worker", () => {
    const rows = fridayVoiceRows(readFridayVoiceStatus({ ...ready, live: true, failures: 2 }));
    expect(rows[0]?.value).toMatch(/2 failed this run/);
    expect(readFridayVoiceStatus({ ...ready, failures: -3 })?.failures).toBe(0);
    expect(readFridayVoiceStatus({ ...ready, state: "<b>" })?.state).toBe("");
  });

  it("a failed status call reads as that, never as a missing desktop app", () => {
    noteFridayVoiceStatus(null, new Error("pipe closed\nby peer"));
    const rows = fridayVoiceDoctorRows();
    expect(rows[0]?.detail).toMatch(/status call failed: pipe closed by peer/);
    expect(rows[0]?.detail).not.toMatch(/needs the desktop app/);
    expect(rows.every((row) => row.status === "Warning")).toBe(true);
    noteFridayVoiceStatus(undefined);
    expect(fridayVoiceDoctorRows()[0]?.detail).toMatch(/needs the desktop app/);
    noteFridayVoiceStatus(ready);
    expect(fridayVoiceDoctorRows()[0]?.detail).toMatch(/own runner ready/);
    noteFridayVoiceStatus(undefined);
  });

  it("the Doctor scan passes the failure of the call on", () => {
    const engine = source("src/lib/friday/doctor-engine.ts");
    expect(engine).toMatch(/noteFridayVoiceStatus\(null, failure/);
    expect(engine).not.toMatch(/catch \{\s*noteFridayVoiceStatus\(null\);/);
  });

  it("the picker tells installed-but-not-ready from not installed", () => {
    const base = { loading: false, desktop: true };
    const unready = localVoicePickerState({
      ...base,
      status: readFridayVoiceStatus({ ...ready, ready: false, reason: "warming" }),
    });
    expect(unready.kind).toBe("unready");
    expect(unready.note).toMatch(/installed but not ready \(warming\)/);
    expect(
      localVoicePickerState({ ...base, status: readFridayVoiceStatus({ engine: "none" }) }).kind,
    ).toBe("empty");
  });
});

describe("a tag mark never outlives its line", () => {
  const mode = source("src/lib/friday/assistant-mode.ts");

  it("is removed when the speech queue refuses the line", () => {
    const at = mode.indexOf("if (!queued.accepted) {");
    expect(at).toBeGreaterThan(0);
    const refused = mode.slice(at, at + 400);
    expect(refused).toContain("this.taggedLines.delete(prepared)");
  });

  it("is cleared where the mute path clears the arbiter", () => {
    const at = mode.indexOf(
      "if (!spokenReplyAllowed(this.state.mode, this.state.muted) || this.stopped())",
    );
    expect(at).toBeGreaterThan(0);
    expect(mode.slice(at, at + 260)).toMatch(
      /this\.arbiter\.clear\(\);\s*this\.taggedLines\.clear\(\);/,
    );
  });
});

describe("the Settings previews", () => {
  const page = source("src/components/friday/settings/VoiceSettings.tsx");
  const picker = page.slice(page.indexOf("function LocalVoicePicker"));

  it("use the speaker icon, not the microphone", () => {
    const body = picker.slice(0, picker.indexOf("function VoiceLibraryPanel"));
    expect(body).toContain("Volume2");
    expect(body).not.toContain("<Mic");
    expect(page).toMatch(/Volume2,?\s*\} from "lucide-react"/);
  });

  it("name the chosen voice on the main button and are icon-only per row with a label", () => {
    expect(picker).toContain("aria-label={`Preview ${chosenLabel}`}");
    expect(picker).toContain("aria-label={`Preview ${choice.label}`}");
    const row = picker.slice(picker.indexOf("<li key"), picker.indexOf("</li>"));
    expect(row).not.toMatch(/>\s*Preview\s*</);
    expect(row).toContain("<Volume2");
  });

  it("are disabled with a visible hint when the mode is not Auto", () => {
    expect(picker).toContain('useAssistantMode().mode === "auto"');
    expect(picker).toContain("disabled={!canPreview}");
    expect(picker).toMatch(/Previews play in Auto mode only/);
    expect(picker).toContain("aria-describedby");
  });
});
