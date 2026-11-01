import {
  applyCorrections,
  biasPrompt as biasLine,
  learnCorrection,
  resetCorrections,
} from "./asr-bias";

/** Hindi and Hinglish numbers, clock phrases, and relative days. No calendar date is required. */

const ONES: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  ek: 1,
  do: 2,
  teen: 3,
  char: 4,
  chaar: 4,
  paanch: 5,
  panch: 5,
  chhe: 6,
  che: 6,
  saat: 7,
  aath: 8,
  nau: 9,
  das: 10,
  gyarah: 11,
  barah: 12,
};

const WEEKDAYS = ["somvar", "mangalvar", "budhvar", "guruvar", "shukravar", "shanivar", "ravivar"];

export type WhenPhrase = {
  label: string;
  dayOffset: number | null;
  weekday: string | null;
  hour: number | null;
  minute: number | null;
  /** am or pm when the words say so ("5pm", "shaam 5 baje"); hour stays 1 to 12. */
  meridiem?: "am" | "pm" | null;
  /** A time given as "in 10 minutes": minutes from now. */
  inMinutes?: number | null;
};

const EN_WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function hourOf(word: string): number | null {
  const value = parseNumberToken(word);
  if (value === null || value < 1 || value > 12 || !Number.isInteger(value)) return null;
  return value;
}

export function parseNumberToken(token: string): number | null {
  const word = token.trim().toLowerCase();
  if (/^\d+$/.test(word)) return Number(word);
  if (word in ONES) return ONES[word] ?? null;
  if (word === "dedh") return 1.5;
  if (word === "dhai" || word === "adhai") return 2.5;
  return null;
}

export function parseWhen(text: string): WhenPhrase | null {
  const raw = String(text || "")
    .trim()
    .toLowerCase();
  if (!raw) return null;
  let dayOffset: number | null = null;
  let weekday: string | null = null;
  let hour: number | null = null;
  let minute: number | null = null;
  let label = "";

  if (/\bparso\b/.test(raw)) {
    dayOffset = 2;
    label = "parso";
  } else if (/\bkal\b/.test(raw)) {
    dayOffset = /\b(subah|morning|baje)\b/.test(raw) ? 1 : null;
    label = "kal";
  }
  const nextDay = raw.match(new RegExp(`\\bagle\\s+(${WEEKDAYS.join("|")})\\b`));
  if (nextDay?.[1]) {
    weekday = nextDay[1];
    label = label || `agle ${nextDay[1]}`;
  }

  const paune = raw.match(/\bpaune\s+([a-z]+|\d+)\b/);
  const sawa = raw.match(/\bsawa\s+([a-z]+|\d+)\b/);
  const saade = raw.match(/\b(?:saade|sade|saade)\s+([a-z]+|\d+)\b/);
  if (paune?.[1]) {
    const base = hourOf(paune[1]) ?? (/^\d+$/.test(paune[1]) ? Number(paune[1]) : null);
    if (base && base >= 1) {
      hour = base - 1;
      minute = 45;
      label = label || "paune";
    }
  } else if (sawa?.[1]) {
    const base = hourOf(sawa[1]) ?? (/^\d+$/.test(sawa[1]) ? Number(sawa[1]) : null);
    if (base) {
      hour = base;
      minute = 15;
      label = label || "sawa";
    }
  } else if (saade?.[1]) {
    const base = hourOf(saade[1]) ?? (/^\d+$/.test(saade[1]) ? Number(saade[1]) : null);
    if (base) {
      hour = base;
      minute = 30;
      label = label || "saade";
    }
  } else {
    const clock = raw.match(/\b([a-z]+|\d+)\s+baje\b/);
    if (clock?.[1]) {
      const base = hourOf(clock[1]) ?? (/^\d+$/.test(clock[1]) ? Number(clock[1]) : null);
      if (base) {
        hour = base;
        minute = 0;
        label = label || "baje";
      }
    }
  }

  let meridiem: "am" | "pm" | null = null;
  let inMinutes: number | null = null;

  // English shapes. They only fill what the Hindi reading above left empty, so nothing it understood changes.
  if (dayOffset === null && /\bday after tomorrow\b/.test(raw)) {
    dayOffset = 2;
    label = label || "day after tomorrow";
  } else if (dayOffset === null && /\btomorrow\b/.test(raw)) {
    dayOffset = 1;
    label = label || "tomorrow";
  } else if (dayOffset === null && /\b(today|tonight|aaj)\b/.test(raw)) {
    dayOffset = 0;
    label = label || raw.match(/\b(today|tonight|aaj)\b/)?.[1] || "today";
  }
  if (!weekday) {
    const named = raw.match(
      new RegExp(`\\b(?:next|on|this|coming)?\\s*(${EN_WEEKDAYS.join("|")})\\b`),
    );
    if (named?.[1]) {
      weekday = named[1];
      label = label || named[1];
    }
  }
  if (hour === null) {
    const clock12 = raw.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)/);
    const clock24 = raw.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*(?:am|pm))/);
    const atHour = raw.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\b/);
    if (clock12?.[1]) {
      const base = Number(clock12[1]);
      if (base >= 1 && base <= 12) {
        hour = base;
        minute = clock12[2] ? Number(clock12[2]) : 0;
        meridiem = clock12[3]?.startsWith("a") ? "am" : "pm";
        label = label || `${base}${minute ? `:${String(minute).padStart(2, "0")}` : ""}${meridiem}`;
      }
    } else if (clock24?.[1]) {
      const base = Number(clock24[1]);
      hour = base % 12 === 0 ? 12 : base % 12;
      minute = Number(clock24[2]);
      meridiem = base >= 12 ? "pm" : "am";
      label = label || clock24[0];
    } else if (atHour?.[1]) {
      const base = Number(atHour[1]);
      if (base >= 1 && base <= 12) {
        hour = base;
        minute = atHour[2] ? Number(atHour[2]) : 0;
        label = label || `at ${base}`;
      }
    }
  }
  const relative = raw.match(/\bin\s+(\d+|an?|half an)\s*(min|mins|minutes?|hours?|hrs?)\b/);
  if (relative?.[2] && dayOffset === null && hour === null) {
    const count = /^\d+$/.test(relative[1] ?? "")
      ? Number(relative[1])
      : relative[1] === "half an"
        ? 0.5
        : 1;
    inMinutes = Math.round(count * (relative[2].startsWith("h") ? 60 : 1));
    label = label || `in ${relative[1]} ${relative[2]}`;
  }
  if (meridiem === null && hour !== null) {
    if (/\b(subah|morning)\b/.test(raw)) meridiem = "am";
    else if (/\b(shaam|sham|evening|raat|night|dopahar|afternoon)\b/.test(raw)) meridiem = "pm";
  }

  if (dayOffset === null && !weekday && hour === null && inMinutes === null) return null;
  return {
    label: label || raw.slice(0, 40),
    dayOffset,
    weekday,
    hour,
    minute,
    meridiem,
    inMinutes,
  };
}

function editDistance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const current = row[j] ?? 0;
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      row[j] = Math.min(current + 1, (row[j - 1] ?? 0) + 1, prev + cost);
      prev = current;
    }
  }
  return row[right.length] ?? left.length;
}

export function phoneticHit(heard: string, names: readonly string[]): string | null {
  const left = heard.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (left.length < 3) return null;
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const name of names) {
    const right = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (!right) continue;
    if (left === right || left.includes(right) || right.includes(left)) return name;
    const distance = editDistance(left, right);
    const limit = Math.max(1, Math.floor(Math.max(left.length, right.length) * 0.34));
    if (distance <= limit && distance < bestDistance) {
      bestDistance = distance;
      best = name;
    }
  }
  return best;
}

export function rememberCorrection(heard: string, fixed: string): void {
  learnCorrection(heard, fixed);
}

export function applyCorrection(heard: string): string {
  return applyCorrections(heard);
}

export function resetSpeechCorrections(): void {
  resetCorrections();
}

export function biasPrompt(names: readonly string[]): string {
  const line = biasLine(names, "");
  return line.replace(/^\s+/, "");
}
