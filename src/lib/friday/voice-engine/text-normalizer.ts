/**
 * FRIDAY · text for the voice: numbers, money, dates, times, acronyms, names and markdown, said the way a person
 * says them, in the language of each span.
 *
 * Numbers become words (Hindi words in a Hindi span, English words in an English span, lakh and crore for large
 * Indian amounts) so a voice does not guess how to read "1,50,000" or "25/01/2026". A pronunciation dictionary
 * (built-in plus the owner's own entries) replaces names and acronyms before anything is read letter by letter.
 * Pure text in, text out: no network, no clock. The Hindi number words are the standard forms written from
 * knowledge, not heard through a voice here; the owner should listen and correct entries through the dictionary.
 */
import { segment, type SpeechLang } from "./language-segmenter";

const EN_ONES =
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(
    " ",
  );
const EN_TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split(" ");

function enBelow100(n: number): string {
  if (n < 20) return EN_ONES[n] ?? "";
  const tens = EN_TENS[Math.floor(n / 10)] ?? "";
  return n % 10 ? `${tens} ${EN_ONES[n % 10]}` : tens;
}

function enBelow1000(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return [hundreds ? `${EN_ONES[hundreds]} hundred` : "", rest ? enBelow100(rest) : ""]
    .filter(Boolean)
    .join(" ");
}

/** English words in the Indian system (thousand, lakh, crore). Up to 99 crore; beyond that the digits stay. */
export function englishNumber(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= 1e9) return String(n);
  if (n === 0) return "zero";
  const parts: string[] = [];
  const crore = Math.floor(n / 1e7);
  const lakh = Math.floor((n % 1e7) / 1e5);
  const thousand = Math.floor((n % 1e5) / 1e3);
  const rest = n % 1e3;
  if (crore) parts.push(`${enBelow100(crore)} crore`);
  if (lakh) parts.push(`${enBelow100(lakh)} lakh`);
  if (thousand) parts.push(`${enBelow100(thousand)} thousand`);
  if (rest) parts.push(enBelow1000(rest));
  return parts.join(" ");
}

const HI_UNDER_100 =
  "शून्य एक दो तीन चार पाँच छह सात आठ नौ दस ग्यारह बारह तेरह चौदह पंद्रह सोलह सत्रह अठारह उन्नीस बीस " +
  "इक्कीस बाईस तेईस चौबीस पच्चीस छब्बीस सत्ताईस अट्ठाईस उनतीस तीस इकतीस बत्तीस तैंतीस चौंतीस पैंतीस छत्तीस सैंतीस अड़तीस उनतालीस चालीस " +
  "इकतालीस बयालीस तैंतालीस चौवालीस पैंतालीस छियालीस सैंतालीस अड़तालीस उनचास पचास " +
  "इक्यावन बावन तिरपन चौवन पचपन छप्पन सत्तावन अट्ठावन उनसठ साठ " +
  "इकसठ बासठ तिरसठ चौंसठ पैंसठ छियासठ सड़सठ अड़सठ उनहत्तर सत्तर " +
  "इकहत्तर बहत्तर तिहत्तर चौहत्तर पचहत्तर छिहत्तर सतहत्तर अठहत्तर उनासी अस्सी " +
  "इक्यासी बयासी तिरासी चौरासी पचासी छियासी सत्तासी अट्ठासी नवासी नब्बे " +
  "इक्यानवे बानवे तिरानवे चौरानवे पचानवे छियानवे सत्तानवे अट्ठानवे निन्यानवे";
const HI = HI_UNDER_100.split(" ");

/** Hindi words (Devanagari) up to 99 crore; beyond that the digits stay. */
export function hindiNumber(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= 1e9) return String(n);
  if (n < 100) return HI[n] ?? String(n);
  const parts: string[] = [];
  const crore = Math.floor(n / 1e7);
  const lakh = Math.floor((n % 1e7) / 1e5);
  const thousand = Math.floor((n % 1e5) / 1e3);
  const hundreds = Math.floor((n % 1e3) / 100);
  const rest = n % 100;
  if (crore) parts.push(`${HI[crore]} करोड़`);
  if (lakh) parts.push(`${HI[lakh]} लाख`);
  if (thousand) parts.push(`${HI[thousand]} हज़ार`);
  if (hundreds) parts.push(`${HI[hundreds]} सौ`);
  if (rest) parts.push(HI[rest] ?? "");
  return parts.join(" ");
}

const say = (n: number, lang: SpeechLang): string =>
  lang === "hi" ? hindiNumber(n) : englishNumber(n);

const DIGIT_WORDS: Record<SpeechLang, string[]> = {
  en: EN_ONES.slice(0, 10),
  hi: HI.slice(0, 10),
};

const MONTHS_EN =
  "January February March April May June July August September October November December".split(
    " ",
  );
const MONTHS_HI = "जनवरी फ़रवरी मार्च अप्रैल मई जून जुलाई अगस्त सितंबर अक्टूबर नवंबर दिसंबर".split(
  " ",
);

function number(text: string, lang: SpeechLang): string {
  const clean = text.replace(/,/g, "");
  const [whole = "", frac] = clean.split(".");
  const spoken = say(Number(whole), lang);
  if (frac === undefined) return spoken;
  const point = lang === "hi" ? "दशमलव" : "point";
  return `${spoken} ${point} ${[...frac].map((d) => DIGIT_WORDS[lang][Number(d)]).join(" ")}`;
}

/** Numbers, money, dates, times and percentages in one span, in that span's language. */
export function spellNumbers(span: string, lang: SpeechLang): string {
  const rupees = lang === "hi" ? "रुपये" : "rupees";
  const percent = lang === "hi" ? "प्रतिशत" : "percent";
  let line = span;
  // Dates: 25/01/2026 or 25-01-2026 (day first, as written in India).
  line = line.replace(
    /\b(0?[1-9]|[12]\d|3[01])[/-](0?[1-9]|1[0-2])[/-](\d{4})\b/g,
    (_m, d, mo, y) => {
      const month = (lang === "hi" ? MONTHS_HI : MONTHS_EN)[Number(mo) - 1] ?? "";
      return `${say(Number(d), lang)} ${month} ${say(Number(y), lang)}`;
    },
  );
  // Times: 5:30 pm, 17:05.
  line = line.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\s*(am|pm|AM|PM)?/g, (_m, h, mi, ap) => {
    const minutes = Number(mi);
    const hours = say(Number(h), lang);
    const minute = minutes === 0 ? (lang === "hi" ? "बजे" : "o'clock") : say(minutes, lang);
    const suffix = ap ? ` ${String(ap).toUpperCase() === "AM" ? "A M" : "P M"}` : "";
    return `${hours} ${minute}${suffix}`;
  });
  // Money before or after the number.
  line = line.replace(
    /(?:₹|Rs\.?|INR)\s*(\d[\d,]*(?:\.\d+)?)/gi,
    (_m, n) => `${number(n, lang)} ${rupees}`,
  );
  line = line.replace(
    /(\d[\d,]*(?:\.\d+)?)\s*(?:₹|rs\b\.?|INR\b)/gi,
    (_m, n) => `${number(n, lang)} ${rupees}`,
  );
  line = line.replace(
    /\$\s*(\d[\d,]*(?:\.\d+)?)/g,
    (_m, n) => `${number(n, lang)} ${lang === "hi" ? "डॉलर" : "dollars"}`,
  );
  line = line.replace(/(\d[\d,]*(?:\.\d+)?)\s*%/g, (_m, n) => `${number(n, lang)} ${percent}`);
  // Everything left that is a number.
  line = line.replace(/\b\d[\d,]*(?:\.\d+)?\b/g, (n) =>
    n.replace(/,/g, "").length > 9 ? n : number(n, lang),
  );
  return line;
}

/** Built-in pronunciations. Whole words, case sensitive. The owner's entries win. */
export const BUILTIN_PRONUNCIATIONS: Record<string, string> = {
  FRIDAY: "Friday",
  OK: "okay",
  AI: "A I",
  PDF: "P D F",
  GST: "G S T",
  PAN: "pan",
  UPI: "U P I",
  OTP: "O T P",
  API: "A P I",
  URL: "U R L",
  USB: "U S B",
  PC: "P C",
  CPU: "C P U",
  GPU: "G P U",
  RAM: "ram",
  Wi: "Wi",
  Excel: "Excel",
};

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replace dictionary words. Longest entries first; only whole words. */
export function applyPronunciations(text: string, overrides: Record<string, string> = {}): string {
  const table = { ...BUILTIN_PRONUNCIATIONS, ...overrides };
  const keys = Object.keys(table)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!keys.length) return text;
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(${keys.map(escapeRe).join("|")})(?![\\p{L}\\p{N}_])`,
    "gu",
  );
  return text.replace(pattern, (word) => table[word] ?? word);
}

/** Markdown, links, code and emoji out; what is left is what should be said. */
export function stripMarkup(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, "$1")
    .replace(/https?:\/\/\S+/gi, "a link")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/(\*\*|__|\*|_)(\S[^*_]*?)\1/g, "$2")
    .replace(/[\u{1F300}-\u{1FAFF}☀-➿]/gu, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * The whole preparation for one reply: markup out, dictionary words replaced, then numbers spelled span by span
 * in each span's language. Newlines become sentence breaks so a list is read as separate sentences.
 */
export function prepareForSpeech(text: string, overrides: Record<string, string> = {}): string {
  const cleaned = applyPronunciations(stripMarkup(text), overrides)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (/[.!?।:]$/.test(line) ? line : `${line}.`))
    .join(" ");
  return segment(cleaned)
    .map((span) => spellNumbers(span.text, span.lang))
    .join(" ")
    .replace(/\s+([.,!?।])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const MAX_PRONUNCIATIONS = 100;

/** Owner entries made safe: short strings only, a bounded count, no empty or identical pairs. */
export function sanitizePronunciations(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out: Record<string, string> = {};
  for (const [written, said] of Object.entries(input as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_PRONUNCIATIONS) break;
    const key = written.trim();
    const value = typeof said === "string" ? said.trim() : "";
    if (!key || !value || key.length > 40 || value.length > 80 || key === value) continue;
    out[key] = value;
  }
  return out;
}
