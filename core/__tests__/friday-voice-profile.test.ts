import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES } from "../../src/lib/friday/preferences";
import {
  FRIDAY_PROFILE_ID,
  PROFILE_ENGINES,
  PROFILE_PITCH_MAX,
  PROFILE_RATE_MAX,
  PROFILE_RATE_MIN,
  defaultFridayVoiceProfile,
  factorToSemitones,
  profileCredits,
  profileFits,
  profileFromPreferences,
  profileSpeakParams,
  profileToVoicePatch,
  profileVoiceStyle,
  rebindModel,
  sanitizeFridayVoiceProfile,
  sayWithProfile,
  semitonesToFactor,
} from "../../src/lib/friday/voice-engine/friday-voice-profile";

const ROOT = path.resolve(__dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

describe("sanitizeFridayVoiceProfile", () => {
  it("turns nothing, a string, an array or null into the default profile", () => {
    const base = defaultFridayVoiceProfile();
    for (const raw of [undefined, null, "x", 7, [], {}]) {
      expect(sanitizeFridayVoiceProfile(raw)).toEqual(base);
    }
    expect(base.id).toBe(FRIDAY_PROFILE_ID);
    expect(base.gender).toBe("female");
    expect(base.rate).toBe(1);
    expect(base.pitch).toBe(0);
  });

  it("clamps rate, pitch and prosody, and reads numbers sent as text", () => {
    const out = sanitizeFridayVoiceProfile({
      rate: 9,
      pitch: -40,
      prosody: { pauseScale: 0, emphasis: 4 },
    });
    expect(out.rate).toBe(PROFILE_RATE_MAX);
    expect(out.pitch).toBe(-4);
    expect(out.prosody).toEqual({ pauseScale: 0.5, emphasis: 1 });
    expect(sanitizeFridayVoiceProfile({ rate: "0.1" }).rate).toBe(PROFILE_RATE_MIN);
    expect(sanitizeFridayVoiceProfile({ rate: "1.25", pitch: "2" })).toMatchObject({
      rate: 1.25,
      pitch: 2,
    });
    expect(sanitizeFridayVoiceProfile({ rate: Number.NaN, pitch: Infinity })).toMatchObject({
      rate: 1,
      pitch: 0,
    });
  });

  it("fixes the identity: id and gender cannot be changed from outside", () => {
    const out = sanitizeFridayVoiceProfile({ id: "someone-else", gender: "male", version: 99 });
    expect(out.id).toBe(FRIDAY_PROFILE_ID);
    expect(out.gender).toBe("female");
    expect(out.version).toBe(1);
  });

  it("keeps a name tidy and falls back when it is empty or only control characters", () => {
    expect(sanitizeFridayVoiceProfile({ displayName: "  Fri\u0000day‮  " }).displayName).toBe(
      "Friday",
    );
    expect(sanitizeFridayVoiceProfile({ displayName: "\u0007" }).displayName).toBe("FRIDAY");
    expect(sanitizeFridayVoiceProfile({ displayName: "x".repeat(500) }).displayName).toHaveLength(
      40,
    );
  });

  it("drops unknown engines and non-female styles, and keeps one reference per engine", () => {
    const out = sanitizeFridayVoiceProfile({
      modelRefs: [
        { engine: "supertonic", modelId: "../../evil", voiceStyle: "M1" },
        { engine: "supertonic", voiceStyle: "F3" },
        { engine: "clone-of-a-person", modelId: "x", voiceStyle: "" },
        { engine: "hindi-light", voiceStyle: "F2" },
        "nonsense",
        null,
      ],
    });
    expect(out.modelRefs).toEqual([
      { engine: "supertonic", modelId: "supertonic-3", voiceStyle: "" },
      { engine: "hindi-light", modelId: "hindi-light-tts", voiceStyle: "" },
    ]);
  });

  it("checks languages against what the engine can speak and keeps the order", () => {
    const out = sanitizeFridayVoiceProfile({
      languages: [
        { code: "hi", preferredEngines: ["hindi-light", "bogus", "supertonic", "hindi-light"] },
        { code: "en", preferredEngines: ["hindi-light"] },
        { code: "fr", preferredEngines: ["sapi"] },
        { code: "hi", preferredEngines: ["sapi"] },
      ],
    });
    expect(out.languages).toEqual([
      { code: "hi", preferredEngines: ["hindi-light", "supertonic"] },
      { code: "en", preferredEngines: ["edge", "supertonic", "sapi"] },
    ]);
  });

  it("bounds the pronunciations and refuses control characters and prototype keys", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 400; i += 1) many[`word${i}`] = `say${i}`;
    const out = sanitizeFridayVoiceProfile({
      pronunciations: { ...many, "": "x", empty: "", __proto__x: "y", "bad\u0000": "ok" },
    });
    expect(Object.keys(out.pronunciations).length).toBeLessThanOrEqual(200);
    expect(out.pronunciations[""]).toBeUndefined();
    expect(Object.getPrototypeOf(out.pronunciations)).toBe(Object.prototype);
    const hostile = sanitizeFridayVoiceProfile(
      JSON.parse('{"pronunciations":{"__proto__":"x","a":"b"}}'),
    );
    expect(hostile.pronunciations["a"]).toBe("b");
    expect(Object.keys(hostile.pronunciations)).toEqual(["a"]);
  });

  it("is idempotent, and migrates an old shape that only had a pace and a style", () => {
    const old = { rate: 1.1, modelRefs: [{ engine: "supertonic", voiceStyle: "F4" }] };
    const once = sanitizeFridayVoiceProfile(old);
    expect(once).toMatchObject({ rate: 1.1, prosody: { pauseScale: 1, emphasis: 0.5 } });
    expect(once.modelRefs[0]?.voiceStyle).toBe("F4");
    expect(sanitizeFridayVoiceProfile(once)).toEqual(once);
    expect(sanitizeFridayVoiceProfile(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });
});

describe("profile and the preferences the app already keeps", () => {
  const voice = DEFAULT_PREFERENCES.voice;

  it("reads the default preferences as the default profile", () => {
    const profile = profileFromPreferences(voice);
    expect(profile.rate).toBe(sanitizeFridayVoiceProfile({ rate: voice.rate }).rate);
    expect(profile.modelRefs).toEqual([
      { engine: "supertonic", modelId: "supertonic-3", voiceStyle: "" },
    ]);
    expect(profile.gender).toBe("female");
  });

  it("round-trips the style, the light Hindi voice, the pace and the pronunciations", () => {
    const profile = profileFromPreferences({
      ...voice,
      rate: 1.2,
      pitch: 1.0595,
      localVoiceStyle: "F3",
      hindiLightVoice: true,
      pronunciations: { Devendra: "Dayvendra" },
    });
    expect(profile.pitch).toBe(1);
    expect(profile.modelRefs.map((r) => r.engine)).toEqual(["supertonic", "hindi-light"]);
    expect(profile.languages[0]?.preferredEngines).toContain("hindi-light");
    const patch = profileToVoicePatch(profile);
    expect(patch).toMatchObject({
      rate: 1.2,
      localVoiceStyle: "F3",
      hindiLightVoice: true,
      pronunciations: { Devendra: "Dayvendra" },
    });
    expect(patch.pitch).toBeCloseTo(1.059, 3);
  });

  it("an invalid stored style is read as the default instead of reaching the engine", () => {
    expect(profileVoiceStyle({ localVoiceStyle: "M2" as never })).toBe("");
    expect(profileVoiceStyle({ localVoiceStyle: "F5" })).toBe("F5");
    expect(profileVoiceStyle({})).toBe("");
  });

  it("converts pitch between the multiplier of the settings and semitones", () => {
    expect(semitonesToFactor(0)).toBe(1);
    expect(semitonesToFactor(12)).toBe(semitonesToFactor(PROFILE_PITCH_MAX));
    expect(factorToSemitones(1)).toBe(0);
    expect(factorToSemitones(2 ** (2 / 12))).toBe(2);
    expect(factorToSemitones(0)).toBe(0);
    expect(factorToSemitones(Number.NaN)).toBe(0);
  });
});

describe("profileFits and rebindModel", () => {
  const profile = defaultFridayVoiceProfile();

  it("the standard local voice and the online voice carry both languages", () => {
    expect(profileFits(profile, "supertonic")).toMatchObject({
      fits: true,
      languages: ["hi", "en"],
    });
    expect(profileFits(profile, "edge").pitchApplies).toBe(true);
  });

  it("the light Hindi voice fits only for Hindi and says what is left to another engine", () => {
    const fit = profileFits(profile, "hindi-light");
    expect(fit.fits).toBe(true);
    expect(fit.languages).toEqual(["hi"]);
    expect(fit.reasons.join(" ")).toMatch(/other language needs another engine/);
  });

  it("a pitch nudge is reported as left out where the engine cannot take it", () => {
    const nudged = { ...profile, pitch: 2 };
    expect(profileFits(nudged, "supertonic").reasons.join(" ")).toMatch(/cannot change pitch/);
    expect(profileSpeakParams(nudged, "supertonic").pitch).toBeNull();
    expect(profileSpeakParams(nudged, "edge").pitch).toBe(2);
    expect(profileSpeakParams({ ...profile, pitch: 0 }, "edge").pitch).toBeNull();
  });

  it("an unknown engine does not fit and is named", () => {
    const fit = profileFits(profile, "some-new-model");
    expect(fit.fits).toBe(false);
    expect(fit.reasons[0]).toMatch(/not a known engine/);
  });

  it("a replacement model keeps the same logical profile", () => {
    const tuned = sanitizeFridayVoiceProfile({
      displayName: "FRIDAY",
      rate: 1.15,
      pitch: -1,
      prosody: { pauseScale: 1.3, emphasis: 0.7 },
      pronunciations: { Meena: "Meenaa" },
    });
    const next = rebindModel(tuned, "supertonic", { voiceStyle: "F4" });
    expect(next.modelRefs.find((r) => r.engine === "supertonic")?.voiceStyle).toBe("F4");
    expect({ ...next, modelRefs: [] }).toEqual({ ...tuned, modelRefs: [] });
    expect(profileFits(next, "supertonic").fits).toBe(true);
    // A style the engine does not have falls to its default instead of breaking the profile.
    expect(
      rebindModel(tuned, "hindi-light", { voiceStyle: "F9" }).modelRefs.at(-1)?.voiceStyle,
    ).toBe("");
  });

  it("every engine of the table is covered by a fit check", () => {
    for (const engine of Object.keys(PROFILE_ENGINES)) {
      expect(typeof profileFits(profile, engine).fits).toBe("boolean");
    }
  });
});

describe("licence and provenance lines", () => {
  it("reads each model's licence and credit from the model catalog", () => {
    const profile = sanitizeFridayVoiceProfile({
      modelRefs: [{ engine: "supertonic" }, { engine: "hindi-light" }, { engine: "sapi" }],
    });
    const credits = profileCredits(profile);
    const light = credits.find((c) => c.engine === "hindi-light");
    expect(light?.licence).toBe("CC-BY-4.0");
    expect(light?.provenance).toMatch(/^FRIDAY Voice Lite; licence CC-BY-4\.0/);
    expect(light?.provenance).not.toMatch(/credit|Sulabh Katiyar/i);
    const standard = credits.find((c) => c.engine === "supertonic");
    expect(standard?.licence).toMatch(/OpenRAIL-M/);
    expect(credits.find((c) => c.engine === "sapi")?.provenance).toMatch(/comes with Windows/);
  });

  it("says unverified instead of inventing a licence for a model the catalog does not know", () => {
    const credits = profileCredits(defaultFridayVoiceProfile(), () => undefined);
    expect(credits[0]?.licence).toBe("unknown");
    expect(credits[0]?.provenance).toMatch(/unverified/);
  });
});

describe("pronunciations reuse the one table", () => {
  it("the owner's entries win over the built-in ones, in the same function the speech path uses", () => {
    const profile = sanitizeFridayVoiceProfile({ pronunciations: { GST: "jee es tee" } });
    expect(sayWithProfile("Pay the GST on the PDF", profile)).toBe(
      "Pay the jee es tee on the P D F",
    );
    const source = read("src/lib/friday/voice-engine/friday-voice-profile.ts");
    expect(source).toContain("applyPronunciations");
    expect(source).not.toContain("BUILTIN_PRONUNCIATIONS =");
  });
});

describe("what the profile may not do", () => {
  const source = read("src/lib/friday/voice-engine/friday-voice-profile.ts");

  it("stays female, adds no store of its own and opens no microphone or network", () => {
    expect(source).not.toMatch(/localStorage|indexedDB|fetch\(|getUserMedia|navigator\./);
    expect(source).toContain('gender: "female"');
  });

  it("the real speech path reads its style from the profile", () => {
    const library = read("src/lib/friday/voice-library.ts");
    expect(library).toContain("profileVoiceStyle(");
    expect(library).not.toContain("voice.localVoiceStyle");
  });
});
