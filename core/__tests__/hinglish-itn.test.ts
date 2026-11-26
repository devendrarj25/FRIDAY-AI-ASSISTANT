import { describe, expect, it } from "vitest";
import {
  applyHinglishItn,
  ITN_MAX_CHARS,
  ROMAN_NUMBERS,
  spokenNumberValue,
} from "../../src/lib/friday/voice-engine/hinglish-itn";

const itn = (text: string): string => applyHinglishItn(text).text;

/** [heard, written] */
type Row = [string, string];

const ENGLISH_NUMBERS: Row[] = [
  ["twenty five", "25"],
  ["I have twenty five apples", "I have 25 apples"],
  ["twenty-five", "25"],
  ["two thousand", "2000"],
  ["two thousand twenty six", "2026"],
  ["one hundred and five", "105"],
  ["one hundred five", "105"],
  ["a hundred", "100"],
  ["a thousand", "1000"],
  ["five hundred", "500"],
  ["three hundred thousand", "300000"],
  ["one million two hundred thousand", "1200000"],
  ["twenty five thousand six hundred and four", "25604"],
  ["five lakh", "500000"],
  ["two crore", "20000000"],
  ["three lakh fifty thousand", "350000"],
  ["eleven", "11"],
  ["nineteen", "19"],
  ["ninety nine", "99"],
  ["forty two people", "42 people"],
  ["thirty", "30"],
  ["one billion", "1000000000"],
  ["a hundred and twenty", "120"],
  ["Call me in twenty minutes", "Call me in 20 minutes"],
  ["twenty, thirty", "20, 30"],
  ["forty five", "45"],
  ["sixty seven percent", "67%"],
  ["eighty", "80"],
  ["two hundred fifty", "250"],
  ["nine hundred ninety nine", "999"],
  ["one thousand one hundred", "1100"],
  ["ten lakh", "1000000"],
  ["twelve crore", "120000000"],
  ["fifteen", "15"],
  ["sixteen candles", "16 candles"],
];

const ENGLISH_UNITS: Row[] = [
  ["fifty percent", "50%"],
  ["ten percent", "10%"],
  ["one percent", "1%"],
  ["five per cent", "5%"],
  ["100 percent", "100%"],
  ["2.5 percent", "2.5%"],
  ["two point five percent", "2.5%"],
  ["twenty five percent off", "25% off"],
  ["five rupees", "₹5"],
  ["five thousand rupees", "₹5000"],
  ["three dollars", "$3"],
  ["eleven pm", "11 pm"],
  ["two am", "2 am"],
  ["twelve o'clock", "12 o'clock"],
  ["500 rupees", "₹500"],
  ["1,000 rupees", "₹1,000"],
  ["five hundred rupees", "₹500"],
  ["ten dollars", "$10"],
  ["20 dollars", "$20"],
  ["five rupees fifty paise", "₹5.50"],
  ["two rupees five paise", "₹2.05"],
  ["three pm", "3 pm"],
  ["meet at five pm", "meet at 5 pm"],
  ["five o'clock", "5 o'clock"],
  ["two point five", "2.5"],
  ["zero point five", "0.5"],
  ["three point one four", "3.14"],
  ["twenty first of January", "21st of January"],
  ["five January", "5 January"],
  ["two thousand rupees only", "₹2000 only"],
  ["transfer five hundred rupees to Rahul", "transfer ₹500 to Rahul"],
];

const ENGLISH_TIME: Row[] = [
  ["quarter to five", "4:45"],
  ["a quarter to five", "4:45"],
  ["quarter past five", "5:15"],
  ["half past three", "3:30"],
  ["ten past four", "4:10"],
  ["twenty five past six", "6:25"],
  ["five past two", "2:05"],
  ["quarter to one", "12:45"],
  ["quarter to 5", "4:45"],
  ["half past 12", "12:30"],
  ["meet me at half past three please", "meet me at 3:30 please"],
];

const ENGLISH_ORDINALS_YEARS: Row[] = [
  ["first of January", "1st of January"],
  ["January first", "January 1st"],
  ["the fifth of March", "the 5th of March"],
  ["twelfth of May", "12th of May"],
  ["third floor", "3rd floor"],
  ["eleventh floor", "11th floor"],
  ["twenty first", "21st"],
  ["twenty-first century", "21st century"],
  ["twenty second", "22nd"],
  ["twenty third", "23rd"],
  ["thirty first of December", "31st of December"],
  ["nineteen ninety nine", "1999"],
  ["twenty twenty six", "2026"],
  ["in twenty twenty", "in 2020"],
  ["nineteen oh five", "1905"],
  ["twenty ten", "2010"],
];

const PHONE: Row[] = [
  ["nine eight seven six five four three two one zero", "9876543210"],
  ["nine eight double seven six five four", "9877654"],
  ["triple nine eight seven six five four", "99987654"],
  ["call nine eight seven six five four three two one zero now", "call 9876543210 now"],
  ["nau aath saat chhe paanch teen do ek", "98765321"],
  ["नौ आठ सात छह पाँच चार तीन दो एक", "987654321"],
  ["double नौ आठ सात छह पाँच चार", "9987654"],
];

const DEVANAGARI_NUMBERS: Row[] = [
  ["पाँच सौ", "500"],
  ["पांच सौ", "500"],
  ["दो हज़ार", "2000"],
  ["दो हजार", "2000"],
  ["तीन लाख", "300000"],
  ["एक करोड़", "10000000"],
  ["पचास", "50"],
  ["सत्तर", "70"],
  ["नब्बे प्रतिशत", "90%"],
  ["छह सौ", "600"],
  ["आठ हज़ार", "8000"],
  ["सात लाख पचास हज़ार", "750000"],
  ["चौबीस घंटे", "24 घंटे"],
  ["तीन सौ रुपये", "₹300"],
  ["बीस रुपये", "₹20"],
  ["सौ", "100"],
  ["दो हज़ार बीस", "2020"],
  ["दो सौ पचास", "250"],
  ["पाँच हज़ार पाँच सौ पचपन", "5555"],
  ["ग्यारह", "11"],
  ["बारह लोग", "12 लोग"],
  ["आज temperature पच्चीस degree है", "आज temperature 25 degree है"],
  ["डेढ़ सौ", "150"],
  ["ढाई हज़ार", "2500"],
  ["सवा लाख", "125000"],
  ["साढ़े तीन सौ", "350"],
  ["पौने दो सौ", "175"],
  ["डेढ़ लाख", "150000"],
  ["दो दशमलव पाँच", "2.5"],
  ["मेरे पास पचास रुपये हैं", "मेरे पास ₹50 हैं"],
  ["पाँच रुपये", "₹5"],
  ["सौ रुपये", "₹100"],
  ["पाँच रुपये पचास पैसे", "₹5.50"],
  ["दस प्रतिशत", "10%"],
  ["पचास प्रतिशत", "50%"],
  ["Chrome खोलो और पाँच सौ रुपये भेजो", "Chrome खोलो और ₹500 भेजो"],
  ["पंद्रह अगस्त", "15 अगस्त"],
  ["दो अक्टूबर", "2 अक्टूबर"],
  ["पहली तारीख़", "1 तारीख़"],
  ["तीसरी तारीख", "3 तारीख"],
];

const DEVANAGARI_TIME: Row[] = [
  ["तीन बजे", "3 बजे"],
  ["आठ बजे", "8 बजे"],
  ["दो बजे", "2 बजे"],
  ["साढ़े आठ बजे", "8:30 बजे"],
  ["सवा बारह बजे", "12:15 बजे"],
  ["साढ़े तीन बजे", "3:30 बजे"],
  ["सवा चार बजे", "4:15 बजे"],
  ["पौने पाँच बजे", "4:45 बजे"],
  ["डेढ़ बजे", "1:30 बजे"],
  ["ढाई बजे", "2:30 बजे"],
  ["पौने एक बजे", "12:45 बजे"],
  ["साढ़े बारह बजे", "12:30 बजे"],
  ["सुबह साढ़े सात बजे उठना है", "सुबह 7:30 बजे उठना है"],
  ["साढे तीन बजे", "3:30 बजे"],
];

const DEVANAGARI_DIGITS: Row[] = [
  ["१२३", "123"],
  ["५०%", "50%"],
  ["५० प्रतिशत", "50%"],
  ["संख्या ०.५ है", "संख्या 0.5 है"],
  ["१,००० रुपये", "₹1,000"],
  ["कमरा नंबर १०१ में", "कमरा नंबर 101 में"],
  ["१२ बजे", "12 बजे"],
];

const ROMAN_HINDI: Row[] = [
  ["paanch sau rupaye", "₹500"],
  ["char sau", "400"],
  ["aath hazaar", "8000"],
  ["das lakh", "1000000"],
  ["paanch percent", "5%"],
  ["do rupaye", "₹2"],
  ["saade aath baje", "8:30 baje"],
  ["sava ek baje", "1:15 baje"],
  ["do hazaar", "2000"],
  ["teen lakh", "300000"],
  ["ek crore", "10000000"],
  ["do sau pachas", "250"],
  ["pachas rupaye", "₹50"],
  ["pachas percent", "50%"],
  ["dedh sau", "150"],
  ["dhai hazaar", "2500"],
  ["sava lakh", "125000"],
  ["saade teen sau", "350"],
  ["paune do sau", "175"],
  ["do point paanch", "2.5"],
  ["mere saath sau rupaye lao", "mere saath ₹100 lao"],
  ["tum bees saal ke ho", "tum 20 saal ke ho"],
  ["ek baje", "1 baje"],
  ["do baje", "2 baje"],
  ["teen baje", "3 baje"],
  ["saade teen baje", "3:30 baje"],
  ["sava chaar baje", "4:15 baje"],
  ["paune paanch baje", "4:45 baje"],
  ["dedh baje", "1:30 baje"],
  ["dhai baje", "2:30 baje"],
  ["kal saade aath baje milte hain", "kal 8:30 baje milte hain"],
  ["pandrah august", "15 august"],
  ["pehli tarikh", "1 tarikh"],
  ["pachees hazaar rupaye", "₹25000"],
];

const ADDRESSES: Row[] = [
  ["john at the rate gmail dot com", "john@gmail.com"],
  ["John at the rate Gmail dot com", "john@gmail.com"],
  ["john dot smith at the rate example dot co dot in", "john.smith@example.co.in"],
  ["contact support at the rate gmail dot com please", "contact support@gmail.com please"],
  ["visit example dot com", "visit example.com"],
  ["www dot example dot com", "www.example.com"],
  ["john एट द रेट gmail डॉट com", "john@gmail.com"],
  ["mail ravi at the rate outlook dot com", "mail ravi@outlook.com"],
];

const UNCHANGED: string[] = [
  "जॉन एट द रेट जीमेल डॉट कॉम",
  "",
  "   ",
  "hello world",
  "do",
  "ek",
  "दो",
  "मुझे दो",
  "तीन चार",
  "दस",
  "सात",
  "दो बार कहा",
  "do ek",
  "main do kaam karunga",
  "teen log aaye",
  "mujhe do chahiye",
  "I have two options",
  "one of them",
  "ten",
  "five six seven",
  "one two three",
  "one two three four five six seven",
  "the main thing is to do it",
  "the bees are buzzing",
  "bees",
  "I sat down",
  "फ़ाइल खोलो",
  "मेरा नाम राहुल है",
  "meet me at the rate of two",
  "at the rate of ten, ok",
  "the dot com bubble",
  "at first I said no",
  "this is the first time",
  "the fifth of march",
  "hundred percent",
  "लाख बार",
  "john@twenty.com stays",
  "v2.0 release",
  "file_twenty five",
  "saath saath",
  "teen sau saath rupaye",
  "mere saath do log hain",
  "a lot of people",
  "1 2 3",
  "3:30 baje",
  "₹500",
  "50%",
  "john@gmail.com",
  "21st of January",
  "9876543210",
  "2026",
  "ok.",
];

const ALL_TABLES: Row[] = [
  ...ENGLISH_NUMBERS,
  ...ENGLISH_UNITS,
  ...ENGLISH_TIME,
  ...ENGLISH_ORDINALS_YEARS,
  ...PHONE,
  ...DEVANAGARI_NUMBERS,
  ...DEVANAGARI_TIME,
  ...DEVANAGARI_DIGITS,
  ...ROMAN_HINDI,
  ...ADDRESSES,
];

describe("hinglish ITN: written forms", () => {
  describe.each<[string, Row[]]>([
    ["English numbers", ENGLISH_NUMBERS],
    ["English units", ENGLISH_UNITS],
    ["English clock talk", ENGLISH_TIME],
    ["English ordinals and years", ENGLISH_ORDINALS_YEARS],
    ["phone numbers", PHONE],
    ["Devanagari numbers", DEVANAGARI_NUMBERS],
    ["Devanagari time", DEVANAGARI_TIME],
    ["Devanagari digits", DEVANAGARI_DIGITS],
    ["Roman Hindi", ROMAN_HINDI],
    ["e-mail and web addresses", ADDRESSES],
  ])("%s", (_name, rows) => {
    it.each(rows)("%s -> %s", (heard, written) => {
      expect(itn(heard)).toBe(written);
    });
  });

  it("has a large table", () => {
    expect(ALL_TABLES.length + UNCHANGED.length).toBeGreaterThanOrEqual(250);
  });
});

describe("hinglish ITN: conservative (when unsure, nothing changes)", () => {
  it.each(UNCHANGED)("leaves %j alone", (text) => {
    const out = applyHinglishItn(text);
    expect(out.text).toBe(text);
    expect(out.changed).toBe(false);
    expect(out.changes).toEqual([]);
  });

  it("does not rewrite a Roman Hindi number of 11 or more outside a Roman Hindi sentence", () => {
    expect(itn("bees")).toBe("bees");
    expect(itn("the bees and the wasps")).toBe("the bees and the wasps");
    expect(itn("tum bees saal ke ho")).toBe("tum 20 saal ke ho");
  });

  it("never reads a number word inside an address, a path or an identifier", () => {
    expect(itn("mail john@twenty.com now")).toBe("mail john@twenty.com now");
    expect(itn("open C:\\twenty\\five.txt")).toBe("open C:\\twenty\\five.txt");
    expect(itn("https://example.com/twenty/five")).toBe("https://example.com/twenty/five");
  });

  it("returns text over the size limit exactly as heard", () => {
    const long = `twenty five ${"word ".repeat(ITN_MAX_CHARS)}`;
    expect(itn(long)).toBe(long);
  });

  it("handles empty and non-string input", () => {
    expect(applyHinglishItn("").changed).toBe(false);
    expect(applyHinglishItn(undefined as unknown as string).text).toBe("");
  });
});

describe("hinglish ITN: script policy", () => {
  it("keeps Devanagari words in Devanagari and English words in Latin around the digits", () => {
    expect(itn("मुझे पाँच सौ रुपये का report चाहिए")).toBe("मुझे ₹500 का report चाहिए");
    expect(itn("open the file पचास बार")).toBe("open the file 50 बार");
  });

  it("never transliterates and never translates: no letter appears that was not heard", () => {
    const letters = (s: string): Set<string> => new Set(s.toLowerCase().match(/[\p{L}\p{M}]/gu));
    for (const [heard] of ALL_TABLES) {
      const out = itn(heard);
      const heardLetters = letters(heard);
      for (const ch of letters(out)) {
        expect(heardLetters.has(ch), `${heard} -> ${out}: ${ch}`).toBe(true);
      }
    }
  });

  it("keeps the baje word in the script it was heard in", () => {
    expect(itn("saade teen baje")).toBe("3:30 baje");
    expect(itn("साढ़े तीन बजे")).toBe("3:30 बजे");
    expect(itn("साढ़े तीन बजे")).not.toMatch(/baje/);
    expect(itn("saade teen baje")).not.toMatch(/बजे/);
  });

  it("converts Devanagari digits to ASCII by default and can keep them", () => {
    expect(applyHinglishItn("१२३ और ४५").text).toBe("123 और 45");
    expect(applyHinglishItn("१२३ और ४५", { digits: "keep" }).text).toBe("१२३ और ४५");
    expect(applyHinglishItn("५० प्रतिशत", { digits: "keep" }).text).toBe("५०%");
  });

  it("does not touch digits stuck to letters", () => {
    expect(itn("abc१२३")).toBe("abc१२३");
    expect(itn("v२ आया")).toBe("v२ आया");
  });
});

describe("hinglish ITN: idempotent", () => {
  it("applying it twice gives the same text as once, for every row", () => {
    for (const [heard] of ALL_TABLES) {
      const once = itn(heard);
      expect(itn(once), `${heard} -> ${once}`).toBe(once);
    }
    for (const text of UNCHANGED) expect(itn(itn(text))).toBe(itn(text));
  });

  it("is idempotent on a long mixed paragraph", () => {
    const text =
      "kal saade teen baje meeting hai, paanch sau rupaye lagenge. John at the rate gmail dot com ko bhejo, " +
      "twenty five percent off, दो हज़ार बीस में पंद्रह अगस्त को डेढ़ बजे, nine eight seven six five four three two one zero.";
    const once = itn(text);
    expect(once).toContain("3:30 baje");
    expect(once).toContain("₹500");
    expect(once).toContain("john@gmail.com");
    expect(once).toContain("25% off");
    expect(once).toContain("2020 में 15 अगस्त को 1:30 बजे");
    expect(once).toContain("9876543210");
    expect(itn(once)).toBe(once);
  });
});

describe("hinglish ITN: result shape", () => {
  it("reports each change with its kind", () => {
    const out = applyHinglishItn("fifty percent and five hundred rupees at half past three");
    expect(out.changed).toBe(true);
    expect(out.raw).toBe("fifty percent and five hundred rupees at half past three");
    expect(out.text).toBe("50% and ₹500 at 3:30");
    expect(out.changes).toEqual([
      { kind: "percent", from: "fifty percent", to: "50%" },
      { kind: "currency", from: "five hundred rupees", to: "₹500" },
      { kind: "time", from: "half past three", to: "3:30" },
    ]);
  });

  it("keeps punctuation and spacing around the rewritten words", () => {
    expect(itn("Total: twenty five, then (fifty percent).")).toBe("Total: 25, then (50%).");
    expect(itn("दाम: पाँच सौ रुपये।")).toBe("दाम: ₹500।");
    expect(itn("a\nthirty\nb")).toBe("a\n30\nb");
  });

  it("does not join number words across a sentence or a line break", () => {
    expect(itn("twenty. five")).toBe("20. five");
    expect(itn("twenty\nfive")).toBe("20\nfive");
    expect(itn("twenty, five")).toBe("20, five");
  });
});

describe("spoken number values", () => {
  it.each<[string, number | null]>([
    ["twenty five", 25],
    ["two thousand five", 2005],
    ["one hundred twenty three", 123],
    ["five hundred thousand", 500000],
    ["दो हज़ार पाँच सौ", 2500],
    ["तीन लाख", 300000],
    ["paanch sau", 500],
    ["do hazaar paanch sau pachas", 2550],
    ["sau", 100],
    ["hazaar", 1000],
    ["ninety nine", 99],
    ["twenty twenty", null],
    ["five five", null],
    ["lakh", null],
    ["thousand", null],
    ["", null],
    ["hello", null],
    ["five hello", null],
    ["do teen", null],
    ["सौ सौ", null],
    ["हज़ार लाख", null],
    ["two lakh thousand", null],
    ["paanch lakh", 500000],
  ])("%s -> %s", (phrase, value) => {
    expect(spokenNumberValue(phrase)).toBe(value);
  });

  it("knows every Roman Hindi number from 1 to 99 except saath (60)", () => {
    expect(ROMAN_NUMBERS).toHaveLength(100);
    for (let n = 1; n < 100; n += 1) {
      const spellings = (ROMAN_NUMBERS[n] ?? "").split("|").filter(Boolean);
      if (n === 60) {
        expect(spellings).toEqual([]);
        continue;
      }
      expect(spellings.length, String(n)).toBeGreaterThan(0);
      for (const word of spellings) expect(spokenNumberValue(word), `${n} ${word}`).toBe(n);
    }
  });

  it("knows the Devanagari number words, with their spellings", () => {
    expect(spokenNumberValue("निन्यानवे")).toBe(99);
    expect(spokenNumberValue("इक्कीस")).toBe(21);
    expect(spokenNumberValue("पैंतीस")).toBe(35);
    expect(spokenNumberValue("छह")).toBe(6);
    expect(spokenNumberValue("छः")).toBe(6);
    expect(spokenNumberValue("पाँच")).toBe(5);
    expect(spokenNumberValue("पांच")).toBe(5);
  });
});
