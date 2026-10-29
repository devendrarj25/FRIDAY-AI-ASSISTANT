const ONES: Record<string, number> = {
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

export type SpokenUnderstanding = {
  quantity: number | null;
  unit: string | null;
  hour: number | null;
  minute: number | null;
  weekday: string | null;
  fillerStripped: string;
  corrected: string;
};

function quarter(word: string, hour: number): { hour: number; minute: number } | null {
  if (word === "paune") return { hour: (hour + 11) % 12 || 12, minute: 45 };
  if (word === "sawa" || word === "savva" || word === "sava") return { hour, minute: 15 };
  if (word === "sadhe" || word === "saade" || word === "sade") return { hour, minute: 30 };
  return null;
}

/** Hindi and Hinglish numbers, clock time, durations, fillers, and self-corrections. */
export function understandSpoken(text: string): SpokenUnderstanding {
  const raw = String(text || "")
    .replace(/\b(matlab|yaani|nahi nahi)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const corrected = raw.replace(/\b(\w+)\s+nahi\s+(\w+)\b/i, "$2");
  const fillerStripped = corrected
    .replace(/\b(um+|uh+|hmm+|haan ji|acha|achha)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const lower = fillerStripped.toLowerCase();
  let quantity: number | null = null;
  let unit: string | null = null;
  const dhai = /\bdhai\s+(ghante|kilo|minute|min)\b/i.exec(lower);
  const dhaiWord = dhai?.[1] ?? "";
  if (dhai && dhaiWord) {
    quantity = 2.5;
    unit = dhaiWord.startsWith("ghant")
      ? "hour"
      : dhaiWord.startsWith("kilo")
        ? "kilogram"
        : "minute";
  }
  const plain = /\b(ek|do|teen|char|chaar|paanch|panch|das)\s+(ghante|minute|min|kilo)\b/i.exec(
    lower,
  );
  const plainWord = plain?.[1] ?? "";
  const plainUnit = plain?.[2] ?? "";
  if (!dhai && plain && plainWord && plainUnit) {
    quantity = ONES[plainWord] ?? null;
    unit = plainUnit.startsWith("ghant")
      ? "hour"
      : plainUnit.startsWith("kilo")
        ? "kilogram"
        : "minute";
  }
  let hour: number | null = null;
  let minute: number | null = null;
  const clock =
    /\b(paune|sawa|savva|sava|sadhe|saade|sade)\s+(ek|do|teen|char|chaar|paanch|panch|chhe|saat|aath|nau|das|gyarah|barah)\b/i.exec(
      lower,
    );
  const clockWord = clock?.[1] ?? "";
  const clockHour = clock?.[2] ?? "";
  if (clock && clockWord && clockHour) {
    const hit = quarter(clockWord, ONES[clockHour] ?? 0);
    if (hit) {
      hour = hit.hour;
      minute = hit.minute;
    }
  }
  let weekday: string | null = null;
  const day = /\bagle\s+(somvar|mangalvar|budhvar|guruvar|shukravar|shanivar|ravivar)\b/i.exec(
    lower,
  );
  const dayName = day?.[1] ?? "";
  if (dayName && WEEKDAYS.includes(dayName)) weekday = dayName;
  return { quantity, unit, hour, minute, weekday, fillerStripped, corrected };
}
