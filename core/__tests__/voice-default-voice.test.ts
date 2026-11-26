/**
 * FRIDAY's default voice: the "friday" recipe is what every local path asks for, no listed voice is a real person or a
 * character, and the 50-line mixed-script reading fixture agrees with the script policy about the language a number is
 * read in. The kernel half is `kernel/tests/test_tts_default_voice.py`.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PREFERENCES,
  LOCAL_VOICE_STYLES,
  preferences,
} from "../../src/lib/friday/preferences";
import { chooseTtsEngine } from "../../src/lib/friday/tts-ladder";
import {
  DEFAULT_LOCAL_STYLE,
  LOCAL_VOICE_CHOICES,
  SYNTHETIC_VOICE_NOTE,
  ownerPresetStyle,
  pickerValueFor,
  profileFromPreferences,
  profileVoiceStyle,
} from "../../src/lib/friday/voice-engine/friday-voice-profile";
import { segmentCodemix } from "../../src/lib/friday/voice-engine/language-segmenter";
import { spanTreatments } from "../../src/lib/friday/voice-engine/script-policy";
import {
  NO_INDIAN_VOICE,
  activeLocalStyle,
  cloudVoiceFor,
  pickSpokenVoice,
  previewStyleToken,
} from "../../src/lib/friday/voice-library";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const require_ = createRequire(import.meta.url);

type Line = {
  id: string;
  stratum: string;
  kind: string;
  text: string;
  spoken: string;
  numbers?: Array<{ text: string; lang: "hi" | "en" }>;
  kernelReads?: string;
};
const fixture = JSON.parse(read("core/fixtures/voice-eval/tts-mixed-script.json")) as {
  lines: Line[];
};
const recipes = JSON.parse(read("kernel/friday_voice_recipes.json")) as {
  default: string;
  recipes: Record<string, { label: string; description: string; base: Record<string, number> }>;
};

/** Names of real people, characters and other assistants no voice may be made after. */
const BORROWED_NAMES =
  /jarvis|siri|alexa|cortana|samantha|scarlett|johansson|bettany|tony stark|iron ?man|morgan freeman|amitabh|bachchan|lata|mangeshkar|shah ?rukh|deepika|priyanka|sridevi|darth|vader|optimus|clone|cloned|impersonat|celebrity|lookalike|sound-?alike/i;

const presetStyles = (LOCAL_VOICE_STYLES as readonly string[]).filter((id) =>
  /^[FM][1-5]$/.test(id),
);
const recipeStyles = (LOCAL_VOICE_STYLES as readonly string[]).filter((id) =>
  id.startsWith("friday"),
);

beforeEach(() => {
  preferences.update({ voice: { ...DEFAULT_PREFERENCES.voice, models: [], activeId: "" } });
});

describe("the default style of every local path", () => {
  it("is empty in the stored preferences and means the friday recipe", () => {
    expect(DEFAULT_PREFERENCES.voice.localVoiceStyle).toBe("");
    expect(DEFAULT_LOCAL_STYLE).toBe("friday");
    expect(recipes.default).toBe(DEFAULT_LOCAL_STYLE);
    expect(profileVoiceStyle(DEFAULT_PREFERENCES.voice)).toBe("");
    expect(ownerPresetStyle(DEFAULT_PREFERENCES.voice)).toBe("");
    const refs = profileFromPreferences(DEFAULT_PREFERENCES.voice).modelRefs;
    expect(refs.find((ref) => ref.engine === "supertonic")?.voiceStyle).toBe("");
  });

  it("asks the engine for friday on a fresh install, for a reply, a read-aloud, an ack and an error line", () => {
    expect(activeLocalStyle()).toBe("friday");
    // Every one of those lines is spoken by the one clip maker, which asks for `localStyle()` and nothing else.
    const source = read("src/lib/friday/voice-library.ts");
    const asked = source.match(/\bstyle: [^,\n]+,/g) ?? [];
    expect(asked.length).toBeGreaterThanOrEqual(2);
    expect(new Set(asked)).toEqual(new Set(["style: localStyle(),"]));
    expect(source).not.toMatch(/style: "(?:F|M)\d"/);
  });

  it("falls back to friday for a stored value that is not on the list", () => {
    preferences.setVoice({ localVoiceStyle: "Scarlett" as never });
    expect(preferences.getSnapshot().voice.localVoiceStyle).toBe("");
    expect(activeLocalStyle()).toBe("friday");
    preferences.setVoice({ localVoiceStyle: "../../etc/passwd" as never });
    expect(activeLocalStyle()).toBe("friday");
  });

  it("keeps an explicit owner choice, and only that, including a male preset picked on purpose", () => {
    preferences.setVoice({ localVoiceStyle: "friday-calm" });
    expect(activeLocalStyle()).toBe("friday-calm");
    preferences.setVoice({ localVoiceStyle: "M1" });
    expect(activeLocalStyle()).toBe("M1");
    preferences.setVoice({ localVoiceStyle: "" });
    expect(activeLocalStyle()).toBe("friday");
  });

  it("gives a Settings preview only a listed id, and the default id for an empty one", () => {
    expect(previewStyleToken("friday-bright")).toBe("friday-bright");
    expect(previewStyleToken("")).toBe("friday");
    expect(previewStyleToken("scarlett")).toBe("");
    expect(previewStyleToken(7)).toBe("");
  });

  it("is the first, default row of the Settings picker, and friday reads as that row", () => {
    expect(LOCAL_VOICE_CHOICES[0]).toMatchObject({ id: "" });
    expect(LOCAL_VOICE_CHOICES[0]?.label).toMatch(/^FRIDAY \(default/);
    expect(pickerValueFor("friday")).toBe("");
    expect(pickerValueFor("nonsense")).toBe("");
    expect(pickerValueFor(undefined)).toBe("");
  });

  it("offers a male preset only with a hint that says it is only used when picked", () => {
    for (const choice of LOCAL_VOICE_CHOICES.filter((c) => c.id.startsWith("M"))) {
      expect(choice.hint).toMatch(/only when you pick it/);
    }
    expect(
      LOCAL_VOICE_CHOICES.filter((c) => !c.id.startsWith("M")).every(
        (c) => !/male\b/.test(c.label.replace(/female/g, "")),
      ),
    ).toBe(true);
  });
});

describe("no listed voice is a real person or a character", () => {
  it("keeps the recipe ids, labels and descriptions to FRIDAY's own names", () => {
    for (const [id, recipe] of Object.entries(recipes.recipes)) {
      expect(id === "friday" || id.startsWith("friday-")).toBe(true);
      expect(recipe.label).toMatch(/^FRIDAY/);
      expect(`${id} ${recipe.label} ${recipe.description}`).not.toMatch(BORROWED_NAMES);
      expect(Object.keys(recipe.base).every((name) => /^F[1-5]$/.test(name))).toBe(true);
    }
  });

  it("keeps the picker rows, hints and the honest note free of borrowed names", () => {
    const words = LOCAL_VOICE_CHOICES.map((c) => `${c.id} ${c.label} ${c.hint}`).join("\n");
    expect(words).not.toMatch(BORROWED_NAMES);
    expect(SYNTHETIC_VOICE_NOTE).toMatch(/synthetic/);
    expect(SYNTHETIC_VOICE_NOTE).toMatch(/none of these voices copies a real person/);
  });

  it("lists the same styles in the app, the kernel recipes and the speech bridge", () => {
    expect(new Set(recipeStyles)).toEqual(new Set(Object.keys(recipes.recipes)));
    const bridge = require_("../../electron/neural-voice.cjs") as {
      LOCAL_STYLES: string[];
      normaliseLocalStyle: (style: unknown) => string;
    };
    expect(new Set(bridge.LOCAL_STYLES)).toEqual(
      new Set((LOCAL_VOICE_STYLES as readonly string[]).filter((id) => id !== "")),
    );
    expect(bridge.LOCAL_STYLES.join(" ")).not.toMatch(BORROWED_NAMES);
    expect(presetStyles.sort()).toEqual(["F1", "F2", "F3", "F4", "F5", "M1", "M2"]);
    // The bridge sends only a listed id; anything else is "" and the worker then speaks the default.
    expect(bridge.normaliseLocalStyle("Scarlett")).toBe("");
    expect(bridge.normaliseLocalStyle("../x")).toBe("");
    expect(bridge.normaliseLocalStyle(" FRIDAY ")).toBe("friday");
    expect(read("electron/neural-voice.cjs")).toContain('const LOCAL_STYLE_DEFAULT = "friday";');
  });

  it("names only female voices as the system-voice fallback, and says so when there is none", () => {
    const male = [{ name: "Microsoft Prabhat - English (India)", lang: "en-IN" }];
    expect(pickSpokenVoice(male, "")).toEqual({ name: "", note: NO_INDIAN_VOICE });
    const both = [...male, { name: "Microsoft Heera - English (India)", lang: "en-IN" }];
    expect(pickSpokenVoice(both, "").name).toMatch(/Heera/);
  });
});

describe("the engine and the cloud", () => {
  it("never sends a cloud voice id for the local engine, a system voice or privacy mode", () => {
    expect(cloudVoiceFor({ kind: "neural", voiceName: "" }, "hi-IN", true)).toBe("");
    expect(cloudVoiceFor({ kind: "system" }, "hi-IN", true)).toBe("");
    expect(cloudVoiceFor({}, "hi-IN", false)).toBe("");
  });

  it("KNOWN GAP (owner decision): with the engine on auto and a network, the online neural voice is asked first", () => {
    // The owner's goal is her own voice by default. Today `auto` ranks the Microsoft online voice (Swara, Neerja)
    // above FRIDAY Voice when online and privacy is off, and a tuning with no explicit kind asks it for every clause.
    // Changing that is a default-engine change in tts-ladder.ts, voice-choices.ts and preferences.ts, not a test
    // change: when it is made this test flips to "supertonic" and "".
    expect(chooseTtsEngine({ network: true, supertonicReady: true, privacy: false })).toBe(
      "neural",
    );
    expect(cloudVoiceFor({}, "hi-IN", true)).toBe("hi-IN-SwaraNeural");
    expect(DEFAULT_PREFERENCES.voice.ttsEngine).toBe("auto");
    // Offline, FRIDAY Voice is the engine.
    expect(chooseTtsEngine({ network: false, supertonicReady: true, privacy: false })).toBe(
      "supertonic",
    );
  });
});

describe("the mixed-script reading fixture and the script policy", () => {
  it("has 50 lines", () => {
    expect(fixture.lines).toHaveLength(50);
  });

  it("reads each number in the language of its neighbouring word, as the fixture says", () => {
    const withNumbers = fixture.lines.filter((line) => line.numbers);
    expect(withNumbers.length).toBeGreaterThanOrEqual(30);
    for (const line of withNumbers) {
      const treated = spanTreatments(segmentCodemix(line.text), "friday").filter(
        (t) => t.path === "numbers",
      );
      expect(
        treated.map((t) => t.numberLang),
        line.id,
      ).toEqual(line.numbers!.map((n) => n.lang));
      expect(treated.every((t) => t.engineReads)).toBe(true);
    }
  });

  it("finds no number in a line the fixture lists without numbers", () => {
    for (const line of fixture.lines.filter((l) => !l.numbers)) {
      const treated = spanTreatments(segmentCodemix(line.text), "friday");
      expect(
        treated.some((t) => t.path === "numbers"),
        line.id,
      ).toBe(false);
    }
  });

  it("lists the lines where the kernel front end reads a number in the other language", () => {
    const gaps = fixture.lines.filter((line) => line.kernelReads).map((line) => line.id);
    expect(gaps).toEqual(["t33", "t39", "t45"]);
  });
});
