import { readFileSync } from "node:fs";
import { describe, expect, it, afterEach } from "vitest";
import { savedInputPlan } from "../../src/lib/friday/mic-session";
import { circuitReadoutLines, voiceCueKey } from "../../src/lib/friday/use-friday-live";
import { gateSpeechKey, shouldPublishVad } from "../../src/lib/friday/voice-audio";
import {
  formatVoiceRuntimeLine,
  noteVoiceFrame,
  resetVoiceRenderRate,
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
