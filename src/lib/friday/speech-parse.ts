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
};

function hourOf(word: string): number | null {
  const value = ONES[word];
  if (value === undefined || value < 1 || value > 12) return null;
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

  if (dayOffset === null && !weekday && hour === null) return null;
  return { label: label || raw.slice(0, 40), dayOffset, weekday, hour, minute };
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

const corrections = new Map<string, string>();

export function rememberCorrection(heard: string, fixed: string): void {
  const key = heard.trim().toLowerCase();
  const value = fixed.trim();
  if (key && value) corrections.set(key, value);
}

export function applyCorrection(heard: string): string {
  return corrections.get(heard.trim().toLowerCase()) ?? heard;
}

export function resetSpeechCorrections(): void {
  corrections.clear();
}

export function biasPrompt(names: readonly string[]): string {
  const clean = names
    .map((name) => name.trim())
    .filter(Boolean)
    .slice(0, 12);
  if (!clean.length) return "";
  return `Names and apps: ${clean.join(", ")}.`;
}
