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
  if (text.includes("could not load") || text.includes("model failed") || text.includes("weights"))
    return "model-failed";
  if (text.includes("not installed") || text.includes("python") || text.includes("import"))
    return "install";
  if (text.includes("permission")) return "permission";
  if (text.includes("exclusive")) return "exclusive";
  if (text.includes("another") || text.includes("holding") || text.includes("busy")) return "busy";
  if (
    text.includes("no audio") ||
    text.includes("no working microphone") ||
    text.includes("no device")
  )
    return "device";
  return "voice";
}

const LINES: Record<string, Record<string, string[]>> = {
  install: {
    en: ["Voice is not ready yet. The screen has the install step."],
    hi: ["Awaaz abhi taiyar nahi hai. Screen par kadam likha hai."],
    hinglish: ["Voice abhi ready nahi hai. Screen par step likha hai."],
  },
  permission: {
    en: ["The microphone permission is off. The screen has the switch."],
    hi: ["Microphone ki anumati band hai. Screen par switch hai."],
    hinglish: ["Mic permission off hai. Screen par switch hai."],
  },
  busy: {
    en: ["Another app is using the microphone. I will try again when it is free."],
    hi: ["Koi aur app microphone use kar rahi hai. Khali hote hi main sunungi."],
    hinglish: ["Mic abhi kisi aur app ke paas hai. Free hote hi sunungi."],
  },
  exclusive: {
    en: ["The microphone is in exclusive mode. The screen has the sound setting."],
    hi: ["Microphone exclusive mode mein hai. Screen par sound setting hai."],
    hinglish: ["Mic exclusive mode mein hai. Screen par sound setting hai."],
  },
  device: {
    en: ["I cannot find a microphone. Plug one in, then try again."],
    hi: ["Microphone nahi mila. Laga kar phir se kaho."],
    hinglish: ["Mic nahi mila. Laga kar phir try karo."],
  },
  downloading: {
    en: ["The speech model is still downloading. Listening continues on what is already here."],
    hi: ["Speech model abhi aa raha hai. Jo yahin hai usi par sunungi."],
    hinglish: ["Model abhi download ho raha hai. Jo local hai usi par sunungi."],
  },
  "model-failed": {
    en: ["That speech model did not load. I am stepping down to a smaller one."],
    hi: ["Yeh model nahi khula. Main chhote model par aa rahi hoon."],
    hinglish: ["Yeh model load nahi hua. Smaller model par aa rahi hoon."],
  },
  voice: {
    en: ["Voice hit a problem. The screen has the detail."],
    hi: ["Awaaz mein dikkat aayi. Screen par detail hai."],
    hinglish: ["Voice mein problem aayi. Screen par detail hai."],
  },
};

export function ownerVoiceLang(language: string): "en" | "hi" | "hinglish" {
  const lang = language.toLowerCase();
  if (!lang) return "en";
  if (lang.startsWith("hi") && !lang.includes("en")) return "hi";
  if (lang.includes("hinglish") || lang.includes("en-in") || lang === "hi-en") return "hinglish";
  if (lang.startsWith("en")) return "en";
  return "hinglish";
}

export function voiceFailureLine(cause: string, salt: number, lang?: string): string {
  const language = ownerVoiceLang(lang || "");
  const bank =
    LINES[cause]?.[language] ?? LINES["voice"]?.[language] ?? LINES["voice"]?.["en"] ?? [];
  const index = bank.length ? Math.abs(Math.floor(salt)) % bank.length : 0;
  return bank[index] ?? "Voice hit a problem. The screen has the detail.";
}

/** Listening starts again after a spoken reply. */
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
