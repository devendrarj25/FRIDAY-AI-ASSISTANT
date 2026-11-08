/**
 * FRIDAY · wake-word matching (local, transcript stage).
 *
 * Auto Mode listens locally and stays passive: nothing is dispatched to the
 * brain until FRIDAY's name is actually heard. The previous implementation
 * built a `\bfriday\b` RegExp straight from the preference, which failed on
 * every realistic transcript faster-whisper produces:
 *
 *   · "Friday," / "friday." / "FRIDAY!"   — punctuation glued to the word
 *   · "hey friday" / "okay friday"        — the natural spoken carrier
 *   · "फ्राइडे" / "फ्रायडे"                 — Hindi transcription of the name
 *   · "fridey" / "frydey" / "freeday"     — one-character recognition slips
 *   · `\b` does not fire at all between Devanagari characters in JS
 *
 * Everything here is pure string work on an ALREADY transcribed utterance —
 * no audio leaves the machine, and there is exactly one matcher for the whole
 * app so Auto Mode, the tray and the tests agree on what "heard FRIDAY" means.
 */

/** Words people put in front of the name that must not become the command. */
const CARRIERS = new Set(["hey", "hi", "hello", "ok", "okay", "yo", "अरे", "हे"]);

/** Devanagari (and other) spellings that mean the configured Latin wake word. */
const TRANSLITERATIONS: Record<string, string[]> = {
  friday: ["फ्राइडे", "फ्रायडे", "फ्रिडे", "फ्राईडे", "फ्रैडे", "फराइडे"],
};

/** Strip punctuation but keep letters/digits in any script (Latin + Devanagari). */
export function normalizeTranscript(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Classic Levenshtein, capped — one recognition slip must still wake FRIDAY. */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length] ?? 3;
}

/** Does this single token mean the wake word? */
export function isWakeToken(token: string, wakeWord: string): boolean {
  const want = normalizeTranscript(wakeWord) || "friday";
  const got = normalizeTranscript(token);
  if (!got) return false;
  if (got === want) return true;
  if ((TRANSLITERATIONS[want] ?? []).some((t) => normalizeTranscript(t) === got)) return true;
  // A five-letter-plus name tolerates exactly one slip ("fridey", "frday").
  if (want.length >= 5 && /^[\p{Script=Latin}]+$/u.test(got) && distance(got, want) <= 1)
    return true;
  return false;
}

export type WakeMatch = {
  /** The wake word really appeared in this utterance. */
  matched: boolean;
  /** What the wake word looked like in the transcript ("Friday," → "friday"). */
  token: string;
  /** Everything after the wake word, carriers removed — may be empty. */
  command: string;
  /** Human-readable reason, recorded in the voice trace. */
  detail: string;
};

/**
 * Find the wake word anywhere in the utterance and return the command that
 * follows it. Only a *leading* wake word (optionally behind "hey"/"okay")
 * strips text; a name mentioned mid-sentence still wakes FRIDAY but keeps the
 * whole utterance as the command, which is what people actually mean when they
 * say "and FRIDAY, open Chrome".
 */
export function matchWakeWord(text: string, wakeWord = "friday"): WakeMatch {
  const raw = String(text || "").trim();
  const tokens = normalizeTranscript(raw).split(" ").filter(Boolean);
  if (!tokens.length) return { matched: false, token: "", command: "", detail: "empty transcript" };

  const index = tokens.findIndex((t) => isWakeToken(t, wakeWord));
  if (index < 0)
    return { matched: false, token: "", command: raw, detail: "no wake word in transcript" };

  // Only carriers ("hey", "okay") may precede the name for a leading match.
  const leading = tokens.slice(0, index).every((t) => CARRIERS.has(t));
  const rest = tokens
    .slice(index + 1)
    .join(" ")
    .trim();
  const token = tokens[index] ?? "";
  return {
    matched: true,
    token,
    command: leading ? rest : normalizeTranscript(raw),
    detail: leading
      ? `wake word matched "${token}"${rest ? "" : " (name only)"}`
      : `wake word matched "${token}" mid-sentence`,
  };
}

/** "stop" / "ruko" / "रुक जाओ" / "cancel" — an interruption, never a task to execute. */
const STOP =
  /^(?:friday[\s,]*)?(stop|stop it|cancel|quiet|shut up|enough|be quiet|nevermind|never mind|wait|hold on|ruko|ruk jao|ruk ja|bas|chup|बस|रुक|रुको|रुक जाओ|चुप)$/i;

/** Words around a stop that do not change it: "please stop", "ok stop", "nahi ruko", "ruko yaar". */
const STOP_FILLER = new Set(
  "friday please plz ok okay hey achha accha haan han ji yaar now ab abhi nahi no bhai फ्राइडे कृपया प्लीज अब अभी नहीं जी".split(
    " ",
  ),
);

/**
 * The whole phrase must be one of these, so "stop the music", "stop recording" and "the bus stop" stay requests.
 * Hindi, Hinglish and English; each one ends her speech only, never a task (`classifyVoiceControl` names a task).
 */
const STOP_PHRASES = new Set(
  [
    "stop it",
    "stop talking",
    "stop speaking",
    "stop reading",
    "stop right there",
    "stop there",
    "stop stop",
    "cancel that",
    "cancel it",
    "enough now",
    "that s enough",
    "that is enough",
    "wait a second",
    "wait a minute",
    "hold it",
    "hold up",
    "pause",
    "ruko zara",
    "zara ruko",
    "thoda ruko",
    "ruk",
    "rukiye",
    "ruk jaiye",
    "ek minute",
    "ek second",
    "ek sec",
    "bas karo",
    "bas kar do",
    "bas kar",
    "bas itna",
    "bas bas",
    "chup raho",
    "chup ho jao",
    "chup kar",
    "chup karo",
    "band karo",
    "band kar do",
    "mat bolo",
    "mat bol",
    "बस करो",
    "बस कर दो",
    "रुकिए",
    "ठहरो",
    "थोड़ा रुको",
    "एक मिनट",
    "चुप हो जाओ",
    "चुप रहो",
    "बंद करो",
    "बंद कर दो",
  ].map((p) => p.normalize("NFC")),
);

/** The short words that always stop her, named or not: "stop", "ruko", "bas", "wait". */
export function isPlainStop(text: string): boolean {
  return STOP.test(normalizeTranscript(text));
}

export function isStopCommand(text: string): boolean {
  const norm = normalizeTranscript(text);
  if (STOP.test(norm)) return true;
  const tokens = norm.split(" ").filter(Boolean);
  let from = 0;
  let to = tokens.length;
  while (from < to && STOP_FILLER.has(tokens[from] ?? "")) from += 1;
  while (to > from && STOP_FILLER.has(tokens[to - 1] ?? "")) to -= 1;
  const core = tokens.slice(from, to).join(" ").normalize("NFC");
  return core.length > 0 && (STOP.test(core) || STOP_PHRASES.has(core));
}

/**
 * True when the recognised text is FRIDAY's own TTS coming back through the
 * microphone. Caller must also check that she was recently speaking.
 */
export function isSelfEchoTranscript(
  heard: string,
  spoken: string,
  options: { speaking?: boolean } = {},
): boolean {
  const h = normalizeTranscript(heard);
  const s = normalizeTranscript(spoken);
  if (!h || !s || h.length < 3) return false;
  // After she has finished (only the tail of the room's sound is left), a few words that sit inside what she said
  // are far more likely the owner answering her ("open it" after "Do you want me to open it now?") than an echo.
  // Only her last words count as an echo then. While she is speaking, any part of her sentence can come back.
  const tail = options.speaking === false;
  if (tail && h.split(" ").length <= 4) return s.endsWith(h);
  if (s.includes(h)) return true;
  const prefix = s.slice(0, Math.min(s.length, Math.max(24, h.length)));
  if (prefix.length >= 8 && h.includes(prefix)) return true;
  const heardTokens = h.split(" ").filter((word) => word.length > 2);
  const spokenTokens = new Set(s.split(" ").filter((word) => word.length > 2));
  if (heardTokens.length < 2 || spokenTokens.size < 2) return false;
  let hit = 0;
  for (const word of heardTokens) if (spokenTokens.has(word)) hit += 1;
  return hit / heardTokens.length >= 0.75;
}
