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
import { dominantLang, segment, type SpeechLang } from "./language-segmenter";
import { keepForSpeech, maskDeliveryTags, stripDeliveryTags } from "./delivery-tags";
import { maskInlineCode, prepareSpeechText, type SpeechPrepOptions } from "./speech-prep";

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
const MONTHS_HI = "जनवरी फ़रवरी मार्च अप्रैल मई जून जुलाई अगस्त सितंबर अक्टूबर नवंबर दिसंबर".split(" ");
const DATE_MONTHS = [...MONTHS_HI, ...MONTHS_EN].join("|");

/** Hindi has one word for 0.5, 1.5 and 2.5. Anything else after the point is read digit by digit. */
const HI_HALVES: Record<number, string> = { 0: "आधा", 1: "डेढ़", 2: "ढाई" };

function number(text: string, lang: SpeechLang, plain = false): string {
  const clean = text.replace(/,/g, "");
  const [whole = "", frac] = clean.split(".");
  if (lang === "hi" && !plain && frac !== undefined && /^50*$/.test(frac)) {
    const half = HI_HALVES[Number(whole)];
    if (half) return half;
  }
  const spoken = say(Number(whole), lang);
  if (frac === undefined) return spoken;
  const point = lang === "hi" ? "दशमलव" : "point";
  return `${spoken} ${point} ${[...frac].map((d) => DIGIT_WORDS[lang][Number(d)]).join(" ")}`;
}

/** A year: English says it in pairs (twenty twenty six, nineteen oh five); Hindi says उन्नीस सौ for the 1900s. */
function sayYear(year: number, lang: SpeechLang): string {
  const century = Math.floor(year / 100);
  const rest = year % 100;
  if (lang === "hi") {
    if (year < 1100 || year >= 2000) return hindiNumber(year);
    return rest ? `${HI[century]} सौ ${HI[rest]}` : `${HI[century]} सौ`;
  }
  if (year >= 2000 && year < 2010) return englishNumber(year);
  if (year < 1100 || year >= 2100) return englishNumber(year);
  if (rest === 0) return `${enBelow100(century)} hundred`;
  return `${enBelow100(century)} ${rest < 10 ? `oh ${EN_ONES[rest]}` : enBelow100(rest)}`;
}

const isYear = (digits: string): boolean =>
  /^\d{4}$/.test(digits) && +digits >= 1100 && +digits <= 2099;

const EN_FRACTION_WORDS: Record<number, string> = {
  2: "half",
  3: "third",
  4: "quarter",
  5: "fifth",
  6: "sixth",
  7: "seventh",
  8: "eighth",
  9: "ninth",
  10: "tenth",
};

/** 1/2 आधा, 3/4 तीन चौथाई, 2/3 दो तिहाई, 5/8 पाँच बटा आठ; "" when it is not a fraction (a page count, a date). */
function fractionWords(top: number, bottom: number, lang: SpeechLang): string {
  if (bottom < 2 || bottom > 10 || top < 1 || top >= bottom) return "";
  if (lang === "hi") {
    if (bottom === 2) return "आधा";
    if (bottom === 3) return `${HI[top]} तिहाई`;
    if (bottom === 4) return `${HI[top]} चौथाई`;
    return `${HI[top]} बटा ${HI[bottom]}`;
  }
  const word = EN_FRACTION_WORDS[bottom] ?? "";
  return `${EN_ONES[top]} ${word}${top > 1 ? "s" : ""}`;
}

/** 1 1/2 डेढ़, 2 1/2 ढाई, 3 1/2 साढ़े तीन, 1 1/4 सवा एक, 2 3/4 पौने तीन; English "two and a half". */
function mixedFractionWords(whole: number, top: number, bottom: number, lang: SpeechLang): string {
  const key = `${top}/${bottom}`;
  if (key !== "1/2" && key !== "1/4" && key !== "3/4") return "";
  if (lang === "en") {
    const part = key === "1/2" ? "a half" : key === "1/4" ? "a quarter" : "three quarters";
    return `${englishNumber(whole)} and ${part}`;
  }
  if (key === "1/2") return whole === 1 ? "डेढ़" : whole === 2 ? "ढाई" : `साढ़े ${hindiNumber(whole)}`;
  return key === "1/4" ? `सवा ${hindiNumber(whole)}` : `पौने ${hindiNumber(whole + 1)}`;
}

const HI_ORDINAL_STEMS: Record<number, string> = {
  1: "पहल",
  2: "दूसर",
  3: "तीसर",
  4: "चौथ",
  6: "छठ",
};
const HI_ORDINAL_ENDINGS: Record<string, string> = { वाँ: "ा", वां: "ा", वीं: "ी", वें: "े" };
const EN_ORDINAL_WORDS: Record<string, string> = {
  one: "first",
  two: "second",
  three: "third",
  five: "fifth",
  eight: "eighth",
  nine: "ninth",
  twelve: "twelfth",
};

/** 21 becomes "twenty first"; 100 "one hundredth". From a thousand up the plain number is said. */
function englishOrdinal(n: number): string {
  const words = englishNumber(n).split(" ");
  const last = words.pop() ?? "";
  const ordinal =
    EN_ORDINAL_WORDS[last] ?? (last.endsWith("y") ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return [...words, ordinal].join(" ");
}

/** Hindi ordinals: पहला, दूसरा, तीसरा, चौथा, पाँचवाँ, छठा, then the number and वाँ. */
function hindiOrdinal(n: number, ending = "ा"): string {
  const stem = HI_ORDINAL_STEMS[n];
  if (stem) return `${stem}${ending}`;
  const suffix = ending === "ा" ? "वाँ" : ending === "ी" ? "वीं" : "वें";
  return `${hindiNumber(n)}${suffix}`;
}

const HI_PERIOD = (hour12: number, pm: boolean): string => {
  if (pm) return hour12 === 12 || hour12 <= 3 ? "दोपहर" : hour12 <= 7 ? "शाम" : "रात";
  return hour12 === 12 || hour12 <= 3 ? "रात" : "सुबह";
};

/** Hindi clock talk: सवा तीन, साढ़े तीन, पौने चार, तीन बजकर पाँच मिनट. `said` is true when "बजे" follows already. */
function hindiClock(hour: number, minute: number, period: "am" | "pm" | "", said: boolean): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const word = HI[h12] ?? "";
  const baje = said ? "" : " बजे";
  let body: string;
  if (minute === 0) body = `${word}${baje}`;
  else if (minute === 15) body = `सवा ${word}${baje}`;
  else if (minute === 30) body = `${h12 === 1 ? "डेढ़" : h12 === 2 ? "ढाई" : `साढ़े ${word}`}${baje}`;
  else if (minute === 45) body = `पौने ${HI[(h12 % 12) + 1] ?? ""}${baje}`;
  else body = said ? `${word} ${HI[minute] ?? ""}` : `${word} बजकर ${HI[minute] ?? ""} मिनट`;
  return period ? `${HI_PERIOD(h12, period === "pm")} ${body}` : body;
}

/** Ordinals: 1st, 22nd (Latin suffix), 5वाँ, 21वीं, 2री, 4थी (Devanagari suffix). */
export function spellOrdinals(text: string, lang: SpeechLang): string {
  // In a Hindi date the day is a plain number ("इक्कीस जनवरी"), the first is "पहली".
  let line =
    lang === "hi"
      ? text.replace(
          new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)(?=\\s+(?:${DATE_MONTHS}))`, "g"),
          (_m, day: string) => (Number(day) === 1 ? "पहली" : hindiNumber(Number(day))),
        )
      : text;
  line = line.replace(/\b(\d{1,3})(st|nd|rd|th)\b/g, (_m, n) =>
    lang === "hi" ? hindiOrdinal(Number(n)) : englishOrdinal(Number(n)),
  );
  line = line.replace(/(?<!\d)(\d{1,3})(वाँ|वां|वीं|वें)/g, (_m, n, suffix: string) =>
    HI_ORDINAL_STEMS[Number(n)] || lang === "hi"
      ? hindiOrdinal(Number(n), HI_ORDINAL_ENDINGS[suffix])
      : `${say(Number(n), lang)}${suffix}`,
  );
  return line.replace(/(?<!\d)([2346])(र[ाीे]|थ[ाीे]|ठ[ाीे])(?![ऀ-ॿ])/g, (m, n, suffix: string) => {
    const stem = { 2: "र", 3: "र", 4: "थ", 6: "ठ" }[Number(n) as 2 | 3 | 4 | 6];
    return suffix.startsWith(stem) ? hindiOrdinal(Number(n), suffix.slice(1)) : m;
  });
}

const MONEY_UNIT = /(lakhs?|lacs?|crores?|thousand|k|लाख|करोड़|हज़ार|हजार)(?![A-Za-z])/i;

function moneyUnit(unit: string, lang: SpeechLang): string {
  const u = unit.toLowerCase();
  if (u.startsWith("l") || unit === "लाख") return lang === "hi" ? "लाख" : "lakh";
  if (u.startsWith("c") || unit === "करोड़") return lang === "hi" ? "करोड़" : "crore";
  return lang === "hi" ? "हज़ार" : "thousand";
}

/** A number as written: digits with thousands commas inside (never one at the end), and a decimal part. */
const NUM = "\\d(?:[\\d,]*\\d)?(?:\\.\\d+)?";
/** am / pm as written: "am", "p.m.", or the Devanagari letters. A dotted form carries its own dots. */
const MERIDIEM = "a\\.m\\.|p\\.m\\.|am|pm|एएम|पीएम";
const CLOCK = "(?:[01]?\\d|2[0-3]):[0-5]\\d";
const TIME_PATTERN = new RegExp(
  `\\b([01]?\\d|2[0-3]):([0-5]\\d)(?:\\s*(${MERIDIEM})(?![A-Za-z]))?`,
  "gi",
);
const HOUR_PATTERN = new RegExp(
  `(?<![\\w:.,/₹$])(1[0-2]|0?[1-9])\\s*(${MERIDIEM})(?![A-Za-z])`,
  "gi",
);
const TIME_RANGE = new RegExp(
  `\\b(${CLOCK}(?:\\s*(?:${MERIDIEM}))?)\\s*[-–—]\\s*(?=${CLOCK})`,
  "gi",
);
const RANGE = new RegExp(
  `(?<![\\w.,/:+₹$-])(${NUM})(%?)(?:-|\\s*[–—]\\s*)(${NUM})(\\s*%)?(?![\\d/:-]|[.,]\\d)`,
  "g",
);
const YEAR = /(?<![\w,.:/₹$-])(?:1[1-9]|20)\d\d(?![\w%]|[,.:/-]\d)/g;
const YEAR_WORDS = "in|since|year|until|till|during|before|after|from|circa|सन|साल|वर्ष|ईसवी";
const MONTH_WORDS = `${MONTHS_EN.join("|")}|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec|${MONTHS_HI.join("|")}`;
/** What may stand just before a year: "in", "since", a month (with a day), or an earlier year ("1999 to"). */
const YEAR_CONTEXT = new RegExp(
  `(?:(?<![A-Za-zऀ-ॿ])(?:${YEAR_WORDS})\\s+|(?<![A-Za-zऀ-ॿ])(?:${MONTH_WORDS})\\.?\\s+(?:\\d{1,2}(?:st|nd|rd|th)?,?\\s+)?|\\b(?:1[1-9]|20)\\d\\d\\s+(?:to|and|से)\\s+)$`,
  "i",
);
const PAGE_WORDS =
  /(?:page|pages|slide|step|question|chapter|item|no|q|पेज|स्लाइड|चरण|प्रश्न)\s*\.?\s*$/i;
const VERSION_WORDS = /(?:\bv|version|ver|python|node|android|ios|windows|वर्ज़न)\s*\.?\s*$/i;

const digitsOf = (text: string, lang: SpeechLang): string =>
  [...text].map((d) => DIGIT_WORDS[lang][Number(d)]).join(" ");

/** Numbers, money, dates, times and percentages in one span, in that span's language. */
export function spellNumbers(span: string, lang: SpeechLang): string {
  const rupees = lang === "hi" ? "रुपये" : "rupees";
  const rupee = (amount: string): string =>
    Number(amount.replace(/,/g, "")) === 1 ? (lang === "hi" ? "रुपया" : "rupee") : rupees;
  const paise = lang === "hi" ? "पैसे" : "paise";
  const paisa = (count: number): string =>
    count === 1 ? (lang === "hi" ? "पैसा" : "paisa") : paise;
  const percent = lang === "hi" ? "प्रतिशत" : "percent";
  const to = lang === "hi" ? "से" : "to";
  const months = lang === "hi" ? MONTHS_HI : MONTHS_EN;
  const year = (digits: string): string =>
    lang === "hi" ? sayYear(Number(digits), "hi") : say(Number(digits), lang);
  // Supertonic rejects Devanagari digits: they become ordinary digits first.
  let line = span.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966));
  // Dates: 2026-01-25 (year first), 25/01/2026 or 25-01-2026 (day first, as written in India).
  line = line.replace(
    /\b(\d{4})-(0?[1-9]|1[0-2])-(0?[1-9]|[12]\d|3[01])\b/g,
    (_m, y, mo, d) => `${say(Number(d), lang)} ${months[Number(mo) - 1] ?? ""} ${year(y)}`,
  );
  line = line.replace(
    /\b(0?[1-9]|[12]\d|3[01])[/-](0?[1-9]|1[0-2])[/-](\d{4})\b/g,
    (_m, d, mo, y) => `${say(Number(d), lang)} ${months[Number(mo) - 1] ?? ""} ${year(y)}`,
  );
  // Times: 5:30 pm, 5 p.m., 17:05. Hindi says सवा, साढ़े, पौने; a "बजे" that follows is not said twice. A range
  // of times joins with "से" or "to". A dotted "p.m." that ends the sentence keeps its dot.
  line = line.replace(TIME_RANGE, (_m, first: string) => `${first} ${to} `);
  const clock = (
    hour: number,
    minute: number,
    meridiem: string,
    match: string,
    offset: number,
    whole: string,
  ) => {
    const rest = whole.slice(offset + match.length);
    const mer = meridiem ? (/^(a|ए)/i.test(meridiem) ? "am" : "pm") : "";
    const dot = meridiem.endsWith(".") && /^\s*$|^\s+[ऀ-ॿA-Z]/.test(rest) ? "." : "";
    if (lang === "hi") {
      return `${hindiClock(hour, minute, mer as "am" | "pm" | "", /^\s*बजे/.test(rest))}${dot}`;
    }
    const suffix = mer ? ` ${mer === "am" ? "A M" : "P M"}` : "";
    return `${say(hour, lang)} ${minute === 0 ? "o'clock" : say(minute, lang)}${suffix}${dot}`;
  };
  line = line.replace(TIME_PATTERN, (match, h, mi, ap = "", offset: number, whole: string) =>
    clock(Number(h), Number(mi), String(ap), match, offset, whole),
  );
  line = line.replace(HOUR_PATTERN, (match, h, ap, offset: number, whole: string) => {
    if (lang === "hi") return clock(Number(h), 0, String(ap), match, offset, whole);
    const dot =
      String(ap).endsWith(".") && /^\s*$|^\s+[A-Z]/.test(whole.slice(offset + match.length))
        ? "."
        : "";
    return `${say(Number(h), lang)} ${/^a/i.test(String(ap)) ? "A M" : "P M"}${dot}`;
  });
  // A year after "in", "since", a month or "year" is said as a year. A bare number is never guessed to be one.
  line = line.replace(YEAR, (match: string, offset: number, whole: string) =>
    YEAR_CONTEXT.test(whole.slice(Math.max(0, offset - 40), offset))
      ? sayYear(Number(match), lang)
      : match,
  );
  line = spellOrdinals(line, lang);
  // A mobile number with a country code, then two groups of five digits with or without +91: digit by digit.
  line = line.replace(
    /(?<![\w+])\+(\d{1,3})[\s-]?([6-9]\d{9})(?!\d)/g,
    (_m, cc: string, digits: string) =>
      `${lang === "hi" ? "प्लस" : "plus"} ${digitsOf(cc, lang)} ${digitsOf(digits, lang)}`,
  );
  line = line.replace(
    /(\+\d{1,3}[\s-]?)?\b(\d{5})[\s-](\d{5})\b/g,
    (_m, cc: string | undefined, a: string, b: string) =>
      [
        ...(cc ? [lang === "hi" ? "प्लस" : "plus", digitsOf(cc.replace(/\D/g, ""), lang)] : []),
        digitsOf(a + b, lang),
      ].join(" "),
  );
  // 24x7 and 24/7, and sizes such as 1920x1080 (a leading zero is hex, not a size).
  line = line.replace(/(?<![\w.])24\s*[x×/]\s*7(?![\w/])/g, () =>
    lang === "hi" ? "चौबीस बाई सात" : "twenty four seven",
  );
  line = line.replace(
    /(?<![\w.])([1-9]\d{0,3})[x×]([1-9]\d{0,3})(?![\w.])/g,
    (_m, a: string, b: string) =>
      `${say(Number(a), lang)} ${lang === "hi" ? "बाई" : "by"} ${say(Number(b), lang)}`,
  );
  // A range: 5-10, 1,000–2,000, 2020-2026, 5-10%. A hyphen with spaces around it stays a minus ("5 - 3").
  line = line.replace(RANGE, (_m, a: string, pa: string, b: string, pb: string | undefined) => {
    const years = isYear(a) && isYear(b);
    const first = years ? sayYear(Number(a), lang) : number(a, lang, true);
    const second = years ? sayYear(Number(b), lang) : number(b, lang, true);
    return `${first}${pa ? ` ${percent}` : ""} ${to} ${second}${pb ? ` ${percent}` : ""}`;
  });
  // Fractions: 1 1/2 (डेढ़), 2 3/4 (पौने तीन), 3/4 (तीन चौथाई). "page 1/5" is a page, not a fraction.
  line = line.replace(
    /(?<![\d/.,])(\d{1,2})\s+([13])\/([24])(?![\d/])/g,
    (match, whole: string, top: string, bottom: string) =>
      mixedFractionWords(Number(whole), Number(top), Number(bottom), lang) || match,
  );
  line = line.replace(
    /(?<![\w.,/-])(\d{1,2})\/(\d{1,2})(?![\w/])/g,
    (match, top: string, bottom: string, offset: number, whole: string) =>
      PAGE_WORDS.test(whole.slice(Math.max(0, offset - 12), offset))
        ? match
        : fractionWords(Number(top), Number(bottom), lang) || match,
  );
  // A minus sign before a number or an amount.
  line = line.replace(
    /(^|[\s([{])[-−–](?=[\d₹$])/g,
    (_m, lead) => `${lead}${lang === "hi" ? "माइनस" : "minus"} `,
  );
  line = line.replace(
    /(^|[\s([{])\+(?=\d)/g,
    (_m, lead) => `${lead}${lang === "hi" ? "प्लस" : "plus"} `,
  );
  // Money with a unit word (₹5 lakh), then rupees and paise (₹99.50, ₹99.5), then plain money before or after the number.
  line = line.replace(
    new RegExp(`(?:₹|Rs\\.?|INR)\\s*(\\d[\\d,]*(?:\\.\\d+)?)\\s*${MONEY_UNIT.source}`, "gi"),
    (_m, n, unit) => `${number(n, lang)} ${moneyUnit(unit, lang)} ${rupees}`,
  );
  line = line.replace(
    /(?:₹|Rs\.?|INR)\s*(\d[\d,]*)\.(\d{1,2})(?!\d)/gi,
    (_m, n: string, p: string) => {
      const paiseCount = p.length === 1 ? Number(p) * 10 : Number(p);
      if (paiseCount === 0) return `${number(n, lang)} ${rupee(n)}`;
      if (Number(n.replace(/,/g, "")) === 0) return `${say(paiseCount, lang)} ${paisa(paiseCount)}`;
      return `${number(n, lang)} ${rupee(n)} ${say(paiseCount, lang)} ${paisa(paiseCount)}`;
    },
  );
  line = line.replace(
    /(?:₹|Rs\.?|INR)\s*(\d[\d,]*(?:\.\d+)?)/gi,
    (_m, n: string) => `${number(n, lang)} ${rupee(n)}`,
  );
  line = line.replace(
    /(?<![\d,.])(\d[\d,]*(?:\.\d+)?)\s*(?:₹|rs\b\.?|INR\b)/gi,
    (_m, n: string) => `${number(n, lang)} ${rupee(n)}`,
  );
  line = line.replace(
    /\$\s*(\d[\d,]*(?:\.\d+)?)/g,
    (_m, n) => `${number(n, lang)} ${lang === "hi" ? "डॉलर" : "dollars"}`,
  );
  line = line.replace(
    /(?<![\d,.])(\d[\d,]*(?:\.\d+)?)\s*%/g,
    (_m, n) => `${number(n, lang)} ${percent}`,
  );
  // Everything left that is a number. A phone-length digit string is said digit by digit; a version keeps its point.
  line = line.replace(/\b\d[\d,]*(?:\.\d+)?\b/g, (n: string, offset: number, whole: string) => {
    const digits = n.replace(/,/g, "");
    if (lang === "hi" && /^\d{10,13}$/.test(n)) return digitsOf(n, "hi");
    if (/^[6-9]\d{9}$/.test(n)) return digitsOf(n, lang);
    if (digits.length > 9) return n;
    return number(n, lang, VERSION_WORDS.test(whole.slice(Math.max(0, offset - 12), offset)));
  });
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
    .replace(
      /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u{FE0F}|\u{200D}|\u{20E3}|[☀-➿←-⇿⬀-⯿]/gu,
      "",
    )
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** Ordinals with a Latin suffix are said before the text is cut into spans, in the language of their sentence. */
function ordinalsBySentence(text: string): string {
  return text
    .split(/(?<=[.!?।॥])(\s+)/)
    .map((piece, i) =>
      i % 2 === 1 || !/\d(?:st|nd|rd|th)\b/.test(piece)
        ? piece
        : spellOrdinals(piece, dominantLang(piece)),
    )
    .join("");
}

/**
 * The whole preparation for one reply: markup out, dictionary words replaced, Speech Prep (English words and Roman
 * Hindi in Devanagari, see `speech-prep.ts`), then numbers spelled span by span in each span's language. Newlines
 * become sentence breaks so a list is read as separate sentences. Speech Prep runs only when asked for. Delivery tags
 * survive only with `prep.deliveryTags` (the assistant's own voice-mode reply); otherwise they are removed.
 */
export function prepareForSpeech(
  text: string,
  overrides: Record<string, string> = {},
  prep?: SpeechPrepOptions,
): string {
  // Delivery tags: the assistant's own voice-mode reply keeps its allow-listed tags (hidden from every step below
  // and put back at the end); any other text loses them so they are never read aloud or steer the voice.
  const tags = prep?.deliveryTags ? maskDeliveryTags(keepForSpeech(text)) : null;
  const source = tags ? tags.text : stripDeliveryTags(text);
  const masked = prep?.enabled === false || !prep ? null : maskInlineCode(source);
  const cleaned = applyPronunciations(stripMarkup(masked ? masked.text : source), overrides)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (/[.!?।:]$/.test(line) ? line : `${line}.`))
    .join(" ");
  const prepared = ordinalsBySentence(prep ? prepareSpeechText(cleaned, prep) : cleaned);
  const spoken = segment(prepared)
    .map((span) => spellNumbers(span.text, span.lang))
    .join(" ")
    .replace(/\s+([.,!?।])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  const restored = masked ? masked.restore(spoken) : spoken;
  return tags ? tags.restore(restored) : restored;
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
