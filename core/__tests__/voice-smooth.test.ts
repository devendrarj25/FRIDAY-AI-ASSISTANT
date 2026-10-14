import { readFileSync } from "node:fs";
import { describe, expect, it, afterEach } from "vitest";
import { savedInputPlan } from "../../src/lib/friday/mic-session";
import {
  frameClockJobCount,
  onVisibleFrame,
  onVisibleSecond,
  pumpFrameClock,
  pumpSecondClock,
  resetFrameClock,
  setFrameClockHidden,
} from "../../src/lib/friday/frame-clock";
import {
  ageOf,
  circuitReadoutLines,
  liveGraphicKey,
  voiceCueKey,
} from "../../src/lib/friday/use-friday-live";
import { gateSpeechKey, shouldPublishVad } from "../../src/lib/friday/voice-audio";
import {
  formatVoiceRuntimeLine,
  noteDisplayFrame,
  noteVoiceFrame,
  resetVoiceRenderRate,
  voiceDisplayFps,
  voiceLongTasks,
} from "../../src/lib/friday/voice-doctor";
import {
  cloudVoiceFor,
  NO_INDIAN_VOICE,
  pickSpokenVoice,
  rememberSpeechRoute,
  spokenClauses,
  splitByLanguage,
  statusWithVoice,
} from "../../src/lib/friday/voice-library";

afterEach(() => {
  rememberSpeechRoute({ engine: "", voiceId: "", lang: "", cloud: false, note: "" });
  resetVoiceRenderRate();
  resetFrameClock();
});

describe("spoken Hinglish", () => {
  it("sends Roman Hinglish to Swara as Devanagari and leaves the English clause in English", () => {
    const line = spokenClauses("Hinglish me bolo, kal subah 7 baje meeting hai");
    expect(line).toHaveLength(1);
    expect(line[0]?.lang).toBe("hi-IN");
    const spoken = line[0]?.text ?? "";
    expect(spoken).toContain("कल");
    expect(spoken).toContain("सुबह");
    expect(spoken).toContain("बजे");
    expect(spoken).toContain("है");
    expect(spoken).toContain("7");
    expect(spoken).toContain("meeting");
    expect(spoken).not.toMatch(/\bkal\b/);
    expect(spoken).not.toMatch(/\bsubah\b/);
    expect(spoken).not.toMatch(/\bbaje\b/);

    const english = spokenClauses("Everything is ready");
    expect(english).toEqual([{ text: "Everything is ready", lang: "en-IN" }]);

    const mixed = spokenClauses("नमस्ते सर. Your build finished successfully.");
    expect(mixed.map((part) => part.lang)).toEqual(["hi-IN", "en-IN"]);
    expect(splitByLanguage("नमस्ते सर. Your build finished successfully.")).toHaveLength(2);
    expect(splitByLanguage("Everything is ready")).toHaveLength(1);
  });

  it("does not transliterate names, code, URLs, or email addresses", () => {
    const mail = spokenClauses("kal subah user@example.com hai");
    expect(mail[0]?.text).toContain("user@example.com");
    expect(mail[0]?.text).toContain("कल");

    const url = spokenClauses("Open https://example.com/a now");
    expect(url).toEqual([{ text: "Open https://example.com/a now", lang: "en-IN" }]);

    const code = spokenClauses("`npm run build` chalao");
    expect(code[0]?.text).toContain("`npm run build`");
    expect(code[0]?.text).toContain("चलाओ");

    const name = spokenClauses("Devendra kal aayega");
    expect(name[0]?.text).toContain("Devendra");
    expect(name[0]?.text).toContain("कल");
    expect(name[0]?.text).toContain("आएगा");

    const plain = spokenClauses("Send me the file");
    expect(plain).toEqual([{ text: "Send me the file", lang: "en-IN" }]);
  });
});

describe("default female Indian voice", () => {
  it("asks for Swara on a fresh install and keeps an explicit Neural pick", () => {
    expect(
      cloudVoiceFor(
        { voiceName: "Microsoft Swara Online (Natural) - Hindi (India)" },
        "hi-IN",
        true,
      ),
    ).toBe("hi-IN-SwaraNeural");
    expect(cloudVoiceFor({}, "en-IN", true)).toBe("en-IN-NeerjaNeural");
    expect(cloudVoiceFor({ kind: "neural", voiceName: "" }, "hi-IN", true)).toBe("");
    expect(cloudVoiceFor({ kind: "neural", voiceName: "hi-IN-MadhurNeural" }, "hi-IN", true)).toBe(
      "hi-IN-MadhurNeural",
    );
    expect(cloudVoiceFor({}, "hi-IN", false)).toBe("");
    expect(cloudVoiceFor({ kind: "system", voiceName: "Swara" }, "hi-IN", true)).toBe("");
  });

  it("names an installed female Indian voice and says when none is installed", () => {
    expect(pickSpokenVoice([{ name: "Microsoft David", lang: "en-US" }], "")).toEqual({
      name: "",
      note: NO_INDIAN_VOICE,
    });
    expect(
      pickSpokenVoice(
        [
          { name: "Microsoft David", lang: "en-US" },
          { name: "Microsoft Swara Online", lang: "hi-IN" },
        ],
        "",
      ).name,
    ).toContain("Swara");
    expect(
      pickSpokenVoice([{ name: "Microsoft David", lang: "en-US" }], "Microsoft David").name,
    ).toBe("Microsoft David");
  });

  it("adds the offline voice to the existing status line", () => {
    rememberSpeechRoute({
      engine: "supertonic-3",
      voiceId: "F2",
      lang: "hi",
      cloud: false,
      note: "",
    });
    expect(statusWithVoice("Listening…")).toBe("Listening… · F2");
    rememberSpeechRoute({
      engine: "sapi",
      voiceId: "",
      lang: "hi-IN",
      cloud: false,
      note: NO_INDIAN_VOICE,
    });
    expect(statusWithVoice("Listening…")).toBe(NO_INDIAN_VOICE);
    rememberSpeechRoute({
      engine: "edge-tts",
      voiceId: "hi-IN-SwaraNeural",
      lang: "hi-IN",
      cloud: true,
      note: "",
    });
    expect(statusWithVoice("Listening…")).toBe("Listening…");
  });
});

describe("voice screen render budget", () => {
  it("ignores voice-log updates and hidden level ticks", () => {
    const base = { mode: "auto", voiceState: "LISTENING", paused: false, interim: "" };
    let cueChanges = 0;
    let modeChanges = 0;
    let previousCue = voiceCueKey(base);
    let previousMode = base.mode;
    for (let i = 0; i < 12; i += 1) {
      const next = { ...base, voiceLog: i };
      const cue = voiceCueKey(next);
      if (cue !== previousCue) {
        cueChanges += 1;
        previousCue = cue;
      }
      if (next.mode !== previousMode) {
        modeChanges += 1;
        previousMode = next.mode;
      }
    }
    expect(cueChanges).toBe(0);
    expect(modeChanges).toBe(0);

    const legacyCue = (interim: string) =>
      `auto\u001fLISTENING\u001f0\u001f${interim.slice(0, 24)}`;
    let legacyChanges = 0;
    let cueStable = 0;
    let previousLegacy = "";
    let previousStable = "";
    for (let i = 0; i < 60; i += 1) {
      const interim = `partial ${i} the quick brown fox`;
      const legacy = legacyCue(interim);
      const stable = voiceCueKey({
        mode: "auto",
        voiceState: "LISTENING",
        paused: false,
        interim,
      });
      if (legacy !== previousLegacy) {
        legacyChanges += 1;
        previousLegacy = legacy;
      }
      if (stable !== previousStable) {
        cueStable += 1;
        previousStable = stable;
      }
    }
    expect(legacyChanges).toBe(60);
    expect(cueStable).toBe(1);

    const nodes = [{ id: "intent", active: true, state: "listening", status: "wake word armed" }];
    const graphic = liveGraphicKey({
      voice: "listening",
      action: "Listening for “FRIDAY”",
      emotion: "Relaxed",
      nodes,
    });
    expect(
      liveGraphicKey({
        voice: "listening",
        action: "Listening for “FRIDAY”",
        emotion: "Relaxed",
        nodes,
      }),
    ).toBe(graphic);
    expect(
      liveGraphicKey({
        voice: "speaking",
        action: "Speaking",
        emotion: "Smiling",
        nodes,
      }),
    ).not.toBe(graphic);
    expect(ageOf(1_000, 5_000)).toBe("4s ago");

    let hiddenLevels = 0;
    for (let i = 0; i < 10; i += 1) {
      if (
        shouldPublishVad({ speechChanged: false, hidden: true, elapsedMs: 1000, levelDelta: 0.5 })
      ) {
        hiddenLevels += 1;
      }
    }
    expect(hiddenLevels).toBe(0);
    expect(
      shouldPublishVad({ speechChanged: true, hidden: true, elapsedMs: 0, levelDelta: 0 }),
    ).toBe(true);

    const quiet = gateSpeechKey({
      running: true,
      speech: false,
      speakingGuard: false,
      noiseFloor: 0.02,
    });
    const louder = gateSpeechKey({
      running: true,
      speech: false,
      speakingGuard: false,
      noiseFloor: 0.02,
    });
    expect(quiet).toBe(louder);
  });

  it("keeps the readout line count when the stage height jitters by one pixel", () => {
    const raw = (height: number) => {
      const slotPx = height > 0 ? (height * 0.86) / 6 : 0;
      return Math.max(0, Math.min(3, Math.floor((slotPx - 86) / 13)));
    };
    let boundary = 0;
    for (let height = 300; height < 1400; height += 1) {
      if (raw(height) !== raw(height + 1)) {
        boundary = height;
        break;
      }
    }
    expect(boundary).toBeGreaterThan(0);
    const before = raw(boundary);
    expect(circuitReadoutLines(boundary + 1, true, before)).toBe(before);
    expect(circuitReadoutLines(boundary + 80, true, before)).toBe(raw(boundary + 80));
    expect(circuitReadoutLines(400, false, 1)).toBe(3);
  });

  it("keeps the shell subscription off the voice screen", () => {
    const shell = readFileSync("src/components/friday/AppShell.tsx", "utf8");
    const calls = shell.match(/useCharacterLink\(/g) ?? [];
    expect(calls).toHaveLength(1);
    const host = shell.slice(shell.indexOf("function CharacterLinkHost"));
    expect(host).toContain("useCharacterLink()");
    const route = readFileSync("src/routes/index.tsx", "utf8");
    expect(route).toContain("useAssistantSlice");
    expect(route).not.toContain("useAssistantMode");
    const readiness = readFileSync("electron/readiness.cjs", "utf8");
    expect(readiness).toContain("ok: synth");
    expect(readiness).toContain("hi-IN-SwaraNeural");
    const main = readFileSync("electron/main.cjs", "utf8");
    expect(main).toContain("voice:stt-progress");
    const stt = readFileSync("electron/stt.cjs", "utf8");
    expect(stt).toContain("Downloading speech model, first time only");
    const neural = readFileSync("electron/neural-voice.cjs", "utf8");
    expect(neural).toContain('voice: "F2"');
    expect(neural).not.toContain('audioBase64: ""');
  });
});

describe("voice runtime line", () => {
  it("records the engine and the last errors without a transcript", () => {
    resetVoiceRenderRate();
    noteVoiceFrame(1_000);
    noteVoiceFrame(1_500);
    const rate = noteVoiceFrame(2_000);
    expect(rate).toBe(3);
    const line = formatVoiceRuntimeLine({
      engine: "edge-tts",
      voiceId: "hi-IN-SwaraNeural",
      lang: "hi-IN",
      sttModel: "small",
      deviceId: "mic-1",
      deviceLabel: "Headset",
      sampleRate: 48000,
      echo: true,
      errors: ["api_key=secret-value", "device busy"],
      renderRate: null,
    });
    expect(line).toContain("hi-IN-SwaraNeural");
    expect(line).toContain("echo on");
    expect(line).toContain("sample 48000");
    expect(line).toContain("[blank]");
    expect(line).not.toContain("secret-value");
    expect(line).not.toContain("render ");
    expect(line).not.toContain("fps ");
    const debug = formatVoiceRuntimeLine({
      engine: "edge-tts",
      voiceId: "hi-IN-SwaraNeural",
      lang: "hi-IN",
      sttModel: "small",
      deviceId: "mic-1",
      deviceLabel: "Headset",
      sampleRate: 48000,
      echo: true,
      errors: [],
      renderRate: 2,
      fps: 60,
      longTasks: 0,
    });
    expect(debug).toContain("render 2/s");
    expect(debug).toContain("fps 60");
    expect(debug).toContain("long 0");
    expect(noteDisplayFrame(3_000)).toBe(0);
    expect(voiceDisplayFps()).toBe(0);
    expect(voiceLongTasks()).toBe(0);
  });
});

describe("voice frame clock", () => {
  it("pauses drawing and age ticks while hidden", () => {
    setFrameClockHidden(() => true);
    let frames = 0;
    let seconds = 0;
    const stopFrame = onVisibleFrame(() => {
      frames += 1;
    });
    const stopSecond = onVisibleSecond(() => {
      seconds += 1;
    });
    expect(frameClockJobCount()).toBe(1);
    for (let i = 0; i < 60; i += 1) pumpFrameClock(i * 16);
    expect(pumpSecondClock(1_000)).toBe(0);
    expect(frames).toBe(0);
    expect(seconds).toBe(0);
    setFrameClockHidden(() => false);
    expect(pumpFrameClock(2_000)).toBe(1);
    expect(pumpSecondClock(2_000)).toBe(1);
    expect(frames).toBe(1);
    expect(seconds).toBe(1);
    stopFrame();
    stopSecond();
    expect(frameClockJobCount()).toBe(0);
  });

  it("does not remount the voice stage and does not render it on a timer", () => {
    const auto = readFileSync("src/components/friday/AutoMode.tsx", "utf8");
    expect(auto).toContain("<NeuralCircuit large");
    expect(auto).not.toMatch(/<NeuralCircuit[^>]*key=/);
    const live = readFileSync("src/lib/friday/use-friday-live.ts", "utf8");
    expect(live).not.toContain("setInterval");
    expect(live).not.toContain("hearing “");
    const rig = readFileSync("src/lib/friday/character/rig.ts", "utf8");
    expect(rig).toContain("onVisibleFrame");
    expect(rig).not.toContain("requestAnimationFrame");
    const speech = readFileSync("src/lib/friday/character/speech-audio.ts", "utf8");
    expect(speech).toContain("onVisibleFrame");
    expect(speech).not.toContain("new Uint8Array(analyser.frequencyBinCount)");
    const main = readFileSync("electron/main.cjs", "utf8");
    const accel = main.indexOf("disableHardwareAcceleration");
    expect(main.slice(0, accel)).toContain("FRIDAY_BOOT_SELFTEST");
  });
});

describe("microphone reopen", () => {
  it("drops a saved device that is no longer present", () => {
    expect(savedInputPlan("usb-mic", [{ id: "usb-mic" }])).toEqual({
      deviceId: "usb-mic",
      cleared: false,
      message: "Microphone reopened.",
    });
    expect(savedInputPlan("usb-mic", [{ id: "built-in" }])).toEqual({
      deviceId: null,
      cleared: true,
      message: "The saved microphone is gone. Using the default device.",
    });
    expect(savedInputPlan("", [])).toEqual({
      deviceId: null,
      cleared: false,
      message: "Microphone changed. Using the default device.",
    });
  });
});
