/**
 * FRIDAY · her voice as an identity that does not depend on a model.
 *
 * "FRIDAY's voice" is one logical profile: a calm female voice for Hindi and English, a pace, a pitch nudge, a
 * little prosody and her own pronunciations. Which model renders it (Supertonic F-style, the light Hindi voice,
 * the online voice, the system voice) is only a reference inside the profile, so a better model later is a new
 * reference, not a new FRIDAY. Nothing here plays audio or stores anything by itself:
 *
 *   - the profile is read from the preferences the app already keeps (`profileFromPreferences`) and written back
 *     to those same keys (`profileToVoicePatch`); no second store;
 *   - `sanitizeFridayVoiceProfile` makes any stored or imported shape safe (old shapes migrate, numbers are
 *     clamped, unknown engines and a non-female style are dropped);
 *   - `profileFits` says whether an engine can render the profile, `rebindModel` swaps the model and keeps the
 *     identity;
 *   - every model reference carries its licence and credit line, read from the model catalog.
 *
 * She never imitates a real person. Cloning a voice from the owner's recordings is out of scope: the only hook is
 * the `modelRefs` list itself, where an engine id that is not in `PROFILE_ENGINES` is refused until the owner
 * decides to add one.
 */
import { applyPronunciations } from "./text-normalizer";
import { HINDI_LIGHT_ENGINE, HINDI_LIGHT_MODEL_ID } from "./tts-provider";
import { modelById, NEURAL_VOICE_MODEL } from "../model-catalog";
import type { LocalVoiceStyle, VoicePreferences } from "../preferences";
import type { FridayVoiceStatus } from "../voice-diagnostics-rows";

export const FRIDAY_PROFILE_ID = "friday-default";
export const PROFILE_VERSION = 1;
export const PROFILE_RATE_MIN = 0.6;
export const PROFILE_RATE_MAX = 1.6;
export const PROFILE_PITCH_MIN = -4;
export const PROFILE_PITCH_MAX = 4;
const MAX_PRONUNCIATIONS = 200;
const MAX_NAME_CHARS = 40;

export type ProfileLanguage = "hi" | "en";
export type ProfileEngine = "supertonic" | "hindi-light" | "edge" | "sapi";

/** What each engine can do for a profile. Pitch is only a hint where the engine can take it. */
export const PROFILE_ENGINES: Record<
  ProfileEngine,
  {
    languages: readonly ProfileLanguage[];
    pitch: boolean;
    styles: readonly string[];
    modelId: string;
  }
> = {
  supertonic: {
    languages: ["hi", "en"],
    pitch: false,
    styles: ["", "friday", "friday-bright", "friday-calm", "F1", "F2", "F3", "F4", "F5"],
    modelId: NEURAL_VOICE_MODEL,
  },
  "hindi-light": {
    languages: ["hi"],
    pitch: false,
    styles: [""],
    modelId: HINDI_LIGHT_MODEL_ID,
  },
  edge: { languages: ["hi", "en"], pitch: true, styles: [""], modelId: "edge-tts" },
  sapi: { languages: ["hi", "en"], pitch: true, styles: [""], modelId: "" },
};

export type ProfileModelRef = {
  engine: ProfileEngine;
  /** The catalog id of the model, empty for the system voice. */
  modelId: string;
  /** The female style of the engine ("friday", "friday-bright", "friday-calm", "F1".."F5"), empty for FRIDAY's own default. */
  voiceStyle: string;
};

export type ProfileLanguageEntry = { code: ProfileLanguage; preferredEngines: ProfileEngine[] };

export type FridayVoiceProfile = {
  id: typeof FRIDAY_PROFILE_ID;
  version: number;
  displayName: string;
  gender: "female";
  languages: ProfileLanguageEntry[];
  /** Pace, 0.6 to 1.6. */
  rate: number;
  /** A pitch nudge in semitones, -4 to +4, used only where the engine takes one. */
  pitch: number;
  prosody: { pauseScale: number; emphasis: number };
  /** The owner's own pronunciations, on top of the built-in table (`BUILTIN_PRONUNCIATIONS`). */
  pronunciations: Record<string, string>;
  modelRefs: ProfileModelRef[];
};

export type ProfileModelCredit = ProfileModelRef & { licence: string; provenance: string };

const isEngine = (value: unknown): value is ProfileEngine =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(PROFILE_ENGINES, value);

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const num = (value: unknown, fallback: number): number => {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
};

const round = (value: number, places = 2): number => {
  const k = 10 ** places;
  return Math.round(value * k) / k;
};

/** The default profile: Hindi and English, the standard local voice behind the online one. */
export function defaultFridayVoiceProfile(): FridayVoiceProfile {
  return {
    id: FRIDAY_PROFILE_ID,
    version: PROFILE_VERSION,
    displayName: "FRIDAY",
    gender: "female",
    languages: [
      { code: "hi", preferredEngines: ["edge", "supertonic", "sapi"] },
      { code: "en", preferredEngines: ["edge", "supertonic", "sapi"] },
    ],
    rate: 1,
    pitch: 0,
    prosody: { pauseScale: 1, emphasis: 0.5 },
    pronunciations: {},
    modelRefs: [
      { engine: "supertonic", modelId: PROFILE_ENGINES.supertonic.modelId, voiceStyle: "" },
    ],
  };
}

/** Control and format characters (including the bidirectional overrides) are removed; the rest is trimmed and capped. */
const cleanText = (value: unknown, max: number): string =>
  typeof value === "string"
    ? value
        .replace(/[\p{Cc}\p{Cf}]/gu, "")
        .trim()
        .slice(0, max)
    : "";

function cleanRef(raw: unknown): ProfileModelRef | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (!isEngine(row["engine"])) return null;
  const engine = row["engine"];
  const caps = PROFILE_ENGINES[engine];
  const style = typeof row["voiceStyle"] === "string" ? row["voiceStyle"].trim() : "";
  // She is a female voice: a style the engine does not list (a male style, anything unknown) falls to its default.
  return {
    engine,
    modelId: caps.modelId,
    voiceStyle: caps.styles.includes(style) ? style : "",
  };
}

/**
 * Make any stored, old or imported value a valid profile. Unknown keys are dropped, numbers clamped, the
 * identity (id, gender) fixed, engines checked against the known list, text cleaned of control characters.
 * An old shape without prosody, pronunciations or references keeps the defaults for what it lacks.
 */
export function sanitizeFridayVoiceProfile(raw: unknown): FridayVoiceProfile {
  const base = defaultFridayVoiceProfile();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const row = raw as Record<string, unknown>;

  const languages: ProfileLanguageEntry[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(row["languages"]) ? row["languages"] : []) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const code = item["code"];
    if ((code !== "hi" && code !== "en") || seen.has(code)) continue;
    const engines = (Array.isArray(item["preferredEngines"]) ? item["preferredEngines"] : [])
      .filter(isEngine)
      .filter((engine, index, all) => all.indexOf(engine) === index)
      .filter((engine) => PROFILE_ENGINES[engine].languages.includes(code));
    seen.add(code);
    languages.push({
      code,
      preferredEngines: engines.length
        ? engines
        : (base.languages.find((l) => l.code === code)?.preferredEngines ?? ["sapi"]),
    });
  }

  const refs: ProfileModelRef[] = [];
  for (const entry of Array.isArray(row["modelRefs"]) ? row["modelRefs"] : []) {
    const ref = cleanRef(entry);
    if (ref && !refs.some((r) => r.engine === ref.engine)) refs.push(ref);
  }

  const pronunciations: Record<string, string> = {};
  const given = row["pronunciations"];
  if (given && typeof given === "object" && !Array.isArray(given)) {
    for (const [word, said] of Object.entries(given as Record<string, unknown>)) {
      if (Object.keys(pronunciations).length >= MAX_PRONUNCIATIONS) break;
      const key = cleanText(word, 40);
      const value = cleanText(said, 80);
      if (key && value && key !== "__proto__") pronunciations[key] = value;
    }
  }

  const prosody = (
    row["prosody"] && typeof row["prosody"] === "object" ? row["prosody"] : {}
  ) as Record<string, unknown>;
  return {
    id: FRIDAY_PROFILE_ID,
    version: PROFILE_VERSION,
    displayName: cleanText(row["displayName"], MAX_NAME_CHARS) || base.displayName,
    gender: "female",
    languages: languages.length ? languages : base.languages,
    rate: round(clamp(num(row["rate"], base.rate), PROFILE_RATE_MIN, PROFILE_RATE_MAX)),
    pitch: round(clamp(num(row["pitch"], base.pitch), PROFILE_PITCH_MIN, PROFILE_PITCH_MAX)),
    prosody: {
      pauseScale: round(clamp(num(prosody["pauseScale"], base.prosody.pauseScale), 0.5, 2)),
      emphasis: round(clamp(num(prosody["emphasis"], base.prosody.emphasis), 0, 1)),
    },
    pronunciations,
    modelRefs: refs.length ? refs : base.modelRefs,
  };
}

/** Semitones to the multiplier the delivery settings and the online voice use (0 st = 1.0). */
export const semitonesToFactor = (semitones: number): number =>
  round(2 ** (clamp(semitones, PROFILE_PITCH_MIN, PROFILE_PITCH_MAX) / 12), 3);

/** The multiplier of the delivery settings as semitones (1.0 = 0 st). */
export const factorToSemitones = (factor: number): number =>
  Number.isFinite(factor) && factor > 0
    ? round(clamp(12 * Math.log2(factor), PROFILE_PITCH_MIN, PROFILE_PITCH_MAX), 1)
    : 0;

type ProfileSource = Pick<
  VoicePreferences,
  "rate" | "pitch" | "localVoiceStyle" | "hindiLightVoice" | "pronunciations"
>;

/** FRIDAY's profile as the preferences the app already keeps describe it. */
export function profileFromPreferences(voice: Partial<ProfileSource>): FridayVoiceProfile {
  const base = defaultFridayVoiceProfile();
  const light = voice.hindiLightVoice === true;
  const refs: ProfileModelRef[] = [
    {
      engine: "supertonic",
      modelId: PROFILE_ENGINES.supertonic.modelId,
      voiceStyle: voice.localVoiceStyle ?? "",
    },
    ...(light
      ? [{ engine: "hindi-light" as const, modelId: HINDI_LIGHT_MODEL_ID, voiceStyle: "" }]
      : []),
  ];
  return sanitizeFridayVoiceProfile({
    ...base,
    languages: [
      {
        code: "hi",
        preferredEngines: light
          ? ["edge", HINDI_LIGHT_ENGINE, "supertonic", "sapi"]
          : ["edge", "supertonic", "sapi"],
      },
      { code: "en", preferredEngines: ["edge", "supertonic", "sapi"] },
    ],
    rate: voice.rate,
    pitch: factorToSemitones(num(voice.pitch, 1)),
    pronunciations: voice.pronunciations ?? {},
    modelRefs: refs,
  });
}

/** The existing preference keys a profile writes to (the one place profile changes are saved). */
export function profileToVoicePatch(
  profile: FridayVoiceProfile,
): Pick<
  VoicePreferences,
  "rate" | "pitch" | "localVoiceStyle" | "hindiLightVoice" | "pronunciations"
> {
  const clean = sanitizeFridayVoiceProfile(profile);
  const style = clean.modelRefs.find((ref) => ref.engine === "supertonic")?.voiceStyle ?? "";
  return {
    rate: clean.rate,
    pitch: semitonesToFactor(clean.pitch),
    localVoiceStyle: style as VoicePreferences["localVoiceStyle"],
    hindiLightVoice: clean.modelRefs.some((ref) => ref.engine === "hindi-light"),
    pronunciations: { ...clean.pronunciations },
  };
}

/** The style id sent to the engine when nothing else is chosen: FRIDAY's own voice. */
export const DEFAULT_LOCAL_STYLE = "friday";

/** A male preset the owner picked on purpose; the profile itself stays a female voice, so only this explicit choice reaches the engine. */
export function ownerPresetStyle(voice: Partial<ProfileSource>): "M1" | "M2" | "" {
  return voice.localVoiceStyle === "M1" || voice.localVoiceStyle === "M2"
    ? voice.localVoiceStyle
    : "";
}

/** One row of the voice picker: the stored value, the words shown, and what it is. */
export type LocalVoiceChoice = { id: LocalVoiceStyle; label: string; hint: string };

/**
 * What the Settings voice picker offers, in order. The default is stored as "" (an empty value and "friday" both
 * mean her own voice). The presets are the bundled voice styles of the engine, kept as the owner's explicit choice.
 */
export const LOCAL_VOICE_CHOICES: readonly LocalVoiceChoice[] = [
  { id: "", label: "FRIDAY (default, sweet and warm)", hint: "her own voice, used by default" },
  {
    id: "friday-bright",
    label: "FRIDAY bright",
    hint: "the same voice, a little lighter and livelier",
  },
  { id: "friday-calm", label: "FRIDAY calm", hint: "the same voice, a little slower and softer" },
  { id: "F1", label: "Preset F1 (female)", hint: "a bundled female preset" },
  { id: "F2", label: "Preset F2 (female)", hint: "a bundled female preset" },
  { id: "F3", label: "Preset F3 (female)", hint: "a bundled female preset" },
  { id: "F4", label: "Preset F4 (female)", hint: "a bundled female preset" },
  { id: "F5", label: "Preset F5 (female)", hint: "a bundled female preset" },
  { id: "M1", label: "Preset M1 (male)", hint: "a bundled male preset, only when you pick it" },
  { id: "M2", label: "Preset M2 (male)", hint: "a bundled male preset, only when you pick it" },
];

/** The picker value for a stored style: "friday" and an unknown value read as the default (""). */
export function pickerValueFor(style: unknown): LocalVoiceStyle {
  return LOCAL_VOICE_CHOICES.some((choice) => choice.id === style)
    ? (style as LocalVoiceStyle)
    : "";
}

/** What the voice picker shows: it is loading, has no desktop to ask, failed (with Retry), has no voice installed, or is ready. */
export type LocalVoicePickerState =
  | { kind: "loading"; note: string }
  | { kind: "offline"; note: string }
  | { kind: "error"; note: string }
  | { kind: "empty"; note: string }
  | { kind: "ready"; note: string; own: boolean };

/** The picker's state from what the settings page knows. Pure; the page only draws it. */
export function localVoicePickerState(input: {
  loading: boolean;
  desktop: boolean;
  error?: string;
  status: FridayVoiceStatus | null;
}): LocalVoicePickerState {
  if (!input.desktop) {
    return {
      kind: "offline",
      note: "The voices are made on this PC by the FRIDAY desktop app, so there is nothing to preview in a browser. They work without internet.",
    };
  }
  if (input.loading) return { kind: "loading", note: "Checking the local voice on this PC." };
  if (input.error) return { kind: "error", note: input.error };
  const status = input.status;
  if (!status || status.engine === "none" || !status.ready) {
    return {
      kind: "empty",
      note: status?.reason
        ? `No local voice is installed yet (${status.reason}). The system voice speaks until it is.`
        : "No local voice is installed yet. The system voice speaks until it is.",
    };
  }
  return {
    kind: "ready",
    own: status.engine === "friday-voice" && status.own,
    note:
      status.engine === "friday-voice" && status.own
        ? "FRIDAY's own engine is speaking on this PC."
        : "The older voice package is speaking; FRIDAY's own engine is not active, so the FRIDAY voices may sound like a preset.",
  };
}

/** One honest line shown under the picker. FRIDAY is an assistant, not a person, and no voice is a copy of anyone. */
export const SYNTHETIC_VOICE_NOTE =
  "Every voice here is synthetic. FRIDAY is an assistant, not a person, and none of these voices copies a real person.";

/** The local voice style the profile asks of the standard voice ("" keeps the engine's default). */
export function profileVoiceStyle(
  voice: Partial<ProfileSource>,
  engine: ProfileEngine = "supertonic",
): string {
  return (
    profileFromPreferences(voice).modelRefs.find((ref) => ref.engine === engine)?.voiceStyle ?? ""
  );
}

export type ProfileFit = {
  fits: boolean;
  /** The profile's languages this engine can speak. */
  languages: ProfileLanguage[];
  /** The pitch nudge reaches this engine. */
  pitchApplies: boolean;
  reasons: string[];
};

/** Can this engine render the profile? It must speak at least one of its languages and know its style. */
export function profileFits(profile: FridayVoiceProfile, engine: string): ProfileFit {
  if (!isEngine(engine)) {
    return {
      fits: false,
      languages: [],
      pitchApplies: false,
      reasons: [`${engine} is not a known engine`],
    };
  }
  const caps = PROFILE_ENGINES[engine];
  const wanted = profile.languages.map((l) => l.code);
  const covered = wanted.filter((code) => caps.languages.includes(code));
  const reasons: string[] = [];
  if (!covered.length) reasons.push(`${engine} speaks none of the profile's languages`);
  else if (covered.length < wanted.length)
    reasons.push(
      `${engine} speaks only ${covered.join(" and ")}; the other language needs another engine`,
    );
  const style = profile.modelRefs.find((ref) => ref.engine === engine)?.voiceStyle ?? "";
  if (!caps.styles.includes(style)) reasons.push(`${engine} has no style ${style}`);
  if (profile.pitch !== 0 && !caps.pitch)
    reasons.push(`${engine} cannot change pitch; the nudge is left out`);
  return {
    fits: covered.length > 0 && caps.styles.includes(style),
    languages: covered,
    pitchApplies: caps.pitch,
    reasons,
  };
}

/** A new model for one engine, the same logical profile. Everything else about her stays. */
export function rebindModel(
  profile: FridayVoiceProfile,
  engine: ProfileEngine,
  next: { voiceStyle?: string },
): FridayVoiceProfile {
  const refs = profile.modelRefs.filter((ref) => ref.engine !== engine);
  refs.push({
    engine,
    modelId: PROFILE_ENGINES[engine].modelId,
    voiceStyle: next.voiceStyle ?? "",
  });
  return sanitizeFridayVoiceProfile({ ...profile, modelRefs: refs });
}

/** What an engine is asked for one clause of this profile (the pitch is left out where it cannot apply). */
export function profileSpeakParams(
  profile: FridayVoiceProfile,
  engine: ProfileEngine,
): { rate: number; pitch: number | null; style: string } {
  const caps = PROFILE_ENGINES[engine];
  return {
    rate: profile.rate,
    pitch: caps.pitch && profile.pitch !== 0 ? profile.pitch : null,
    style: profile.modelRefs.find((ref) => ref.engine === engine)?.voiceStyle ?? "",
  };
}

/** The text as her profile says it: the built-in pronunciations with the owner's on top (one table, not two). */
export const sayWithProfile = (text: string, profile: FridayVoiceProfile): string =>
  applyPronunciations(text, profile.pronunciations);

/** Licence and credit lines for each model the profile uses, from the model catalog (never invented). */
export function profileCredits(
  profile: FridayVoiceProfile,
  lookup: (id: string) => { name: string; license: string; url: string } | undefined = (id) =>
    modelById.get(id),
): ProfileModelCredit[] {
  return profile.modelRefs.map((ref) => {
    if (!ref.modelId) {
      return {
        ...ref,
        licence: "the voices of this Windows install",
        provenance: "The system voice comes with Windows; FRIDAY adds no model.",
      };
    }
    const row = lookup(ref.modelId);
    if (!row) {
      return {
        ...ref,
        licence: "unknown",
        provenance: `${ref.modelId}: not found in the model catalog (licence unverified)`,
      };
    }
    return {
      ...ref,
      licence: row.license,
      provenance: `${row.name}; licence ${row.license}; ${row.url}`,
    };
  });
}
