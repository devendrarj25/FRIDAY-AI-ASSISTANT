/**
 * FRIDAY · Hindi / English inverse text normalisation for a finished transcript.
 *
 * Speech recognisers write what was said ("paanch sau rupaye", "two thousand twenty six", "saade teen baje",
 * "john at the rate gmail dot com"). This turns the spoken forms that are sure into the written ones (₹500,
 * 2026, 3:30 baje, john@gmail.com). Rule-based, pure, no model, no network, no clock.
 *
 * Script policy (language-segmenter.ts `scriptPolicy`): nothing is transliterated across scripts and nothing is
 * translated. "baje" stays "baje" and "बजे" stays "बजे"; a Devanagari number word becomes digits, which belong to
 * no script. Devanagari digits become ASCII digits (option `digits`).
 *
 * Conservative on purpose: a small number word alone ("do", "teen", "one", "two") is never rewritten, because it is
 * also an ordinary word ("do" is "give" in Hindi and "do" in English). A number is rewritten only when it is sure:
 *   · it holds a magnitude (hundred, thousand, sau, hazaar, lakh, crore) or an English or Devanagari word of 11 or up;
 *   · or a unit follows it (percent, rupees, dollars, baje, pm, o'clock, a month name), or "point" and digit words;
 *   · Roman Hindi number words of 11 or up need a Roman Hindi sentence around them ("bees" is also English).
 * Idempotent: its own output is left alone. Text over `ITN_MAX_CHARS` is returned as heard.
 */
import { scriptPolicy } from "./language-segmenter";
import { hindiNumber } from "./text-normalizer";

export const ITN_MAX_CHARS = 8000;

export type ItnKind =
  | "number"
  | "decimal"
  | "percent"
  | "currency"
  | "time"
  | "ordinal"
  | "year"
  | "phone"
  | "digits"
  | "email"
  | "url";
export type ItnChange = { kind: ItnKind; from: string; to: string };
export type ItnOptions = {
  /** `ascii` (default) turns Devanagari digits into 0-9; `keep` leaves them. */
  digits?: "ascii" | "keep";
};
export type ItnResult = { raw: string; text: string; changed: boolean; changes: ItnChange[] };

/* ------------------------------------------------------------------ tables */

/** Nukta and joiners dropped, chandrabindu folded: spellings of one Devanagari word compare equal. */
const fold = (s: string): string =>
  s.normalize("NFC").toLowerCase().replace(/[़‌‍]/g, "").replace(/ँ/g, "ं");
const set = (words: string): Set<string> => new Set(words.split(/\s+/).filter(Boolean).map(fold));

type Sys = "en" | "hi" | "rm" | "any";
type Kind = "ones" | "teen" | "tens" | "atom" | "hundred" | "scale";
type Entry = { sys: Sys; t: Kind; v: number; bare?: boolean };

const LEX = new Map<string, Entry>();
const DIGIT = new Map<string, { sys: Sys; v: number }>();
const put = (key: string, e: Entry): void => {
  const k = fold(key);
  if (!LEX.has(k)) LEX.set(k, e);
};

const EN_ONES = "one two three four five six seven eight nine".split(" ");
const EN_TEEN =
  "ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
const EN_TENS = "twenty thirty forty fifty sixty seventy eighty ninety".split(" ");
EN_ONES.forEach((w, i) => put(w, { sys: "en", t: "ones", v: i + 1 }));
EN_TEEN.forEach((w, i) => put(w, { sys: "en", t: "teen", v: 10 + i }));
EN_TENS.forEach((w, i) => put(w, { sys: "en", t: "tens", v: 20 + 10 * i }));
put("fourty", { sys: "en", t: "tens", v: 40 });
put("hundred", { sys: "en", t: "hundred", v: 100 });
put("thousand", { sys: "en", t: "scale", v: 1e3 });
put("million", { sys: "en", t: "scale", v: 1e6 });
put("billion", { sys: "en", t: "scale", v: 1e9 });
for (const w of ["lakh", "lakhs", "lac", "lacs"]) put(w, { sys: "any", t: "scale", v: 1e5 });
for (const w of ["crore", "crores"]) put(w, { sys: "any", t: "scale", v: 1e7 });

// Devanagari 1..99 come from the speech normaliser's own table, so the two never drift apart.
for (let n = 1; n < 100; n += 1) put(hindiNumber(n), { sys: "hi", t: "atom", v: n });
const HI_ALIASES: [string, number][] = [
  ["पन्द्रह", 15],
  ["उन्निस", 19],
  ["छः", 6],
  ["छे", 6],
  ["अठाईस", 28],
  ["अठावन", 58],
  ["अठहत्तर", 78],
  ["अठासी", 88],
  ["अठानवे", 98],
];
for (const [w, v] of HI_ALIASES) put(w, { sys: "hi", t: "atom", v });
put("सौ", { sys: "hi", t: "hundred", v: 100, bare: true });
put("हज़ार", { sys: "hi", t: "scale", v: 1e3, bare: true });
put("लाख", { sys: "hi", t: "scale", v: 1e5 });
put("करोड़", { sys: "hi", t: "scale", v: 1e7 });

/**
 * Roman Hindi 1..99, index = the number, `|` separates spellings. 60 is empty on purpose: "saath" is also "with".
 */
export const ROMAN_NUMBERS: readonly string[] = [
  "shunya",
  "ek",
  "do",
  "teen",
  "chaar|char",
  "paanch|panch",
  "chhe|chhah|chah",
  "saat",
  "aath|aat",
  "nau|nao",
  "das|dus",
  "gyarah|gyaarah",
  "barah|baarah",
  "terah",
  "chaudah",
  "pandrah",
  "solah",
  "satrah",
  "atharah",
  "unnis",
  "bees",
  "ikkis",
  "baees",
  "teis",
  "chaubis",
  "pachchis|pachees|pacchis",
  "chhabbis",
  "sattais",
  "atthais",
  "untis",
  "tees",
  "ikatis",
  "battis",
  "taintis",
  "chauntis",
  "paintis",
  "chhattis",
  "saintis",
  "adtis",
  "unchalis",
  "chalis|chaalis",
  "iktalis",
  "bayalis",
  "taitalis",
  "chavalis",
  "paintalis",
  "chhiyalis",
  "saintalis",
  "adtalis",
  "unchas",
  "pachas|pachaas",
  "ikyavan",
  "bavan",
  "tirpan",
  "chauvan",
  "pachpan",
  "chhappan",
  "sattavan",
  "atthavan",
  "unsath",
  "",
  "iksath",
  "basath",
  "tirsath",
  "chausath",
  "painsath",
  "chhiyasath",
  "sadsath",
  "adsath",
  "unhattar",
  "sattar",
  "ikhattar",
  "bahattar",
  "tihattar",
  "chauhattar",
  "pachhattar",
  "chhihattar",
  "satattar",
  "athattar",
  "unasi",
  "assi",
  "ikyasi",
  "bayasi",
  "tirasi",
  "chaurasi",
  "pachasi",
  "chhiyasi",
  "sattasi",
  "atthasi",
  "navasi",
  "nabbe",
  "ikyanave",
  "banave",
  "tiranave",
  "chauranave",
  "pachanave",
  "chhiyanave",
  "sattanave",
  "atthanave",
  "ninyanave",
];
ROMAN_NUMBERS.forEach((spellings, n) => {
  if (n === 0) return;
  for (const w of spellings.split("|")) if (w) put(w, { sys: "rm", t: "atom", v: n });
});
put("sau", { sys: "rm", t: "hundred", v: 100, bare: true });
for (const w of ["hazaar", "hajaar", "hazar", "hajar"]) {
  put(w, { sys: "rm", t: "scale", v: 1e3, bare: true });
}

DIGIT.set("zero", { sys: "en", v: 0 });
DIGIT.set("oh", { sys: "en", v: 0 });
DIGIT.set(fold("शून्य"), { sys: "hi", v: 0 });
DIGIT.set("shunya", { sys: "rm", v: 0 });
for (const [key, e] of LEX) {
  if (e.v >= 1 && e.v <= 9 && e.t !== "hundred") DIGIT.set(key, { sys: e.sys, v: e.v });
}
const MULTIPLY = new Map<string, number>([
  ["double", 2],
  ["triple", 3],
  [fold("डबल"), 2],
  [fold("ट्रिपल"), 3],
]);

const POINT = set("point दशमलव dashmlav dashamlav");
const SAADE = set("saade sade saadhe sadhe साढ़े साढे साड़े");
const SAVA = set("sava सवा");
const PAUNE = set("paune pone पौने");
const DEDH = set("dedh डेढ़ डेढ");
const DHAI = set("dhai dhaai ढाई");
const BAJE = set("baje बजे");
const PERCENT = set("percent प्रतिशत pratishat फ़ीसदी फीसदी परसेंट पर्सेंट");
const RUPEE = set("rupees rupee rupaye rupaya rupay rupaiye rupiya रुपये रुपए रुपया रुपयों रूपये");
const DOLLAR = set("dollars dollar डॉलर डालर");
const PAISE = set("paise paisa पैसे पैसा");
const CLOCK = set("am pm o'clock oclock");
const MONTHS = set(
  "january february march april may june july august september october november december " +
    "जनवरी फ़रवरी फरवरी मार्च अप्रैल मई जून जुलाई अगस्त सितंबर सितम्बर अक्टूबर नवंबर नवम्बर दिसंबर दिसम्बर",
);
const TARIKH = set("tarikh tareekh तारीख़ तारीख");
const ORD_EN = new Map<string, number>(
  Object.entries({
    first: 1,
    second: 2,
    third: 3,
    fourth: 4,
    fifth: 5,
    sixth: 6,
    seventh: 7,
    eighth: 8,
    ninth: 9,
    tenth: 10,
    eleventh: 11,
    twelfth: 12,
    thirteenth: 13,
    fourteenth: 14,
    fifteenth: 15,
    sixteenth: 16,
    seventeenth: 17,
    eighteenth: 18,
    nineteenth: 19,
    twentieth: 20,
    thirtieth: 30,
    fortieth: 40,
    fiftieth: 50,
  }),
);
const ORD_NOUN = set(
  "floor century anniversary birthday chapter edition grade row semester lane platform",
);
const ORD_HI = new Map<string, number>(
  Object.entries({
    पहली: 1,
    पहला: 1,
    pehli: 1,
    pehla: 1,
    pahli: 1,
    pahla: 1,
    दूसरी: 2,
    दूसरा: 2,
    doosri: 2,
    dusri: 2,
    doosra: 2,
    तीसरी: 3,
    तीसरा: 3,
    teesri: 3,
    teesra: 3,
    चौथी: 4,
    चौथा: 4,
    chauthi: 4,
    chautha: 4,
    पाँचवीं: 5,
    पांचवीं: 5,
    पाँचवी: 5,
    paanchvi: 5,
    panchvi: 5,
    छठी: 6,
    छठा: 6,
    chhathi: 6,
    सातवीं: 7,
    सातवी: 7,
    saatvi: 7,
    आठवीं: 8,
    आठवी: 8,
    aathvi: 8,
    नौवीं: 9,
    नौवी: 9,
    nauvi: 9,
    दसवीं: 10,
    दसवी: 10,
    dasvi: 10,
  }).map(([k, v]) => [fold(k), v] as [string, number]),
);
const URL_STOP = set(
  "the a an this that these those my your our his her its their any every each some no and or of to in on for with by at is it i we you",
);
const TLD = set("com in org net edu gov io co ai app dev me info uk us");

/* ------------------------------------------------------------------ tokens */

type Tok = { raw: string; key: string; start: number; end: number; num: boolean; prot: boolean };
const TOKEN = /\p{Nd}+(?:[.,]\p{Nd}+)*|[\p{L}\p{M}‌‍]+(?:['’][\p{L}]+)?/gu;
const LETTER = /[\p{L}\p{M}]/u;
const WORDISH = /[\p{L}\p{N}]/u;

function tokenise(text: string): Tok[] {
  const out: Tok[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const prev = text[start - 1] ?? "";
    const next = text[end] ?? "";
    const num = /^\p{Nd}/u.test(m[0]);
    // Part of an address, a path or an identifier: never read as a number word.
    const attached =
      /[@/\\_#]/.test(prev) ||
      /[@/\\_]/.test(next) ||
      (next === "." && WORDISH.test(text[end + 1] ?? "")) ||
      (prev === "." && WORDISH.test(text[start - 2] ?? "")) ||
      (num && (LETTER.test(prev) || LETTER.test(next)));
    out.push({ raw: m[0], key: fold(m[0]), start, end, num, prot: attached });
  }
  return out;
}

const toAscii = (s: string): string =>
  s.replace(/[०-९]/g, (d) => String((d.codePointAt(0) ?? 0x966) - 0x966));
const hasDevanagariDigit = (s: string): boolean => /[०-९]/.test(s);

/* ------------------------------------------------------------------ the scanner */

type Ctx = { src: string; toks: Tok[]; romanContext: boolean; asciiDigits: boolean };
type Match = { end: number; text: string; kind: ItnKind };

const entryAt = (c: Ctx, k: number): Entry | undefined => {
  const t = c.toks[k];
  return t && !t.prot && !t.num ? LEX.get(t.key) : undefined;
};
const keyAt = (c: Ctx, k: number): string => {
  const t = c.toks[k];
  return t && !t.prot ? t.key : "";
};
/** Two neighbouring tokens that read as one phrase: only spaces (or one hyphen) between them. */
const joined = (c: Ctx, a: number, b: number): boolean => {
  const x = c.toks[a];
  const y = c.toks[b];
  if (!x || !y) return false;
  return /^(?:[ \t\u00a0]+|-)$/.test(c.src.slice(x.end, y.start));
};
const spaced = (c: Ctx, a: number, b: number): boolean => {
  const x = c.toks[a];
  const y = c.toks[b];
  return !!x && !!y && /^[ \t\u00a0]+$/.test(c.src.slice(x.end, y.start));
};
/** A month name; "may" and "march" only when written with a capital (they are also ordinary English words). */
const isMonth = (c: Ctx, k: number): boolean => {
  const t = c.toks[k];
  if (!t || t.prot || !MONTHS.has(t.key)) return false;
  if ((t.key === "may" || t.key === "march") && !/^\p{Lu}/u.test(t.raw)) return false;
  return true;
};
const pad2 = (n: number): string => String(n).padStart(2, "0");

type Parsed = { end: number; value: number; sys: Sys | null; magnitude: boolean };

/** Read a number phrase of words starting at token `i` (one language system), or null. */
function parseNumber(c: Ctx, i: number): Parsed | null {
  let sys: Sys | null = null;
  let total = 0;
  let cur = 0;
  let last: "none" | "small" | "tens" | "hundred" | "scale" = "none";
  let lastScale = Infinity;
  let magnitude = false;
  let end = -1;
  let k = i;
  const fits = (e: Entry): boolean => {
    if (e.sys === "any") return sys !== "hi";
    return sys === null || sys === e.sys;
  };
  const a = keyAt(c, i);
  if (a === "a" || a === "an") {
    const next = entryAt(c, i + 1);
    if (next?.sys === "en" && (next.t === "hundred" || next.t === "scale") && joined(c, i, i + 1)) {
      cur = 1;
      sys = "en";
      last = "small";
      k = i + 1;
    }
  }
  for (; k < c.toks.length; k += 1) {
    if (k > i && !joined(c, k - 1, k)) break;
    if (keyAt(c, k) === "and" && sys === "en" && (last === "hundred" || last === "scale")) {
      const after = entryAt(c, k + 1);
      if (
        after &&
        after.sys === "en" &&
        after.t !== "hundred" &&
        after.t !== "scale" &&
        joined(c, k, k + 1)
      )
        continue;
      break;
    }
    const e = entryAt(c, k);
    if (!e || !fits(e)) break;
    const fresh = last === "none" || last === "hundred" || last === "scale";
    if (e.t === "ones" || e.t === "teen" || e.t === "tens" || e.t === "atom") {
      if (e.t === "ones" && last === "tens") {
        cur += e.v;
        last = "small";
      } else if (fresh) {
        cur += e.v;
        last = e.t === "tens" ? "tens" : "small";
      } else break;
    } else if (e.t === "hundred") {
      if ((last === "small" || last === "tens") && cur >= 1 && cur < 100) cur *= 100;
      else if (last === "none" && e.bare) cur = 100;
      else break;
      last = "hundred";
      magnitude = true;
    } else {
      const has = (last === "small" || last === "tens" || last === "hundred") && cur >= 1;
      if (!(has || (last === "none" && e.bare)) || e.v >= lastScale) break;
      total += (has ? cur : 1) * e.v;
      cur = 0;
      lastScale = e.v;
      last = "scale";
      magnitude = true;
    }
    if (sys === null && e.sys !== "any") sys = e.sys;
    end = k + 1;
  }
  if (end < 0) return null;
  const value = total + cur;
  return Number.isSafeInteger(value) ? { end, value, sys, magnitude } : null;
}

type Unit =
  { kind: "percent" | "rupee" | "dollar"; end: number } | { kind: "plain"; end: number } | null;

/** What follows a number: a unit that makes a small number sure. `end` is the first token after the unit. */
function unitAfter(c: Ctx, last: number): Unit {
  const k = last + 1;
  if (!spaced(c, last, k)) return null;
  const key = keyAt(c, k);
  if (!key) return null;
  if (PERCENT.has(key)) return { kind: "percent", end: k + 1 };
  if (key === "per" && keyAt(c, k + 1) === "cent" && joined(c, k, k + 1)) {
    return { kind: "percent", end: k + 2 };
  }
  if (RUPEE.has(key)) return { kind: "rupee", end: k + 1 };
  if (DOLLAR.has(key)) return { kind: "dollar", end: k + 1 };
  if (BAJE.has(key) || CLOCK.has(key) || isMonth(c, k)) return { kind: "plain", end: k + 1 };
  return null;
}

const symbol = { rupee: "₹", dollar: "$" } as const;

/** A whole number at `k` (digits or words), for paise and clock hours. */
function numberAt(c: Ctx, k: number): { end: number; value: number } | null {
  const t = c.toks[k];
  if (!t || t.prot) return null;
  if (t.num) {
    return /^\p{Nd}+$/u.test(t.raw) ? { end: k + 1, value: Number(toAscii(t.raw)) } : null;
  }
  const p = parseNumber(c, k);
  return p ? { end: p.end, value: p.value } : null;
}

function render(c: Ctx, p: { value: number; end: number }, unit: Unit): Match | null {
  const n = String(p.value);
  if (!unit) return { end: p.end, text: n, kind: "number" };
  if (unit.kind === "plain") return { end: p.end, text: n, kind: "number" };
  if (unit.kind === "percent") return { end: unit.end, text: `${n}%`, kind: "percent" };
  const sign = symbol[unit.kind];
  if (unit.kind === "rupee") {
    const paise = numberAt(c, unit.end);
    const unitKey = paise ? keyAt(c, paise.end) : "";
    if (
      paise &&
      paise.value < 100 &&
      PAISE.has(unitKey) &&
      spaced(c, unit.end - 1, unit.end) &&
      spaced(c, paise.end - 1, paise.end)
    ) {
      return { end: paise.end + 1, text: `${sign}${n}.${pad2(paise.value)}`, kind: "currency" };
    }
  }
  return { end: unit.end, text: `${sign}${n}`, kind: "currency" };
}

/** Hour 1..12 at token `k` (digits or one number word). */
function hourAt(c: Ctx, k: number): { h: number; end: number } | null {
  const t = c.toks[k];
  if (!t || t.prot) return null;
  if (t.num) {
    const h = /^\p{Nd}{1,2}$/u.test(t.raw) ? Number(toAscii(t.raw)) : 0;
    return h >= 1 && h <= 12 ? { h, end: k + 1 } : null;
  }
  const e = entryAt(c, k);
  if (!e || (e.t !== "ones" && e.t !== "teen" && e.t !== "atom") || e.v < 1 || e.v > 12)
    return null;
  return { h: e.v, end: k + 1 };
}

function clock(h: number, minutes: number): string {
  return `${h}:${pad2(minutes)}`;
}

function matchTime(c: Ctx, i: number): Match | null {
  const key = keyAt(c, i);
  if (!key) return null;
  const baje = (k: number): boolean => BAJE.has(keyAt(c, k)) && joined(c, k - 1, k);
  const shown = (k: number): string => c.toks[k]?.raw ?? "";
  if (DEDH.has(key) && baje(i + 1))
    return { end: i + 2, text: `1:30 ${shown(i + 1)}`, kind: "time" };
  if (DHAI.has(key) && baje(i + 1))
    return { end: i + 2, text: `2:30 ${shown(i + 1)}`, kind: "time" };
  if (SAADE.has(key) || SAVA.has(key) || PAUNE.has(key)) {
    const hour = joined(c, i, i + 1) ? hourAt(c, i + 1) : null;
    if (!hour || !baje(hour.end)) return null;
    const at = SAADE.has(key)
      ? clock(hour.h, 30)
      : SAVA.has(key)
        ? clock(hour.h, 15)
        : clock(hour.h === 1 ? 12 : hour.h - 1, 45);
    return { end: hour.end + 1, text: `${at} ${shown(hour.end)}`, kind: "time" };
  }
  // English clock talk: a quarter to five, quarter past five, half past three, ten past four.
  const q = key === "a" && keyAt(c, i + 1) === "quarter" && joined(c, i, i + 1) ? i + 1 : i;
  const qk = keyAt(c, q);
  const word = keyAt(c, q + 1);
  if (qk === "quarter" && (word === "to" || word === "past") && joined(c, q, q + 1)) {
    const hour = joined(c, q + 1, q + 2) ? hourAt(c, q + 2) : null;
    if (!hour) return null;
    const at = word === "past" ? clock(hour.h, 15) : clock(hour.h === 1 ? 12 : hour.h - 1, 45);
    return { end: hour.end, text: at, kind: "time" };
  }
  if (qk === "half" && word === "past" && joined(c, q, q + 1)) {
    const hour = joined(c, q + 1, q + 2) ? hourAt(c, q + 2) : null;
    return hour ? { end: hour.end, text: clock(hour.h, 30), kind: "time" } : null;
  }
  const minutes = entryAt(c, i)?.sys === "en" ? parseNumber(c, i) : null;
  if (minutes && [5, 10, 20, 25].includes(minutes.value) && keyAt(c, minutes.end) === "past") {
    const hour =
      joined(c, minutes.end - 1, minutes.end) && joined(c, minutes.end, minutes.end + 1)
        ? hourAt(c, minutes.end + 1)
        : null;
    if (hour) return { end: hour.end, text: clock(hour.h, minutes.value), kind: "time" };
  }
  return null;
}

/** Seven or more digit words in a row read as one number (a phone number), unless they just count up (one two three...). */
function matchDigitRun(c: Ctx, i: number): Match | null {
  const digits: number[] = [];
  let sys: Sys | null = null;
  let k = i;
  let times = 1;
  let end = i;
  for (; k < c.toks.length; k += 1) {
    if (k > i && !joined(c, k - 1, k)) break;
    const key = keyAt(c, k);
    const mult = MULTIPLY.get(key);
    if (mult !== undefined && times === 1) {
      times = mult;
      continue;
    }
    const d = key && !c.toks[k]?.num ? DIGIT.get(key) : undefined;
    if (!d || (sys !== null && d.sys !== sys)) break;
    sys = d.sys;
    for (let n = 0; n < times; n += 1) digits.push(d.v);
    times = 1;
    end = k + 1;
  }
  if (digits.length < 7 || end <= i) return null;
  const steps = digits.slice(1).map((d, n) => d - (digits[n] ?? 0));
  if (steps.every((s) => s === 1)) return null;
  return { end, text: digits.join(""), kind: "phone" };
}

/** "twenty twenty six", "nineteen ninety nine", "nineteen oh five". */
function matchYear(c: Ctx, i: number): Match | null {
  const key = keyAt(c, i);
  if ((key !== "nineteen" && key !== "twenty") || !joined(c, i, i + 1)) return null;
  const century = key === "nineteen" ? 19 : 20;
  let tail: { end: number; value: number } | null = null;
  if (keyAt(c, i + 1) === "oh") {
    const one = entryAt(c, i + 2);
    if (one?.t === "ones" && joined(c, i + 1, i + 2)) tail = { end: i + 3, value: one.v };
  } else {
    const first = entryAt(c, i + 1);
    const p = first && (first.t === "tens" || first.t === "teen") ? parseNumber(c, i + 1) : null;
    if (p && !p.magnitude && p.value >= 10 && p.value <= 99) tail = p;
  }
  if (!tail || unitAfter(c, tail.end - 1)) return null;
  return { end: tail.end, text: String(century * 100 + tail.value), kind: "year" };
}

const SUFFIX = ["th", "st", "nd", "rd"];
function ordinal(n: number): string {
  const tail = n % 100;
  const s = tail >= 11 && tail <= 13 ? "th" : (SUFFIX[n % 10 < 4 ? n % 10 : 0] ?? "th");
  return `${n}${s}`;
}

function matchOrdinal(c: Ctx, i: number): Match | null {
  const key = keyAt(c, i);
  if (!key) return null;
  const hindi = ORD_HI.get(key);
  if (hindi !== undefined) {
    return TARIKH.has(keyAt(c, i + 1)) && spaced(c, i, i + 1)
      ? { end: i + 1, text: String(hindi), kind: "ordinal" }
      : null;
  }
  // twenty first, twenty-first: always a date or a rank
  const tens = entryAt(c, i);
  if (tens?.t === "tens" && joined(c, i, i + 1)) {
    const unit = ORD_EN.get(keyAt(c, i + 1));
    if (unit !== undefined && unit < 10) {
      return { end: i + 2, text: ordinal(tens.v + unit), kind: "ordinal" };
    }
  }
  const n = ORD_EN.get(key);
  if (n === undefined) return null;
  const next = keyAt(c, i + 1);
  const monthNext = isMonth(c, i + 1) && spaced(c, i, i + 1);
  const monthOf =
    next === "of" && spaced(c, i, i + 1) && isMonth(c, i + 2) && spaced(c, i + 1, i + 2);
  const monthBefore = isMonth(c, i - 1) && spaced(c, i - 1, i);
  const noun = ORD_NOUN.has(next) && spaced(c, i, i + 1);
  return monthNext || monthOf || monthBefore || noun
    ? { end: i + 1, text: ordinal(n), kind: "ordinal" }
    : null;
}

/** dedh sau, dhai hazaar, sava lakh, saade teen sau, paune do sau. */
function matchFractionMagnitude(c: Ctx, i: number): Match | null {
  const key = keyAt(c, i);
  if (!key) return null;
  let factor: number;
  let at = i + 1;
  if (DEDH.has(key)) factor = 1.5;
  else if (DHAI.has(key)) factor = 2.5;
  else if (SAVA.has(key)) factor = 1.25;
  else if (SAADE.has(key) || PAUNE.has(key)) {
    const e = entryAt(c, i + 1);
    if (!e || e.t !== "atom" || !joined(c, i, i + 1)) return null;
    factor = SAADE.has(key) ? e.v + 0.5 : e.v - 0.25;
    at = i + 2;
  } else return null;
  const mag = entryAt(c, at);
  if (
    !mag ||
    (mag.t !== "hundred" && mag.t !== "scale") ||
    mag.sys === "en" ||
    !joined(c, at - 1, at)
  )
    return null;
  const value = factor * mag.v;
  if (!Number.isInteger(value)) return null;
  return render(c, { value, end: at + 1 }, unitAfter(c, at));
}

function matchNumber(c: Ctx, i: number): Match | null {
  const left = parseNumber(c, i);
  const zero =
    !left && DIGIT.get(keyAt(c, i))?.v === 0
      ? { end: i + 1, value: 0, sys: DIGIT.get(keyAt(c, i))?.sys ?? null }
      : null;
  const lead = left ?? zero;
  if (!lead) return null;
  // decimals: "two point five", "zero point five", "do dashmlav paanch"
  if (POINT.has(keyAt(c, lead.end)) && joined(c, lead.end - 1, lead.end)) {
    let k = lead.end + 1;
    let frac = "";
    while (k < c.toks.length && joined(c, k - 1, k)) {
      const d = c.toks[k]?.prot ? undefined : DIGIT.get(keyAt(c, k));
      if (!d || (lead.sys && lead.sys !== "any" && d.sys !== lead.sys && d.sys !== "any")) break;
      frac += String(d.v);
      k += 1;
    }
    if (frac && joined(c, lead.end, lead.end + 1)) {
      const value = `${lead.value}.${frac}`;
      const unit = unitAfter(c, k - 1);
      if (unit?.kind === "percent") return { end: unit.end, text: `${value}%`, kind: "percent" };
      return { end: k, text: value, kind: "decimal" };
    }
  }
  if (!left) return null;
  // "teen sau saath" is 360, but "saath" (60, also "with") is not read: a half-read number would be wrong.
  const after = keyAt(c, left.end);
  if (
    left.sys === "rm" &&
    (after === "saath" || after === "sath") &&
    joined(c, left.end - 1, left.end)
  ) {
    return null;
  }
  const unit = unitAfter(c, left.end - 1);
  const big = left.value >= 11;
  const sure =
    left.magnitude ||
    (left.sys === "en" && big) ||
    (left.sys === "hi" && big) ||
    (left.sys === "rm" && big && c.romanContext) ||
    unit !== null;
  if (!sure) return null;
  const match = render(c, { value: left.value, end: left.end }, unit);
  return match;
}

function matchNumeric(c: Ctx, i: number): Match | null {
  const t = c.toks[i];
  if (!t || !t.num || t.prot) return null;
  const ascii = c.asciiDigits ? toAscii(t.raw) : t.raw;
  const unit = unitAfter(c, i);
  if (unit && unit.kind !== "plain") {
    if (unit.kind === "percent") return { end: unit.end, text: `${ascii}%`, kind: "percent" };
    return { end: unit.end, text: `${symbol[unit.kind]}${ascii}`, kind: "currency" };
  }
  if (c.asciiDigits && hasDevanagariDigit(t.raw))
    return { end: i + 1, text: ascii, kind: "digits" };
  return null;
}

/* ------------------------------------------------------------ e-mail and addresses */

const AT = String.raw`(?:at[\s-]+the[\s-]+rate(?![\s-]+of\b)|एट\s+(?:द|दी)\s+रेट)`;
const DOT = String.raw`(?:dot|डॉट|डाट)`;
const LABEL = String.raw`[a-z0-9][a-z0-9-]*`;
const EMAIL = new RegExp(
  String.raw`(?<![\p{L}\p{N}@._-])(${LABEL}(?:\s+${DOT}\s+${LABEL})*)\s+${AT}\s+(${LABEL}(?:\s+${DOT}\s+${LABEL})+)(?![\p{L}\p{N}-])`,
  "giu",
);
const ADDRESS = new RegExp(
  String.raw`(?<![\p{L}\p{N}@._-])(${LABEL}(?:\s+${DOT}\s+${LABEL})+)(?![\p{L}\p{N}-])`,
  "giu",
);

const labels = (chain: string): string[] =>
  chain.split(new RegExp(String.raw`\s+${DOT}\s+`, "iu")).map((l) => l.toLowerCase());

function rewriteAddresses(text: string, changes: ItnChange[]): string {
  const email = text.replace(EMAIL, (whole: string, local: string, domain: string) => {
    const parts = labels(domain);
    if (!TLD.has(parts[parts.length - 1] ?? "")) return whole;
    const out = `${labels(local).join(".")}@${parts.join(".")}`;
    changes.push({ kind: "email", from: whole, to: out });
    return out;
  });
  return email.replace(ADDRESS, (whole: string, chain: string) => {
    const parts = labels(chain);
    if (!TLD.has(parts[parts.length - 1] ?? "") || URL_STOP.has(parts[0] ?? "")) return whole;
    const out = parts.join(".");
    changes.push({ kind: "url", from: whole, to: out });
    return out;
  });
}

/* ------------------------------------------------------------------ the entry point */

/**
 * Turn the sure spoken forms of a transcript into written ones. Returns the text unchanged (`changed: false`) when
 * nothing is sure. Never throws, never translates, never moves a word between scripts.
 */
export function applyHinglishItn(input: string, options: ItnOptions = {}): ItnResult {
  const raw = typeof input === "string" ? input : "";
  const same: ItnResult = { raw, text: raw, changed: false, changes: [] };
  if (!raw.trim() || raw.length > ITN_MAX_CHARS) return same;
  const changes: ItnChange[] = [];
  const src = rewriteAddresses(raw, changes);
  const ctx: Ctx = {
    src,
    toks: tokenise(src),
    romanContext: scriptPolicy(src).romanHindi,
    asciiDigits: options.digits !== "keep",
  };
  const edits: { from: number; to: number; text: string }[] = [];
  let i = 0;
  while (i < ctx.toks.length) {
    const t = ctx.toks[i];
    const match =
      t && !t.prot
        ? (matchTime(ctx, i) ??
          matchDigitRun(ctx, i) ??
          matchYear(ctx, i) ??
          matchOrdinal(ctx, i) ??
          matchFractionMagnitude(ctx, i) ??
          matchNumber(ctx, i) ??
          matchNumeric(ctx, i))
        : null;
    const last = match ? ctx.toks[match.end - 1] : undefined;
    if (!match || !t || !last || match.end <= i) {
      i += 1;
      continue;
    }
    const from = src.slice(t.start, last.end);
    if (from !== match.text) {
      edits.push({ from: t.start, to: last.end, text: match.text });
      changes.push({ kind: match.kind, from, to: match.text });
    }
    i = match.end;
  }
  let text = src;
  for (const e of edits.reverse()) text = text.slice(0, e.from) + e.text + text.slice(e.to);
  return { raw, text, changed: text !== raw, changes };
}

/** The value of a whole spoken number phrase ("do hazaar paanch sau", "two thousand five"), or null. For tests and tools. */
export function spokenNumberValue(phrase: string): number | null {
  const src = (phrase ?? "").trim();
  if (!src || src.length > 200) return null;
  const ctx: Ctx = { src, toks: tokenise(src), romanContext: false, asciiDigits: true };
  const p = parseNumber(ctx, 0);
  return p && p.end === ctx.toks.length ? p.value : null;
}
