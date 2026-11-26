/** Capture decisions for real Windows audio events. The events are injected. */

export function negotiateRate(offered: readonly number[], want = 16000): number {
  const rates = offered.filter((rate) => Number.isFinite(rate) && rate > 0);
  if (!rates.length) return want;
  if (rates.includes(want)) return want;
  const above = rates.filter((rate) => rate > want).sort((a, b) => a - b);
  return above[0] || rates.slice().sort((a, b) => b - a)[0] || want;
}

export function onProfileSwitch(profile: string): {
  reopen: boolean;
  rate: number;
  reason: string;
} {
  if (profile === "hfp") return { reopen: true, rate: 16000, reason: "headset call profile" };
  if (profile === "a2dp") return { reopen: true, rate: 48000, reason: "headset media profile" };
  return { reopen: false, rate: 16000, reason: "profile unchanged" };
}

export function onSessionEvent(kind: string): { reopen: boolean; reason: string } {
  switch (kind) {
    case "hotplug":
    case "default-device":
    case "sleep":
    case "resume":
    case "lock":
    case "unlock":
    case "fast-user-switch":
      return { reopen: true, reason: kind };
    case "exclusive":
      return { reopen: true, reason: "exclusive mode" };
    default:
      return { reopen: false, reason: "ignored" };
  }
}

export function trackWatch(input: {
  frames: number;
  sameEnergy: number;
  handles: number;
  crashes: number;
}): { stuck: boolean; leak: boolean; restart: boolean } {
  const stuck = input.frames > 50 && input.sameEnergy > 40;
  const leak = input.handles > 8;
  const restart = stuck || leak || input.crashes > 0;
  return { stuck, leak, restart };
}

let offered: number[] = [16000, 48000];

/** Remember the rate a headset or a hot-plug asked for, then pick one rate. */
export function applySession(
  kind: string,
  profile = "unchanged",
): { reopen: boolean; rate: number } {
  const session = onSessionEvent(kind);
  const headset = onProfileSwitch(profile);
  if (headset.reopen) offered = [headset.rate, 16000];
  return { reopen: session.reopen || headset.reopen, rate: negotiateRate(offered) };
}

export function captureRate(): number {
  return negotiateRate(offered);
}

/** What the capture graph was opened with. A null rate means the browser did not say. */
export type CaptureRates = { ctx: number | null; track: number | null };

/**
 * A headset that switches between its call and media profiles changes the track rate (or the context rate) under
 * a running graph. True when either known rate moved, so the graph is rebuilt once. Unknown rates never count.
 */
export function captureRateChanged(opened: CaptureRates, now: CaptureRates): boolean {
  const moved = (a: number | null, b: number | null) =>
    typeof a === "number" && typeof b === "number" && a > 0 && b > 0 && Math.abs(a - b) > 1;
  return moved(opened.ctx, now.ctx) || moved(opened.track, now.track);
}

export type InputListState = {
  /** False when `enumerateDevices` failed or is missing: the empty list then means "unknown". */
  enumerated?: boolean;
  /** False until the owner has granted the microphone (labels and ids are blank before that). */
  permitted?: boolean;
  /** True only when the owner explicitly removed the saved choice. */
  remove?: boolean;
};

export type SavedInputPlan = {
  deviceId: string | null;
  cleared: boolean;
  message: string;
  /** The saved id to select again once it returns; null when nothing is saved. */
  restore: string | null;
};

/**
 * Which microphone to open. A saved input that is missing, or a list that is empty because the enumerate failed or
 * the microphone was never allowed, opens the system default for this open only. The saved choice is kept and
 * selected again when it returns (an unplugged or sleeping Bluetooth headset must not lose the owner's pick).
 * `cleared` is true only for an explicit removal against a real, permitted, non-empty list.
 */
export function savedInputPlan(
  savedId: string | null,
  inputs: ReadonlyArray<{ id: string }>,
  state: InputListState = {},
): SavedInputPlan {
  const saved = String(savedId || "").trim();
  if (!saved) {
    return {
      deviceId: null,
      cleared: false,
      message: "Microphone changed. Using the default device.",
      restore: null,
    };
  }
  if (inputs.some((row) => row.id === saved)) {
    return { deviceId: saved, cleared: false, message: "Microphone reopened.", restore: null };
  }
  const known = state.enumerated !== false && state.permitted !== false && inputs.length > 0;
  if (known && state.remove === true) {
    return {
      deviceId: null,
      cleared: true,
      message: "The saved microphone was removed. Using the default device.",
      restore: null,
    };
  }
  return {
    deviceId: null,
    cleared: false,
    message: known
      ? "The saved microphone is not connected. Using the default device until it returns."
      : "The microphone list is not available yet. Using the default device; your choice is kept.",
    restore: saved,
  };
}

const HI = /[\u0900-\u097F]/;

type FaultRule = { test: RegExp; en: string; hi: string; hinglish: string };

const FAULTS: FaultRule[] = [
  {
    test: /permission (required|denied)|NotAllowed|permission-denied/i,
    en: "The microphone is blocked. Allow it in Windows Settings, then try again.",
    hi: "माइक्रोफ़ोन बंद है। Windows सेटिंग में अनुमति दें, फिर दोबारा कोशिश करें।",
    hinglish: "Microphone blocked hai. Windows Settings me allow karo, phir dobara try karo.",
  },
  {
    test: /dependency-incompatible|incompatible|faster-whisper|PyPI|\bav\s*>=/i,
    en: "A voice part needs a repair. Open Doctor and press Repair.",
    hi: "आवाज़ का एक हिस्सा ठीक करना है। Doctor खोलकर Repair दबाएँ।",
    hinglish: "Voice ka ek part repair maangta hai. Doctor kholo aur Repair dabao.",
  },
  {
    test: /no audio frames|no-frames|not reachable|device-offline|NotReadable|in use by/i,
    en: "The microphone is quiet or busy. Reopening it now.",
    hi: "माइक्रोफ़ोन शांत या व्यस्त है। उसे दोबारा खोल रही हूँ।",
    hinglish: "Microphone chup ya busy hai. Dobara khol rahi hoon.",
  },
  {
    test: /no-microphone|no microphone|not found|NotFound/i,
    en: "No microphone found. Plug one in.",
    hi: "कोई माइक्रोफ़ोन नहीं मिला। एक लगाइए।",
    hinglish: "Koi microphone nahi mila. Ek laga do.",
  },
];

/**
 * One short plain sentence for a known voice or microphone fault. Raw engine text (package names, ids, versions)
 * stays in the Doctor detail; an unknown line is returned unchanged so nothing is hidden. The language follows the
 * owner's reply language ("hi" Devanagari, "hinglish" Latin Hindi, anything else English).
 */
export function plainFaultLine(raw: string | null | undefined, language = "en"): string {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  if (HI.test(text)) return text;
  const rule = FAULTS.find((row) => row.test.test(text));
  if (!rule) return text;
  if (/^hi/i.test(language) && !/hinglish/i.test(language)) return rule.hi;
  if (/hinglish|hi-en|hi-latn/i.test(language)) return rule.hinglish;
  return rule.en;
}

/** The language pool for plain fault lines, from the owner's reply-language settings. */
export function faultLanguage(voice: { speechLang?: string; hinglish?: boolean }): string {
  if (voice.hinglish) return "hinglish";
  return /^hi\b|^hi-|hindi/i.test(String(voice.speechLang || "")) ? "hi" : "en";
}
