import { persistentRetryDelayMs } from "./bounded-retry";

/** A failure is spoken once per cause for this session. The screen keeps the detail. */
export function mayAnnounce(cause: string, spoken: ReadonlySet<string>): boolean {
  return !spoken.has(cause);
}

export function recoveryDelayMs(attempt: number): number {
  return persistentRetryDelayMs(attempt);
}

export function failureCause(message: string): string {
  const text = message.toLowerCase();
  if (text.includes("download")) return "downloading";
  if (
    text.includes("model failed") ||
    text.includes("could not load") ||
    text.includes("weights")
  ) {
    return "model-failed";
  }
  if (text.includes("not installed") || text.includes("python") || text.includes("import"))
    return "install";
  if (text.includes("permission")) return "permission";
  if (text.includes("exclusive")) return "exclusive";
  if (text.includes("another") || text.includes("holding") || text.includes("busy")) return "busy";
  if (
    text.includes("no audio") ||
    text.includes("no working microphone") ||
    text.includes("no microphone") ||
    text.includes("no device")
  ) {
    return "device";
  }
  return "voice";
}

export type VoiceLang = "en" | "hi" | "hinglish";

/** Map the stored recognition language onto a spoken repair language. */
export function ownerVoiceLang(pref: string): VoiceLang {
  const value = String(pref || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (!value) return "en";
  if (value === "hinglish" || value === "hi-en" || value === "en-in") return "hinglish";
  if (value.startsWith("hi")) return "hi";
  if (value.startsWith("en")) return "en";
  return "hinglish";
}

const LINES: Record<string, Record<VoiceLang, readonly string[]>> = {
  install: {
    en: [
      "Voice is not set up yet. Use Fix voice and I will try again.",
      "The speech setup is missing. Fix voice starts it.",
    ],
    hi: [
      "Awaaz abhi set up nahi hai. Fix voice dabao.",
      "Speech setup baaki hai. Fix voice se shuru hogi.",
    ],
    hinglish: [
      "Voice install nahi hui. Fix voice se ho jayegi.",
      "Speech setup missing hai. Fix voice try karegi.",
    ],
  },
  permission: {
    en: [
      "I can't use the microphone until you allow it.",
      "Microphone permission is off. Allow it, then try again.",
    ],
    hi: ["Microphone ki permission nahi hai. Allow karo.", "Awaaz sunne ki permission band hai."],
    hinglish: [
      "Mic permission nahi mili. Allow karke try karo.",
      "Microphone allow nahi hai abhi.",
    ],
  },
  busy: {
    en: [
      "Another app is using the microphone.",
      "The microphone is busy. I'll try again when it is free.",
    ],
    hi: ["Microphone kisi aur app ke paas hai.", "Mic abhi vyast hai."],
    hinglish: ["Mic kisi aur app ne pakad rakha hai.", "Microphone busy hai abhi."],
  },
  exclusive: {
    en: [
      "The microphone is locked in exclusive mode.",
      "Another app has exclusive use of the microphone.",
    ],
    hi: ["Microphone exclusive mode mein hai.", "Mic lock ho gaya hai."],
    hinglish: ["Mic exclusive mode mein lock hai.", "Microphone exclusive use mein hai."],
  },
  device: {
    en: ["I can't find a microphone.", "No microphone is available right now."],
    hi: ["Koi microphone nahi mila.", "Mic device nahi dikh raha."],
    hinglish: ["Koi mic nahi mila.", "Microphone device missing hai."],
  },
  downloading: {
    en: [
      "The speech model is still downloading. Listening waits for it.",
      "A voice download is in progress.",
    ],
    hi: ["Speech model abhi download ho raha hai.", "Download chal raha hai. Sunna baad mein."],
    hinglish: [
      "Model download ho raha hai. Listening rukegi tab tak.",
      "Voice download chal rahi hai.",
    ],
  },
  "model-failed": {
    en: [
      "The speech model did not load. I'll try a smaller one.",
      "That voice model failed. Fix voice retries it.",
    ],
    hi: ["Speech model load nahi hua. Chhota model try karungi.", "Model fail ho gaya."],
    hinglish: ["Model load nahi hua. Smaller one try karungi.", "Voice model fail ho gaya."],
  },
  voice: {
    en: [
      "Voice hit a problem. The screen has the detail.",
      "Something went wrong with voice. Use Fix voice.",
    ],
    hi: ["Awaaz mein dikkat hai. Screen par detail hai.", "Voice ruk gayi. Fix voice dabao."],
    hinglish: [
      "Voice mein problem hai. Detail screen par hai.",
      "Voice fail ho gayi. Fix voice try karo.",
    ],
  },
};

/**
 * A short spoken line for this cause, in the owner's language.
 * The screen keeps the longer detail. Internals are not spoken.
 */
export function voiceFailureLine(cause: string, salt: number, lang?: VoiceLang): string {
  const key = LINES[cause] ? cause : "voice";
  const language = lang || ownerVoiceLang("");
  const bank = LINES[key]?.[language] ?? LINES["voice"]?.en ?? [];
  const index = bank.length ? Math.abs(Math.floor(salt)) % bank.length : 0;
  return bank[index] ?? "Voice hit a problem. The screen has the detail.";
}

/** Listening starts again after a spoken reply when Auto is still the session. */
export function resumeAfterSpokenReply(input: {
  mode: string;
  paused: boolean;
  dictationActive?: boolean;
}): boolean {
  return input.mode === "auto" && input.paused !== true && input.dictationActive !== true;
}

export function shouldRetryNow(trigger: string): boolean {
  return (
    trigger === "install-finished" ||
    trigger === "model-ready" ||
    trigger === "settings" ||
    trigger === "device" ||
    trigger === "focus" ||
    trigger === "toggle" ||
    trigger === "fix-voice"
  );
}
