import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ENGLISH_IN_HINDI,
  ROMAN_HINDI_STRONG,
  ROMAN_HINDI_WEAK,
} from "../../src/lib/friday/voice-engine/speech-prep-lexicon";
import {
  maskInlineCode,
  prepareSpeechText,
  speechPrepTableSizes,
  usesHindiVoice,
} from "../../src/lib/friday/voice-engine/speech-prep";
import {
  prepareForSpeech,
  spellNumbers,
  spellOrdinals,
} from "../../src/lib/friday/voice-engine/text-normalizer";
import { DEFAULT_PREFERENCES } from "../../src/lib/friday/preferences";

type Case = {
  kind: "prep" | "full";
  name: string;
  input: string;
  expected: string;
  options?: { enabled?: boolean; hindiVoice?: boolean };
  pronunciations?: Record<string, string>;
};
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/voice-speech-prep-cases.json"), "utf8"),
) as { cases: Case[] };

const run = (c: Case): string => {
  const options = { enabled: true, hindiVoice: true, ...c.options };
  return c.kind === "prep"
    ? prepareSpeechText(c.input, options)
    : prepareForSpeech(c.input, c.pronunciations ?? {}, options);
};

const pairs = (source: string): string[][] => {
  const words = source.split(/\s+/).filter(Boolean);
  const out: string[][] = [];
  for (let i = 0; i < words.length; i += 2) out.push([words[i] ?? "", words[i + 1] ?? ""]);
  return out;
};

describe("Speech Prep fixture cases", () => {
  it("has a spread of cases", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(40);
  });
  it.each(fixture.cases.map((c) => [c.kind, c.name, c] as const))("%s: %s", (_k, _n, c) => {
    expect(run(c)).toBe(c.expected);
  });

  it("is idempotent: a prepared sentence is not changed again", () => {
    for (const c of fixture.cases.filter((x) => x.kind === "prep")) {
      const once = run(c);
      expect(prepareSpeechText(once, { enabled: true, hindiVoice: true, ...c.options })).toBe(once);
    }
  });

  it("never leaves a Devanagari digit for the voice", () => {
    for (const c of fixture.cases.filter((x) => x.kind === "full")) {
      expect(run(c)).not.toMatch(/[०-९]/);
    }
    expect(spellNumbers("१२३ और ५:३०", "hi")).not.toMatch(/[०-९]/);
  });
});

describe("Speech Prep boundaries", () => {
  it("leaves English sentences exactly as written, with or without the Hindi voice", () => {
    const english = [
      "Please do send the main report to me.",
      "I do not know what to do, main thing is fine.",
      "Open the meeting notes and check the file. Then reply to the email.",
      "kal is a name here and so is Hai Nguyen.",
    ];
    for (const line of english) {
      expect(prepareSpeechText(line, { enabled: true, hindiVoice: true })).toBe(line);
      expect(prepareSpeechText(line, { enabled: true, hindiVoice: false })).toBe(line);
    }
  });

  it("turns Roman Hindi into Devanagari only for the Hindi voice", () => {
    expect(prepareSpeechText("kal meeting hai", { hindiVoice: true })).toBe("कल मीटिंग है");
    expect(prepareSpeechText("kal meeting hai", { hindiVoice: false })).toBe("kal meeting hai");
    expect(prepareSpeechText("आज kal meeting hai", { hindiVoice: false })).toBe("आज kal मीटिंग hai");
  });

  it("needs two sure Roman Hindi words that are half of the Latin words", () => {
    expect(prepareSpeechText("kal send the report to the team today", {})).toBe(
      "kal send the report to the team today",
    );
    expect(prepareSpeechText("kal hai", {})).toBe("कल है");
  });

  it("does nothing when switched off or given nothing", () => {
    expect(prepareSpeechText("कल meeting है", { enabled: false })).toBe("कल meeting है");
    expect(prepareSpeechText("", {})).toBe("");
    expect(prepareForSpeech("कल meeting है", {})).toBe("कल meeting है.");
  });

  it("keeps inline code, links and quoted names out of the lexicon", () => {
    const masked = maskInlineCode("चलाओ `git push origin` अभी और `5` बार");
    expect(masked.text).not.toContain("git push");
    expect(masked.restore(masked.text)).toBe("चलाओ git push origin अभी और `5` बार");
    expect(prepareForSpeech("चलाओ `git push origin` अभी", {}, {})).toBe(
      "चलाओ git push origin अभी.",
    );
    expect(prepareForSpeech('मुझे "Open Drive" चाहिए', {}, {})).toBe('मुझे "Open Drive" चाहिए.');
  });

  it("reads a spelled acronym as letters and the article as one", () => {
    expect(prepareSpeechText("मेरा A P I ठीक है", {})).toBe("मेरा ए पी आई ठीक है");
    expect(prepareSpeechText("यह a link है", {})).toBe("यह एक लिंक है");
  });

  it("decides the Hindi voice from the speaking language", () => {
    expect(usesHindiVoice("hi-IN")).toBe(true);
    expect(usesHindiVoice("")).toBe(true);
    expect(usesHindiVoice("hinglish")).toBe(true);
    expect(usesHindiVoice("en-IN")).toBe(false);
    expect(usesHindiVoice("en_US")).toBe(false);
  });
});

describe("Speech Prep numbers (text-normalizer)", () => {
  it("keeps every old English number form", () => {
    expect(spellNumbers("at 5:30 pm", "en")).toBe("at five thirty P M");
    expect(spellNumbers("at 7:00", "en")).toBe("at seven o'clock");
    expect(spellNumbers("1234567890123", "en")).toBe("1234567890123");
  });

  it("says Hindi ordinals, negatives, rupee units and paise", () => {
    expect(spellOrdinals("1st 2nd 3rd 4th 5th 6th", "hi")).toBe("पहला दूसरा तीसरा चौथा पाँचवाँ छठा");
    expect(spellOrdinals("21st 100th", "en")).toBe("twenty first one hundredth");
    expect(spellNumbers("-5", "hi")).toBe("माइनस पाँच");
    expect(spellNumbers("5 - 3", "en")).toBe("five - three");
    expect(spellNumbers("₹5 lakh", "en")).toBe("five lakh rupees");
    expect(spellNumbers("₹99.50", "hi")).toBe("निन्यानवे रुपये पचास पैसे");
    expect(spellNumbers("₹0.50", "en")).toBe("fifty paise");
  });

  it("says Hindi clock times", () => {
    expect(spellNumbers("3:15", "hi")).toBe("सवा तीन बजे");
    expect(spellNumbers("3:30", "hi")).toBe("साढ़े तीन बजे");
    expect(spellNumbers("3:45", "hi")).toBe("पौने चार बजे");
    expect(spellNumbers("12:45", "hi")).toBe("पौने एक बजे");
    expect(spellNumbers("3:45 बजे", "hi")).toBe("पौने चार बजे");
    expect(spellNumbers("9:20 pm", "hi")).toBe("रात नौ बजकर बीस मिनट");
  });
});

describe("Speech Prep numbers: edge cases", () => {
  type Row = [string, "hi" | "en", string];
  const said = (rows: Row[]) => {
    for (const [input, lang, expected] of rows) {
      expect(spellNumbers(input, lang), `${lang}: ${input}`).toBe(expected);
    }
  };

  it("says negative decimals and decimal percentages", () => {
    said([
      ["-3.5", "hi", "माइनस तीन दशमलव पाँच"],
      ["-3.5", "en", "minus three point five"],
      ["12.5%", "hi", "बारह दशमलव पाँच प्रतिशत"],
      ["12.5%", "en", "twelve point five percent"],
      ["-0.5%", "en", "minus zero point five percent"],
      ["१२.५%", "hi", "बारह दशमलव पाँच प्रतिशत"],
    ]);
  });

  it("says a range with a hyphen or a dash, and leaves a spaced minus alone", () => {
    said([
      ["5-10", "hi", "पाँच से दस"],
      ["5-10", "en", "five to ten"],
      ["5–10 km", "en", "five to ten km"],
      ["5 – 10", "en", "five to ten"],
      ["5-10%", "en", "five to ten percent"],
      ["1,000-2,000", "en", "one thousand to two thousand"],
      ["9-5", "en", "nine to five"],
      ["2020-2026", "en", "twenty twenty to twenty twenty six"],
      ["2020-2026", "hi", "दो हज़ार बीस से दो हज़ार छब्बीस"],
      ["9:00-10:00", "en", "nine o'clock to ten o'clock"],
      ["9:00-10:00", "hi", "नौ बजे से दस बजे"],
      ["5 - 3", "en", "five - three"],
      ["25-01-2026", "en", "twenty five January two thousand twenty six"],
      ["98765-43210", "en", "nine eight seven six five four three two one zero"],
    ]);
  });

  it("says 12 am, 12 pm, hour-only times and a.m. / p.m.", () => {
    said([
      ["12:00 am", "hi", "रात बारह बजे"],
      ["12:00 pm", "hi", "दोपहर बारह बजे"],
      ["12:30 am", "hi", "रात साढ़े बारह बजे"],
      ["12:45 pm", "hi", "दोपहर पौने एक बजे"],
      ["12:00 AM", "en", "twelve o'clock A M"],
      ["12:00 PM", "en", "twelve o'clock P M"],
      ["5 pm", "en", "five P M"],
      ["5 pm", "hi", "शाम पाँच बजे"],
      ["9 am", "hi", "सुबह नौ बजे"],
      ["11 pm", "hi", "रात ग्यारह बजे"],
      ["5 p.m. sharp", "en", "five P M sharp"],
      ["Come at 9 a.m. Then rest", "en", "Come at nine A M. Then rest"],
      ["5:45 p.m.", "hi", "शाम पौने छह बजे."],
      ["I am 25 years old", "en", "I am twenty five years old"],
      ["13 pm", "en", "thirteen pm"],
    ]);
  });

  it("says 24x7 and sizes, and leaves hex and a multiplier alone", () => {
    said([
      ["24x7", "hi", "चौबीस बाई सात"],
      ["24x7", "en", "twenty four seven"],
      ["24/7", "en", "twenty four seven"],
      ["3x3", "en", "three by three"],
      ["1920x1080", "hi", "एक हज़ार नौ सौ बीस बाई एक हज़ार अस्सी"],
      ["0x1F", "en", "0x1F"],
      ["5x faster", "en", "5x faster"],
    ]);
  });

  it("says ordinals in dates and years by language", () => {
    said([
      ["21st January 2026", "en", "twenty first January twenty twenty six"],
      ["January 21st, 2026", "en", "January twenty first, twenty twenty six"],
      ["1st जनवरी 2026", "hi", "पहली जनवरी दो हज़ार छब्बीस"],
      ["21st जनवरी", "hi", "इक्कीस जनवरी"],
      ["in 2026", "en", "in twenty twenty six"],
      ["since 1999", "en", "since nineteen ninety nine"],
      ["year 2005", "en", "year two thousand five"],
      ["in 1905", "en", "in nineteen oh five"],
      ["in 1900", "en", "in nineteen hundred"],
      ["15 August 1947", "en", "fifteen August nineteen forty seven"],
      ["सन 1999", "hi", "सन उन्नीस सौ निन्यानवे"],
      ["साल 2026", "hi", "साल दो हज़ार छब्बीस"],
      ["2026 items", "en", "two thousand twenty six items"],
      ["25/01/1999", "hi", "पच्चीस जनवरी उन्नीस सौ निन्यानवे"],
      ["25/01/2026", "en", "twenty five January two thousand twenty six"],
      ["25/01/2026", "hi", "पच्चीस जनवरी दो हज़ार छब्बीस"],
    ]);
  });

  it("says phone numbers digit by digit with or without +91", () => {
    const en = "nine eight seven six five four three two one zero";
    const hi = "नौ आठ सात छह पाँच चार तीन दो एक शून्य";
    said([
      ["9876543210", "en", en],
      ["9876543210", "hi", hi],
      ["98765 43210", "en", en],
      ["+91 98765 43210", "en", `plus nine one ${en}`],
      ["+919876543210", "en", `plus nine one ${en}`],
      ["+91-9876543210", "hi", `प्लस नौ एक ${hi}`],
      ["+91 9876543210", "hi", `प्लस नौ एक ${hi}`],
      ["1234567890123", "en", "1234567890123"],
    ]);
  });

  it("says rupees and paise, singular for one, and a single paise digit as tens", () => {
    said([
      ["₹99.5", "hi", "निन्यानवे रुपये पचास पैसे"],
      ["₹1.01", "hi", "एक रुपया एक पैसा"],
      ["₹1.01", "en", "one rupee one paisa"],
      ["₹1", "hi", "एक रुपया"],
      ["₹1.00", "en", "one rupee"],
      ["Rs. 1,234.50", "en", "one thousand two hundred thirty four rupees fifty paise"],
      ["₹0.05", "en", "five paise"],
      ["₹0.01", "hi", "एक पैसा"],
      [
        "₹12,34,567.89",
        "en",
        "twelve lakh thirty four thousand five hundred sixty seven rupees eighty nine paise",
      ],
      ["₹250", "hi", "दो सौ पचास रुपये"],
      ["₹5 lakh", "hi", "पाँच लाख रुपये"],
    ]);
  });

  it("says Indian grouping up to 99 crore, and leaves a larger number as digits", () => {
    said([
      ["12,34,567", "hi", "बारह लाख चौंतीस हज़ार पाँच सौ सड़सठ"],
      ["12,34,567", "en", "twelve lakh thirty four thousand five hundred sixty seven"],
      ["1,234,567", "en", "twelve lakh thirty four thousand five hundred sixty seven"],
      ["1,23,45,678", "hi", "एक करोड़ तेईस लाख पैंतालीस हज़ार छह सौ अठहत्तर"],
      ["1,00,00,000", "hi", "एक करोड़"],
      [
        "99,99,99,999",
        "en",
        "ninety nine crore ninety nine lakh ninety nine thousand nine hundred ninety nine",
      ],
      ["1,00,00,00,000", "en", "1,00,00,00,000"],
    ]);
  });

  it("says fractions: half, quarter, three quarters, डेढ़ and ढाई", () => {
    said([
      ["1/2", "hi", "आधा"],
      ["1/2", "en", "one half"],
      ["1/4", "hi", "एक चौथाई"],
      ["3/4", "hi", "तीन चौथाई"],
      ["3/4", "en", "three quarters"],
      ["2/3", "hi", "दो तिहाई"],
      ["2/3", "en", "two thirds"],
      ["5/8", "hi", "पाँच बटा आठ"],
      ["5/8", "en", "five eighths"],
      ["1 1/2", "hi", "डेढ़"],
      ["2 1/2", "hi", "ढाई"],
      ["3 1/2", "hi", "साढ़े तीन"],
      ["1 1/4", "hi", "सवा एक"],
      ["2 3/4", "hi", "पौने तीन"],
      ["2 1/2", "en", "two and a half"],
      ["3 3/4", "en", "three and three quarters"],
      ["1.5", "hi", "डेढ़"],
      ["2.5", "hi", "ढाई"],
      ["0.5", "hi", "आधा"],
      ["-1.5", "hi", "माइनस डेढ़"],
      ["1.5%", "hi", "डेढ़ प्रतिशत"],
      ["₹1.5 lakh", "hi", "डेढ़ लाख रुपये"],
      ["3.5", "hi", "तीन दशमलव पाँच"],
      ["1.5", "en", "one point five"],
      ["version 1.5", "hi", "version एक दशमलव पाँच"],
      ["page 1/5", "en", "page one/five"],
    ]);
  });

  it("keeps the punctuation next to a number and never touches code or links", () => {
    said([
      ["open 9-5, then rest", "en", "open nine to five, then rest"],
      ["५-१०", "hi", "पाँच से दस"],
      ["", "en", ""],
    ]);
    expect(prepareForSpeech("चलाओ `ping -c 5-10 v1.5 24x7` अभी", {}, {})).toBe(
      "चलाओ ping -c 5-10 v1.5 24x7 अभी.",
    );
    expect(prepareForSpeech("See https://example.com/a-5-10/24x7 for 5-10", {}, {})).toBe(
      "See a link for five to ten.",
    );
    expect(prepareForSpeech('He said "call 5-10 times" and left at 5-10', {}, {})).toBe(
      'He said "call five to ten times" and left at five to ten.',
    );
  });

  it("stays linear on text built to hurt the number rules", () => {
    const nasty = [
      "5-".repeat(30000),
      "1/".repeat(30000),
      "1 1/".repeat(20000),
      `${"2026 ".repeat(15000)}in`,
      "9 ".repeat(30000) + "pm",
      "+91 ".repeat(20000),
      "₹1.".repeat(30000),
      "a.m.".repeat(20000),
    ];
    for (const text of nasty) {
      const started = performance.now();
      spellNumbers(text, "hi");
      spellNumbers(text, "en");
      expect(performance.now() - started, text.slice(0, 12)).toBeLessThan(800);
    }
  });

  it("is idempotent and leaves no digit behind", () => {
    const inputs = [
      "12.5% और 5-10 और 24x7",
      "12:00 am से 5 pm तक, +91 98765 43210",
      "₹99.5 और 1 1/2 और 3/4 और 2.5",
      "in 2026, 21st January",
    ];
    for (const lang of ["hi", "en"] as const) {
      for (const input of inputs) {
        const once = spellNumbers(input, lang);
        expect(once, input).not.toMatch(/[0-9०-९]/);
        expect(spellNumbers(once, lang), input).toBe(once);
      }
    }
  });
});

describe("Speech Prep lexicon", () => {
  const english = pairs(ENGLISH_IN_HINDI);
  const strong = pairs(ROMAN_HINDI_STRONG);
  const weak = pairs(ROMAN_HINDI_WEAK);

  it("is well formed: lower-case ASCII keys, Devanagari values, no key twice", () => {
    for (const table of [english, strong, weak]) {
      const seen = new Set<string>();
      for (const [key = "", value = ""] of table) {
        expect(key, key).toMatch(/^[a-z]+$/);
        expect(value, `${key} -> ${value}`).toMatch(/^[ऀ-ॣॱ-ॿ]+$/);
        expect(seen.has(key), `${key} twice`).toBe(false);
        seen.add(key);
      }
    }
  });

  it("keeps sure Roman Hindi apart from English and from the ambiguous words", () => {
    const englishKeys = new Set(english.map(([k]) => k));
    const weakKeys = new Set(weak.map(([k]) => k));
    for (const [key = ""] of strong) {
      expect(englishKeys.has(key), `${key} is also English`).toBe(false);
      expect(weakKeys.has(key), `${key} is also ambiguous`).toBe(false);
    }
    for (const sure of ["the", "do", "main", "is", "to", "me", "so", "at", "in", "a"]) {
      expect(
        strong.some(([k]) => k === sure),
        sure,
      ).toBe(false);
    }
  });

  it("is large enough and parsed once", () => {
    const sizes = speechPrepTableSizes();
    expect(sizes.english).toBeGreaterThanOrEqual(1500);
    expect(sizes.english).toBe(english.length);
    expect(sizes.romanHindi).toBeGreaterThanOrEqual(370);
    expect(sizes.ambiguous).toBe(weak.length);
    expect(speechPrepTableSizes()).toEqual(sizes);
  });

  it("writes every value the same way: no precomposed nukta letter, no ZWJ, no stray mark", () => {
    for (const table of [english, strong, weak]) {
      for (const [key = "", value = ""] of table) {
        expect(value, key).not.toMatch(/[\u0958-\u095f]/);
        expect(value, key).not.toMatch(/[\u200b-\u200d]/);
        expect(value, key).not.toMatch(/^[ािीुूृेैोौंँः़्]/);
        expect(value, key).toBe(value.normalize("NFD"));
      }
    }
  });

  it("keeps sure Roman Hindi out of the English table (only the old 'main' is shared; the ambiguous words may be)", () => {
    const hint =
      "aap ab abhi acha accha aur bahut baat bhi chahiye dena do haan hai hain ho hoga hum ka kaam kab kaise kaun " +
      "kar karo kare karna kya ke ki ko kuch kyun mai main mera meri mere mujhe nahi nahin naam par pehle phir " +
      "raha rahi ruko ruk se suno tum tumhe tumhara ye yeh wo woh yahan wahan zara jao jaao batao bata bana banao " +
      "bhej bhejo dekho khol kholo band dikhao lo";
    const roman = new Set([...hint.split(" "), ...strong.map(([k]) => k)]);
    const shared = english.map(([k = ""]) => k).filter((k) => roman.has(k));
    expect(shared).toEqual(["main"]);
  });

  it("covers the words Hindi chat borrows: apps, office, time, food, travel, social, money, health", () => {
    const wanted: Record<string, string> = {
      touchscreen: "टचस्क्रीन",
      workflow: "वर्कफ़्लो",
      colleague: "कलीग",
      reschedule: "रीशेड्यूल",
      sunrise: "सनराइज़",
      noodles: "नूडल्स",
      luggage: "लगेज",
      platform: "प्लेटफ़ॉर्म",
      awesome: "ऑसम",
      wallet: "वॉलेट",
      atm: "एटीएम",
      vaccine: "वैक्सीन",
      workout: "वर्कआउट",
      hungry: "हंग्री",
      confused: "कन्फ़्यूज़्ड",
    };
    const table = new Map<string, string>(english.map(([k = "", v = ""]) => [k, v]));
    for (const [key, value] of Object.entries(wanted)) expect(table.get(key), key).toBe(value);
  });

  it("reads the new words in a Hindi sentence and a plural of a new word", () => {
    expect(prepareSpeechText("मेरा wallet और atm card कहाँ है", {})).toBe(
      "मेरा वॉलेट और एटीएम कार्ड कहाँ है",
    );
    expect(prepareSpeechText("मुझे noodles और momos चाहिए", {})).toBe("मुझे नूडल्स और मोमोज़ चाहिए");
    expect(prepareSpeechText("कल की flights और platforms देखो", {})).toBe(
      "कल की फ़्लाइट्स और प्लेटफ़ॉर्म्स देखो",
    );
  });
});

describe("Speech Prep latency", () => {
  const reply =
    "आपके Gmail में एक नया email आया है और kal ki meeting 3:45 बजे है, ₹1,500 का bill भी pending है। ";
  const hinglish = "kal meeting hai aur aap mujhe do minute mein call kar do. ";
  const english = "Please send the report to the team before the meeting on the 21st at 3:45 pm. ";

  it("stays far below the 800 ms voice budget and reports chars per ms", () => {
    const text = (reply + hinglish + english).repeat(500);
    const started = performance.now();
    const out = prepareForSpeech(text, {}, { enabled: true, hindiVoice: true });
    const ms = Math.max(performance.now() - started, 0.001);
    const rate = text.length / ms;
    expect(out.length).toBeGreaterThan(0);
    // A normal reply is a few hundred characters; this is about 100 000.
    expect(ms).toBeLessThan(800);
    expect(rate).toBeGreaterThan(100);
  });

  it("a typical reply costs a few milliseconds", () => {
    const started = performance.now();
    for (let i = 0; i < 50; i += 1) prepareForSpeech(reply + hinglish, {}, { enabled: true });
    expect((performance.now() - started) / 50).toBeLessThan(25);
  });

  it("survives text built to hurt regular expressions", () => {
    const nasty = [
      `${"'".repeat(20000)}x`,
      `"${"a ".repeat(30000)}`,
      "क ".repeat(20000) + "A ".repeat(20000),
      "a.b ".repeat(20000),
      `${"1".repeat(40000)}:${"5".repeat(40000)}`,
      "₹".repeat(30000) + "1,".repeat(30000),
      "-".repeat(50000) + "5",
    ];
    for (const text of nasty) {
      const started = performance.now();
      prepareForSpeech(text, {}, { enabled: true, hindiVoice: true });
      expect(performance.now() - started, text.slice(0, 12)).toBeLessThan(800);
    }
  });
});

describe("Speech Prep setting", () => {
  const read = (file: string) => readFileSync(resolve(__dirname, "../..", file), "utf8");

  it("is on by default and honoured on the speak path", () => {
    expect(DEFAULT_PREFERENCES.voice.speechPrep).toBe(true);
    const mode = read("src/lib/friday/assistant-mode.ts");
    expect(mode).toContain("enabled: voice.speechPrep !== false");
    expect(mode).toContain("hindiVoice: usesHindiVoice(voice.speechLang || voice.recognitionLang)");
  });

  it("has a switch in Settings, Voice and is in the flow registry", () => {
    expect(read("src/components/friday/settings/VoiceSettings.tsx")).toContain(
      "prefs.voice.speechPrep !== false",
    );
    expect(read("src/lib/friday/flow-registry.gen.ts")).toContain('"voice.speechPrep"');
  });
});
