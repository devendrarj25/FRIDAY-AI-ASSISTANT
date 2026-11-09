/**
 * FRIDAY · her own voice, checked and mended by her.
 *
 * `diagnoseVoice` turns what is really known (the microphone, the speech engine, her voice, the wake
 * engine, and the probes of the voice runtime) into a list of parts with the fault class each one maps to,
 * so the heal policy in `voice-heal.ts` can act on exactly what is broken. `reportLine` says the result in
 * the owner's language from those facts, and never in the same words as the last few times.
 *
 * Pure: no timers, no IPC, no state of its own besides the recent-wording memory in anti-repeat.
 */
import { chooseFresh, type Chance, type LineRegister } from "./brain/anti-repeat";
import { healFault, type HealClass } from "./voice-heal";

export type SelfCheckProbe = {
  id: string;
  label: string;
  ok: boolean;
  optional?: boolean;
  detail?: string;
};

export type SelfCheckInput = {
  micReady: boolean;
  micError: string | null;
  sttReady: boolean;
  sttModel: string | null;
  sttError: string | null;
  /** null before the first thing she said: unknown, not a fault. */
  ttsEngine: string | null;
  ttsError: string | null;
  wakeReady: boolean;
  wakeEngine: string;
  probes: readonly SelfCheckProbe[];
};

export type SelfCheckPart = {
  id: "microphone" | "speech" | "voice" | "wake" | "engine";
  label: string;
  ok: boolean;
  /** A part she can work without (the wake engine falls back to the transcript). */
  optional: boolean;
  detail: string;
  fault: HealClass | "none";
};

export type SelfCheckResult = {
  ok: boolean;
  parts: SelfCheckPart[];
  /** Distinct fault classes to hand to the heal policy, in the order found. */
  faults: HealClass[];
};

const clip = (text: string | null | undefined) =>
  String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);

export function diagnoseVoice(input: SelfCheckInput): SelfCheckResult {
  const parts: SelfCheckPart[] = [];
  const micOk = input.micReady && !input.micError;
  parts.push({
    id: "microphone",
    label: "microphone",
    ok: micOk,
    optional: false,
    detail: micOk ? "open" : clip(input.micError) || "no working microphone",
    fault: micOk ? "none" : healFault(input.micError || "no working microphone"),
  });
  const sttOk = input.sttReady && !input.sttError;
  parts.push({
    id: "speech",
    label: "speech recognition",
    ok: sttOk,
    optional: false,
    detail: sttOk
      ? `ready${input.sttModel ? ` (${input.sttModel})` : ""}`
      : clip(input.sttError) || "not verified",
    fault: sttOk ? "none" : healFault(input.sttError || "speech model not verified"),
  });
  const ttsOk = !input.ttsError && input.ttsEngine !== "none";
  parts.push({
    id: "voice",
    label: "voice",
    ok: ttsOk,
    optional: false,
    detail: ttsOk
      ? input.ttsEngine || "not used yet"
      : clip(input.ttsError) || "no voice could speak",
    fault: ttsOk ? "none" : "tts-engine-fail",
  });
  parts.push({
    id: "wake",
    label: "wake engine",
    ok: input.wakeReady,
    optional: true,
    detail: input.wakeReady ? input.wakeEngine : "using the transcript fallback",
    fault: "none",
  });
  for (const probe of input.probes) {
    if (probe.ok || probe.optional) continue;
    parts.push({
      id: "engine",
      label: probe.label,
      ok: false,
      optional: false,
      detail: clip(probe.detail),
      fault: healFault(probe.detail || probe.id),
    });
  }
  const broken = parts.filter((part) => !part.ok && !part.optional);
  const faults: HealClass[] = [];
  for (const part of broken) {
    if (part.fault !== "none" && !faults.includes(part.fault)) faults.push(part.fault);
  }
  return { ok: broken.length === 0, parts, faults };
}

const NAMES: Record<LineRegister, Record<string, string>> = {
  en: {
    microphone: "the microphone",
    speech: "speech recognition",
    voice: "my voice",
    engine: "a speech component",
  },
  hinglish: {
    microphone: "mic",
    speech: "speech recognition",
    voice: "meri awaaz",
    engine: "ek speech component",
  },
  hi: {
    microphone: "माइक",
    speech: "स्पीच पहचान",
    voice: "मेरी आवाज़",
    engine: "एक स्पीच हिस्सा",
  },
};

function joinNames(names: string[], register: LineRegister): string {
  if (names.length <= 1) return names[0] ?? "";
  const and = register === "hi" ? "और" : register === "hinglish" ? "aur" : "and";
  return `${names.slice(0, -1).join(", ")} ${and} ${names[names.length - 1]}`;
}

/**
 * What she says after a check that found something wrong, built from the parts that really failed.
 * `fixing` is whether a repair was started (a part that is out of attempts is handed to the owner instead).
 */
export function problemLine(
  result: SelfCheckResult,
  register: LineRegister,
  options: { fixing: boolean; chance?: Chance } = { fixing: true },
): string {
  const chance = options.chance;
  const names = result.parts
    .filter((part) => !part.ok && !part.optional)
    .map((part) => NAMES[register][part.id] ?? part.label);
  const unique = names.filter((name, at) => names.indexOf(name) === at);
  const list = joinNames(unique, register);
  const templates: Record<LineRegister, { fix: string[]; ask: string[] }> = {
    en: {
      fix: [
        `${list} needed attention. I'm fixing it now.`,
        `Found a problem with ${list}. Working on it.`,
        `${list} wasn't right, so I'm repairing it.`,
        `Something was off with ${list}. I've started the fix.`,
      ],
      ask: [
        `${list} still isn't right and I can't mend it alone. Check the line on screen.`,
        `I tried to fix ${list} and need you for the rest. The note is on screen.`,
      ],
    },
    hinglish: {
      fix: [
        `${list} me problem thi. Abhi theek kar rahi hoon.`,
        `${list} sahi nahi tha, fix shuru kar diya.`,
        `${list} ko dekha, kuch gadbad mili. Sudhaar rahi hoon.`,
        `${list} me dikkat aayi, ab theek karti hoon.`,
      ],
      ask: [
        `${list} abhi bhi theek nahi hua, aur ye main akeli nahi kar sakti. Screen par likha hai.`,
        `Maine ${list} theek karne ki koshish ki, baaki aapko dekhna hoga. Screen par note hai.`,
      ],
    },
    hi: {
      fix: [
        `${list} में समस्या थी। अभी ठीक कर रही हूँ।`,
        `${list} सही नहीं था, मरम्मत शुरू कर दी।`,
        `${list} में कुछ गड़बड़ मिली। सुधार रही हूँ।`,
      ],
      ask: [
        `${list} अब भी ठीक नहीं हुआ और यह मैं अकेले नहीं कर सकती। स्क्रीन पर लिखा है।`,
        `मैंने ${list} ठीक करने की कोशिश की, बाक़ी आपको देखना होगा।`,
      ],
    },
  };
  const pool = options.fixing ? templates[register].fix : templates[register].ask;
  return chooseFresh(`selfcheck:${options.fixing ? "fix" : "ask"}:${register}`, pool, chance);
}
