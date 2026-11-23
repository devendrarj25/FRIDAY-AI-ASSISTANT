/**
 * Settings > Voice pickers: microphone, speaker, noise suppression, speech model size and voice engine.
 *
 * The rules are pure (`audio-devices.ts`, `voice-choices.ts`), the keys go through `preferences.ts` with defaults and
 * a sanitiser for an old or odd stored shape, and each choice is honoured where it is used: the microphone opens with
 * the saved device and noise-suppression constraint (`voice-audio.ts`), the speaker is set before a clip plays and a
 * missing one falls back to the default (`voice-library.ts`), and a pinned voice engine keeps the other kinds out of a
 * line. Nothing here opens a real device, an engine or the network.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PREFERENCES,
  STT_SIZE_PICKS,
  TTS_ENGINE_PICKS,
  preferences,
  sanitizeDeviceId,
  sanitizeSttSize,
  sanitizeTtsEngine,
} from "../../src/lib/friday/preferences";
import {
  deviceOptions,
  planSavedDevice,
  routeToSpeaker,
} from "../../src/lib/friday/voice-engine/audio-devices";
import {
  sttChoices,
  ttsChoices,
  ttsEnginePlan,
} from "../../src/lib/friday/voice-engine/voice-choices";
import { STT_SIZE_MODEL, voiceModelFacts } from "../../src/lib/friday/model-catalog";
import { assistantMode } from "../../src/lib/friday/assistant-mode";
import { capturePlan, voiceGate } from "../../src/lib/friday/voice-audio";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

describe("the stored keys: defaults, sanitiser, old shapes", () => {
  it("ship today's behaviour: system devices, noise suppression on, the automatic voice order", () => {
    expect(DEFAULT_PREFERENCES.voice.inputDeviceId).toBe("");
    expect(DEFAULT_PREFERENCES.voice.outputDeviceId).toBe("");
    expect(DEFAULT_PREFERENCES.voice.noiseSuppression).toBe(true);
    expect(DEFAULT_PREFERENCES.voice.ttsEngine).toBe("auto");
    expect(DEFAULT_PREFERENCES.voice.sttSize).toBe("auto");
  });

  it("the sanitisers turn junk into the default and keep a good value", () => {
    expect(sanitizeTtsEngine("sapi")).toBe("sapi");
    expect(sanitizeTtsEngine("supertonic")).toBe("supertonic");
    for (const junk of ["neural", "", null, undefined, 4, {}]) {
      expect(sanitizeTtsEngine(junk)).toBe("auto");
    }
    expect(sanitizeSttSize("small")).toBe("small");
    for (const junk of ["huge", "", null, 3]) expect(sanitizeSttSize(junk)).toBe("auto");
    expect(sanitizeDeviceId("  abc123  ")).toBe("abc123");
    expect(sanitizeDeviceId(12)).toBe("");
    expect(sanitizeDeviceId(null)).toBe("");
    expect(sanitizeDeviceId("x".repeat(900)).length).toBe(400);
  });

  it("an old stored shape without the new keys reads the defaults; odd values are made safe", () => {
    const before = preferences.getSnapshot().voice;
    try {
      preferences.update({
        voice: {
          ttsEngine: "bogus",
          sttSize: "gigantic",
          outputDeviceId: 7,
          noiseSuppression: false,
        } as never,
      });
      const now = preferences.getSnapshot().voice;
      expect(now.ttsEngine).toBe("auto");
      expect(now.sttSize).toBe("auto");
      expect(now.outputDeviceId).toBe("");
      expect(now.noiseSuppression).toBe(false);
      // A later partial patch (one slider) does not reset the choice.
      preferences.setVoice({ rate: 1 });
      expect(preferences.getSnapshot().voice.noiseSuppression).toBe(false);
    } finally {
      preferences.setVoice({
        ttsEngine: before.ttsEngine,
        sttSize: before.sttSize,
        outputDeviceId: before.outputDeviceId,
        noiseSuppression: before.noiseSuppression,
        rate: before.rate,
      });
    }
  });

  it("the pick lists are the registries, not typed lists", () => {
    expect([...STT_SIZE_PICKS].filter((v) => v !== "auto").sort()).toEqual(
      Object.keys(STT_SIZE_MODEL).sort(),
    );
    expect([...TTS_ENGINE_PICKS]).toEqual(["auto", "supertonic", "sapi"]);
    expect(ttsChoices({ localReady: null, systemVoices: null }).map((row) => row.value)).toEqual([
      ...TTS_ENGINE_PICKS,
    ]);
  });
});

describe("devices: the saved choice, the picker rows and the not-found fallback", () => {
  const list = [
    { id: "default", label: "Default - Headset" },
    { id: "communications", label: "Communications - Headset" },
    { id: "mic-a", label: "USB microphone" },
    { id: "mic-b", label: "Laptop array" },
  ];

  it("nothing saved, or the default alias, is the system default with nothing to say", () => {
    for (const saved of ["", "  ", "default", "communications", null, undefined]) {
      expect(planSavedDevice("microphone", saved, list)).toEqual({
        deviceId: "",
        found: true,
        note: "",
      });
    }
  });

  it("a saved device that is plugged in is used; one that is gone falls back and says so", () => {
    expect(planSavedDevice("microphone", "mic-a", list)).toMatchObject({
      deviceId: "mic-a",
      found: true,
    });
    const gone = planSavedDevice("speaker", "spk-9", list);
    expect(gone.deviceId).toBe("");
    expect(gone.found).toBe(false);
    expect(gone.note).toMatch(/saved speaker is not connected/);
    expect(planSavedDevice("microphone", "mic-z", []).note).toMatch(/saved microphone/);
  });

  it("the rows: system default first, aliases folded away, a missing saved device shown as not found", () => {
    const rows = deviceOptions("microphone", "mic-a", list);
    expect(rows.map((row) => row.value)).toEqual(["", "mic-a", "mic-b"]);
    expect(rows[0]?.label).toBe("System default");
    const missing = deviceOptions("microphone", "mic-gone", list);
    expect(missing.at(-1)).toMatchObject({ value: "mic-gone", missing: true });
    expect(missing.at(-1)?.label).toMatch(/not found/);
    // An empty list still shows the default row, never a blank select.
    expect(deviceOptions("speaker", "", [])).toEqual([
      { value: "", label: "System default", missing: false },
    ]);
    // Duplicate ids and unlabeled devices do not break the rows.
    const odd = deviceOptions("speaker", "", [
      { id: "s1", label: "" },
      { id: "s1", label: "again" },
    ]);
    expect(odd).toHaveLength(2);
    expect(odd[1]?.label).toMatch(/speaker/);
  });

  it("routeToSpeaker sets the saved sink, falls back when it is gone or refused, and never throws", async () => {
    const calls: string[] = [];
    const target = { setSinkId: async (id: string) => void calls.push(id) };
    expect(await routeToSpeaker(target, "mic-a", list)).toMatchObject({
      ok: true,
      deviceId: "mic-a",
      fellBack: false,
    });
    const gone = await routeToSpeaker(target, "spk-gone", list);
    expect(gone).toMatchObject({ ok: true, deviceId: "", fellBack: true });
    expect(gone.note).toMatch(/not connected/);
    expect(calls).toEqual(["mic-a", ""]);

    const refused = { setSinkId: vi.fn().mockRejectedValueOnce(new Error("NotFoundError")) };
    const result = await routeToSpeaker(refused, "mic-a", list);
    expect(result).toMatchObject({ ok: false, deviceId: "", fellBack: true });
    expect(refused.setSinkId).toHaveBeenLastCalledWith("");

    // A browser without setSinkId keeps the default and says so only when a speaker was asked for.
    expect((await routeToSpeaker({}, "mic-a", list)).note).toMatch(/cannot choose a speaker/);
    expect(await routeToSpeaker({}, "", list)).toMatchObject({ ok: true, note: "" });
  });
});

describe("the speech model and voice engine rows", () => {
  const budget = { sttSize: "small", speechBudgetGb: 2.3 };

  it("label the memory each size needs, from the model registry, and whether it fits", () => {
    const rows = sttChoices({ budget, installed: { "faster-whisper-small": "1" } });
    expect(rows[0]?.value).toBe("auto");
    expect(rows[0]?.label).toMatch(/Small for this PC.*2\.3 GB/);
    const small = rows.find((row) => row.value === "small");
    expect(small?.needGb).toBeGreaterThan(voiceModelFacts["faster-whisper-small"]?.minRamGb ?? 0);
    expect(small?.label).toMatch(/GB memory/);
    expect(small?.label).toMatch(/fits this PC/);
    expect(small?.label).toMatch(/downloaded/);
    expect(small?.fits).toBe(true);
    const tiny = rows.find((row) => row.value === "tiny");
    expect(tiny?.label).toMatch(/not downloaded/);
    const medium = rows.find((row) => row.value === "medium");
    expect(medium?.label).toMatch(/needs a verified GPU/);
    expect(rows.map((row) => row.value)).toEqual([...STT_SIZE_PICKS]);
  });

  it("a size over the budget says so; an unknown budget or store claims nothing", () => {
    const tight = sttChoices({ budget: { sttSize: "tiny", speechBudgetGb: 0.5 }, installed: null });
    const small = tight.find((row) => row.value === "small");
    expect(small?.fits).toBe(false);
    expect(small?.label).toMatch(/over this PC's speech budget/);
    expect(small?.installed).toBeNull();
    expect(small?.label).not.toMatch(/downloaded/);
    const unknown = sttChoices({ budget: null, installed: null });
    expect(unknown[0]?.label).toMatch(/measured for this PC/);
    expect(unknown.find((row) => row.value === "base")?.fits).toBeNull();
    expect(unknown.find((row) => row.value === "base")?.label).not.toMatch(/fits this PC/);
  });

  it("the voice rows say which is installed and that a pinned voice stays on this PC", () => {
    const ready = ttsChoices({ localReady: true, systemVoices: 3 });
    expect(ready[1]?.label).toMatch(/installed/);
    expect(ready[1]?.label).not.toMatch(/not installed/);
    expect(ready[2]?.installed).toBe(true);
    expect(ready[1]?.privacy).toBe("on-device");
    const missing = ttsChoices({ localReady: false, systemVoices: 0 });
    expect(missing[1]?.label).toMatch(/not installed/);
    expect(missing[2]?.installed).toBe(false);
    const unknown = ttsChoices({ localReady: null, systemVoices: null });
    expect(unknown[1]?.installed).toBeNull();
    expect(unknown[1]?.label).not.toMatch(/installed/);
  });

  it("ttsEnginePlan: auto keeps today's order, local never asks an online voice, system skips the neural paths", () => {
    expect(ttsEnginePlan("auto")).toEqual({ cloud: true, neural: true });
    expect(ttsEnginePlan(undefined)).toEqual({ cloud: true, neural: true });
    expect(ttsEnginePlan("supertonic")).toEqual({ cloud: false, neural: true });
    expect(ttsEnginePlan("sapi")).toEqual({ cloud: false, neural: false });
    expect(ttsEnginePlan("anything else")).toEqual({ cloud: true, neural: true });
  });
});

describe("the microphone opens with the saved noise-suppression choice", () => {
  it("every step that names processing follows the switch; the bare last step stays bare", () => {
    for (const on of [true, false]) {
      const strict = capturePlan(0, "mic-a", on);
      expect(strict?.audio).toMatchObject({ noiseSuppression: on, echoCancellation: true });
      expect(strict?.audio).toMatchObject({ deviceId: { exact: "mic-a" } });
      expect(capturePlan(1, "mic-a", on)?.audio).toMatchObject({ noiseSuppression: on });
      expect(capturePlan(2, "mic-a", on)?.audio).toBe(true);
      expect(capturePlan(3, "mic-a", on)).toBeNull();
    }
  });

  it("with no device the default is asked for, and the shipped switch is on", () => {
    const plan = capturePlan(0);
    expect(plan?.audio).toMatchObject({ noiseSuppression: true });
    expect(plan?.audio).not.toHaveProperty("deviceId");
    expect(plan).not.toHaveProperty("deviceId");
  });

  it("reads the stored key when no value is passed", () => {
    const before = preferences.getSnapshot().voice.noiseSuppression;
    try {
      preferences.setVoice({ noiseSuppression: false });
      expect(capturePlan(0)?.audio).toMatchObject({ noiseSuppression: false });
      expect(capturePlan(1)?.audio).toMatchObject({ noiseSuppression: false });
    } finally {
      preferences.setVoice({ noiseSuppression: before });
    }
  });
});

describe("a changed microphone is honoured: the input reopens with the saved device, a missing one falls back", () => {
  type Driver = { state: { mode: string; paused: boolean; muted: boolean } };
  const d = assistantMode as unknown as Driver;
  (globalThis as unknown as { window?: unknown }).window ??= globalThis;

  afterEach(() => {
    preferences.setVoice({ inputDeviceId: "" });
    d.state.mode = "manual";
    d.state.muted = false;
    d.state.paused = false;
    vi.restoreAllMocks();
  });

  it("in Auto it restarts the gate; the saved device that is not plugged in is cleared and the default opens", async () => {
    d.state.mode = "auto";
    d.state.muted = false;
    d.state.paused = false;
    preferences.setVoice({ inputDeviceId: "mic-unplugged" });
    const restart = vi.spyOn(voiceGate, "restart").mockResolvedValue(true);
    await assistantMode.applyInputChoice();
    expect(restart).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledWith(null);
    expect(preferences.getSnapshot().voice.inputDeviceId).toBe("");
  });

  it("outside Auto, or muted, or paused, nothing is opened", async () => {
    const restart = vi.spyOn(voiceGate, "restart").mockResolvedValue(true);
    for (const patch of [
      { mode: "manual", muted: false, paused: false },
      { mode: "auto", muted: true, paused: false },
      { mode: "auto", muted: false, paused: true },
    ]) {
      Object.assign(d.state, patch);
      await assistantMode.applyInputChoice();
    }
    expect(restart).not.toHaveBeenCalled();
  });
});

describe("speech honours the saved speaker and the pinned engine (voice library, fake audio)", () => {
  type Win = { friday?: unknown; speechSynthesis?: unknown };
  const g = globalThis as unknown as { window?: Win | undefined; Audio?: unknown };
  const saved = { window: g.window, Audio: g.Audio };
  let events: string[] = [];
  let asked: Array<{ text: string; voice?: string }> = [];
  let cloudAsked = 0;
  const voiceBefore = preferences.getSnapshot().voice;

  const tuning = {
    voiceName: "",
    lang: "en-IN",
    rate: 1,
    pitch: 1,
    volume: 1,
    kind: "neural" as const,
  };

  beforeEach(() => {
    events = [];
    asked = [];
    cloudAsked = 0;
    class FakeAudio {
      volume = 1;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public src: string) {}
      setSinkId(id: string) {
        events.push(`sink:${id}`);
        return Promise.resolve();
      }
      play() {
        events.push("play");
        return Promise.resolve();
      }
      pause() {}
    }
    g.Audio = FakeAudio;
    g.window = {
      friday: {
        speakNeural: async (req: { text: string; voice?: string }) => {
          asked.push(req);
          return {
            ok: true,
            audioBase64: Buffer.from(req.text).toString("base64"),
            mime: "audio/mpeg",
            engine: "local",
          };
        },
      },
    };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: async () => [
          { kind: "audiooutput", deviceId: "spk-1", label: "Desk speakers" },
          { kind: "audioinput", deviceId: "mic-a", label: "USB microphone" },
        ],
      },
    });
  });
  afterEach(async () => {
    const lib = await import("../../src/lib/friday/voice-library");
    lib.stopSpeaking();
    lib.resetPrefetchedSpeech();
    g.window = saved.window;
    g.Audio = saved.Audio;
    vi.unstubAllGlobals();
    preferences.setVoice({
      outputDeviceId: voiceBefore.outputDeviceId,
      ttsEngine: voiceBefore.ttsEngine,
    });
  });

  const speak = async (text: string, extra: Record<string, unknown> = {}) => {
    const lib = await import("../../src/lib/friday/voice-library");
    lib.resetPrefetchedSpeech();
    const done = lib.speakText(text, { ...tuning, ...extra });
    for (let i = 0; i < 200 && !events.includes("play"); i += 1) {
      await new Promise((r) => setTimeout(r, 1));
    }
    lib.stopSpeaking();
    await done;
    return lib;
  };

  it("a saved speaker is set before the first sample plays", async () => {
    preferences.setVoice({ outputDeviceId: "spk-1" });
    await speak("Hello there.");
    expect(events.slice(0, 2)).toEqual(["sink:spk-1", "play"]);
  });

  it("a saved speaker that is gone sends the sound to the default and leaves a note", async () => {
    preferences.setVoice({ outputDeviceId: "spk-unplugged" });
    const lib = await speak("Hello there.");
    expect(events.slice(0, 2)).toEqual(["sink:", "play"]);
    expect(lib.speakerFallbackNote()).toMatch(/not connected/);
  });

  it("with no speaker saved nothing is routed and the clip plays at once", async () => {
    preferences.setVoice({ outputDeviceId: "" });
    const lib = await speak("Hello there.");
    expect(events.filter((e) => e.startsWith("sink"))).toEqual([]);
    expect(events).toContain("play");
    expect(lib.speakerFallbackNote()).toBe("");
  });

  it("the standard local voice pinned: the owner's online clip maker is never asked", async () => {
    const cloudClip = async () => {
      cloudAsked += 1;
      return null;
    };
    preferences.setVoice({ ttsEngine: "auto" });
    await speak("First line.", { cloudClip });
    expect(cloudAsked).toBeGreaterThan(0);
    cloudAsked = 0;
    preferences.setVoice({ ttsEngine: "supertonic" });
    await speak("Second line.", { cloudClip });
    expect(cloudAsked).toBe(0);
    expect(asked.length).toBeGreaterThan(0);
  });

  it("the system voice pinned: the neural voice is not asked at all", async () => {
    preferences.setVoice({ ttsEngine: "sapi" });
    const lib = await import("../../src/lib/friday/voice-library");
    lib.resetPrefetchedSpeech();
    const outcome = await lib.speakText("Hello there.", tuning);
    expect(asked).toEqual([]);
    // No system voices exist in this test window, so nothing speaks, and it says "none" rather than throwing.
    expect(outcome).toBe("none");
  });
});

describe("the screen: every row is wired to a real handler and a real state", () => {
  const pickers = read("src/components/friday/settings/VoiceAudioPickers.tsx");
  const settings = read("src/components/friday/settings/VoiceSettings.tsx");

  it("Settings > Voice mounts the pickers and keeps the old controls' labels", () => {
    expect(settings).toContain("<VoiceAudioPickers />");
    for (const label of ["Microphone", "Speaker", "Speech model size", "Voice engine"]) {
      expect(pickers).toContain(`>${label}</span>`);
    }
    expect(pickers).toContain("Noise suppression on the microphone");
    expect(pickers).toContain("Refresh devices");
    // The row the owner already had is still on the tray-pause path.
    expect(settings).toContain('label="Mute microphone"');
    expect(settings).toContain("assistantMode.setPaused(!voice.paused)");
  });

  it("each change writes the stored key and acts on it", () => {
    expect(pickers).toMatch(/preferences\.setVoice\(\{ inputDeviceId: id \}\)/);
    expect(pickers).toContain("assistantMode.applyInputChoice()");
    expect(pickers).toMatch(/preferences\.setVoice\(\{ outputDeviceId: id \}\)/);
    expect(pickers).toContain("applySpeakerChoice()");
    expect(pickers).toMatch(/noiseSuppression: prefs\.voice\.noiseSuppression === false/);
    expect(pickers).toMatch(/sttSize: sanitizeSttSize\(e\.target\.value\)/);
    expect(pickers).toMatch(/ttsEngine: sanitizeTtsEngine\(e\.target\.value\)/);
  });

  it("shows loading, an error with Retry, the browser-preview state and a refresh without a timer", () => {
    expect(pickers).toContain("<LoadingState");
    expect(pickers).toMatch(/<ErrorState[\s\S]*onRetry=\{refresh\}/);
    expect(pickers).toContain('phase: "unsupported"');
    expect(pickers).toContain('"devicechange"');
    expect(pickers).not.toMatch(/setInterval|setTimeout/);
  });

  it("lists no value typed into the screen: the options come from the registries", () => {
    expect(pickers).not.toMatch(/value="(tiny|base|small|medium|supertonic|sapi|auto)"/);
    expect(pickers).toContain("sttChoices(");
    expect(pickers).toContain("ttsChoices(");
    expect(pickers).toContain("deviceOptions(");
  });

  it("looks the same: only the shared panel and token classes the neighbours use", () => {
    expect(pickers).toContain("hud-tile");
    expect(pickers).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|text-\[\d+px\]/);
  });
});
