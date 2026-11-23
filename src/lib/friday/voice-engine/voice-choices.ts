/**
 * FRIDAY · the speech-to-text and text-to-speech pickers of Settings > Voice (pure).
 *
 * The rows come from the registries that already exist, never from a list typed into the screen: the speech sizes
 * and their memory from `STT_SIZE_MODEL` and `voiceModelFacts` (model-catalog.ts), what this PC can carry from the
 * speech budget (`residentNeedGb` in hardware-profile.ts, the same table setup and Doctor use), and the voices from
 * `TTS_INFO` (tts-provider.ts). The labels say what is true: the memory a size needs, whether it fits, whether it
 * is downloaded, and whether a voice stays on this PC.
 */

import { STT_SIZE_MODEL, voiceModelFacts } from "../model-catalog";
import { STT_SIZE_PICKS, type SttSizePick, type TtsEnginePick } from "../preferences";
import { residentNeedGb } from "./hardware-profile";
import { TTS_INFO } from "./tts-provider";

/** What the desktop reports about this PC's speech budget (desktop.ts `VoiceBudget`), or null when it is not known. */
export type SpeechBudgetView = { sttSize: string; speechBudgetGb: number } | null;

export type SttChoice = {
  value: SttSizePick;
  label: string;
  /** Memory this size needs with the voice and helpers loaded beside it, in GB; null for Auto. */
  needGb: number | null;
  /** True when it fits the speech budget; null when the budget or the size is not known. */
  fits: boolean | null;
  /** True when the model is on disk; null when the model store has not been read. */
  installed: boolean | null;
};

const SIZE_NAME: Record<string, string> = {
  tiny: "Tiny",
  base: "Base",
  small: "Small",
  medium: "Medium",
  "large-v3-turbo": "Large turbo",
  "large-v3": "Large",
};

const gb = (value: number) => `${(Math.round(value * 10) / 10).toFixed(1)} GB`;

/**
 * Auto first, then every size voice mode can load. The label carries the memory, the fit and the download state.
 * A size that needs a GPU says so; a size over the budget says it may load slowly or not at all.
 */
export function sttChoices(input: {
  budget: SpeechBudgetView;
  installed: Readonly<Record<string, string | null | undefined>> | null;
}): SttChoice[] {
  const { budget, installed } = input;
  const rows: SttChoice[] = [
    {
      value: "auto",
      label: budget
        ? `Auto (${SIZE_NAME[budget.sttSize] ?? budget.sttSize} for this PC, ${gb(budget.speechBudgetGb)} for speech)`
        : "Auto (the size measured for this PC)",
      needGb: null,
      fits: null,
      installed: null,
    },
  ];
  for (const value of STT_SIZE_PICKS) {
    if (value === "auto") continue;
    const modelId = STT_SIZE_MODEL[value];
    if (!modelId) continue;
    const facts = voiceModelFacts[modelId];
    const needGb = facts ? residentNeedGb(value) : null;
    const fits = needGb !== null && budget ? needGb <= budget.speechBudgetGb : null;
    const have = installed ? Boolean(installed[modelId]) : null;
    const parts: string[] = [];
    if (needGb !== null) parts.push(`about ${gb(needGb)} memory`);
    if (facts && !facts.cpuOk) parts.push("needs a verified GPU");
    else if (fits === false) parts.push("over this PC's speech budget, may be slow or not load");
    else if (fits === true) parts.push("fits this PC");
    if (have === true) parts.push("downloaded");
    else if (have === false) parts.push("not downloaded");
    rows.push({
      value,
      label: `${SIZE_NAME[value] ?? value}${parts.length ? ` (${parts.join(", ")})` : ""}`,
      needGb,
      fits,
      installed: have,
    });
  }
  return rows;
}

export type TtsChoice = {
  value: TtsEnginePick;
  label: string;
  /** True when it is on this PC and ready; null when that cannot be known here (Auto). */
  installed: boolean | null;
  privacy: "on-device" | "cloud" | "mixed";
};

/**
 * Automatic, then the voices a person can pin, in the ranking's own words. `localReady` is whether the standard
 * local voice is downloaded; `systemVoices` is how many Windows voices the system lists. Pinning a voice means the
 * other kinds are not tried for a line, so the rows say which stay on this PC.
 */
export function ttsChoices(input: {
  localReady: boolean | null;
  systemVoices: number | null;
}): TtsChoice[] {
  const state = (value: boolean | null) =>
    value === null ? "" : value ? ", installed" : ", not installed";
  const local = TTS_INFO.supertonic;
  const system = TTS_INFO.sapi;
  return [
    {
      value: "auto",
      label: "Automatic (the online voice when allowed, then the voices on this PC)",
      installed: null,
      privacy: "mixed",
    },
    {
      value: "supertonic",
      label: `Local only: ${local.label}, stays on this PC${state(input.localReady)}`,
      installed: input.localReady,
      privacy: local.privacy,
    },
    {
      value: "sapi",
      label: `System only: ${system.label}, stays on this PC${state(
        input.systemVoices === null ? null : input.systemVoices > 0,
      )}`,
      installed: input.systemVoices === null ? null : input.systemVoices > 0,
      privacy: system.privacy,
    },
  ];
}

/**
 * What a pinned engine allows when a line is spoken. `auto` is the order FRIDAY always had; `supertonic` never
 * asks an online or provider voice; `sapi` goes to the system voice and skips the neural paths.
 */
export function ttsEnginePlan(pick: TtsEnginePick | string | undefined): {
  cloud: boolean;
  neural: boolean;
} {
  if (pick === "sapi") return { cloud: false, neural: false };
  if (pick === "supertonic") return { cloud: false, neural: true };
  return { cloud: true, neural: true };
}
