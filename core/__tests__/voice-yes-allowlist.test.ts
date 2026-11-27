/**
 * The spoken yes is an allowlist. A yes only when the whole answer, without fillers, is one or more short yes phrases
 * from the one table (`CONFIRM_WORDS` in voice-session.ts), in Latin, Hinglish and Devanagari. A no word anywhere is a
 * no. Everything else is unclear and she asks again. The gate is zero false yes over every line below.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  CONFIRM_WORDS,
  CONFIRM_YES_MAX_WORDS,
  confirmationVerdict,
  isBoundConfirmation,
  mentionsConfirmWord,
  wordsAfterYes,
} from "../../src/lib/friday/voice-session";
import {
  buildConfirmDigest,
  explainDigestAnswer,
} from "../../src/lib/friday/voice-engine/confirm-digest";

/** Lines that must never be a yes. */
const NEVER_YES: readonly string[] = [
  // The Lens findings.
  "na karo",
  "nai karo",
  "haan ruk",
  "ok tham jao",
  "pause karo",
  "ok skip",
  "baadme karo",
  "ok parso",
  "haan kabhi aur",
  "yes maybe",
  "haan shayad",
  "ok रहने दे",
  "ok छोड़",
  "ok ठहरो",
  // Stop, wait, pause, skip.
  "na kar",
  "naa karo",
  "nako",
  "ok nako",
  "ok wait",
  "haan ek minute",
  "ok hold",
  "haan thoda ruko",
  "ok thehro",
  "cancel karo",
  "skip karo",
  "skip it",
  "pause",
  "pause it",
  "hold karo",
  "rok do",
  "ok rok do",
  "roko",
  "ruk ja",
  "haan ruk ja",
  "tham ja",
  "thamo",
  "bas bas",
  "ok bas",
  "enough",
  "ok enough",
  "leave it",
  "chhodo",
  "ok chhodo",
  "jaane do",
  "ok jaane do",
  "rehne de",
  "ok rehne de",
  "mana karo",
  "mat",
  "matt karo",
  "mat kar",
  "ok mat",
  "stop it",
  "wait wait",
  "ok stop",
  "yes stop",
  "haan band karo",
  "ok cancel",
  "okay cancel that",
  // Later, not now, maybe.
  "theek hai baad me",
  "ok kal",
  "haan parso karna",
  "ok phir kabhi",
  "yes later",
  "ok tomorrow",
  "sure maybe",
  "maybe",
  "probably",
  "i guess",
  "i think so",
  "not sure",
  "haan pata nahi",
  "ok sochta hoon",
  "dekhte hain",
  "ok dekhenge",
  "haan baad mein",
  "ok baadme",
  "sure, later",
  "okay not now",
  "yes but not now",
  "not yet okay",
  "haan abhi nahi",
  "ok fir kabhi",
  "kabhi aur",
  "parso",
  "ok shayad",
  "shayad haan",
  "maybe yes",
  "yes perhaps",
  // Plain no in Latin.
  "no",
  "nope",
  "nah",
  "ok nah",
  "ok nope",
  "never",
  "no way",
  "absolutely not",
  "definitely not",
  "not really",
  "kabhi nahi",
  "bilkul nahi",
  "zaroor nahi",
  "bilkul mat",
  "haan haan nahi",
  "do not",
  "don't",
  "dont",
  "don’t do it",
  "ok dont",
  "nahi yaar",
  "nai",
  "nai yaar",
  "nahin",
  "nhi",
  "nahi mat karo",
  "haan nahi",
  "yes no",
  "no yes",
  "no, I mean yes",
  "yes no wait",
  "ok nahi",
  "na",
  // Idioms that only look like a yes.
  "why not",
  "no problem",
  "no worries",
  "koi baat nahi",
  "of course not",
  "sure thing not",
  // Laughter, fillers, questions.
  "hmm",
  "umm",
  "uh",
  "ha ha",
  "ha ha ha",
  "hahaha",
  "hehe",
  "lol",
  "haha ok",
  "ok haha",
  "हा हा",
  "हाहा",
  "yes?",
  "haan?",
  "ok?",
  "kya?",
  "what?",
  "huh",
  "sorry",
  "say again",
  "phir se bolo",
  "kya bola",
  "",
  "   ",
  "...",
  "ji",
  "friday",
  "please",
  "bhai",
  // Names and words that contain a stop word.
  "Kalpana",
  "basket",
  "Nottingham",
  "bandwidth",
  "kalam",
  "ok Kalpana",
  "haan Kalpana ko bhejo",
  "yes basket",
  "ok bandwidth",
  "haan kalam",
  "haan Nottingham",
  "okay Rahul",
  "yes Rohan",
  "haan Amit ko",
  "nokia",
  "notepad",
  "ok notepad",
  "banda",
  "haan banda",
  "kalpana",
  "Bastar",
  "matlab",
  "haan matlab",
  "nayi",
  "नमस्ते",
  "मतलब",
  "नया",
  "बंदर",
  "कलम",
  "बादल",
  "ok नमस्ते",
  "हाँ मतलब",
  "हाँ नया",
  "ok बादल",
  "हाँ बंदर",
  "ठीक है बादल",
  "हाँ कलम",
  // Numbers and commands.
  "ok 5000",
  "yes 3",
  "haan 2 baje",
  "okay 10 minutes",
  "open notepad",
  "what time is it",
  "play music",
  "ok play music",
  "yes open chrome",
  "haan gaana chalao",
  "ok send it",
  "send 5000 rupees to rahul",
  "haan approve kar do",
  "haan main malik hu",
  "say yes",
  "yes means no",
  "the answer is yes",
  "I said yes",
  "yes yes yes yes yes",
  "yes please go ahead and do it right now",
  "haan bolo",
  "karo",
  "chalao",
  "kar",
  // Devanagari.
  "ना",
  "ना करो",
  "नहीं",
  "नही करो",
  "मत",
  "रुक",
  "रुक जाओ",
  "ठहरो",
  "रहने दे",
  "रहने दो",
  "छोड़ो",
  "छोड़",
  "बाद में करना",
  "कल",
  "परसों",
  "फिर कभी",
  "शायद",
  "हाँ शायद",
  "हाँ पर बाद में",
  "हाँ रुको",
  "ठीक है पर अभी नहीं",
  "ओके रुको",
  "हा हा हा",
  "जी नहीं",
  "बिल्कुल नहीं",
  "ज़रूर नहीं",
  "कभी नहीं",
  "पॉज़ करो",
  "स्किप करो",
  "कैंसल करो",
  "हाँ कैंसल",
  "ok नहीं",
  "yes नहीं",
  "हाँ नहीं",
  "मत करो",
  "रुको",
  "बंद करो",
  "बस",
  "बाद में",
  "कल करना",
  "हाँ?",
  "जी",
  "करो",
  "हाँ बाद में",
  "ठीक है कल",
  "हाँ परसों",
  "थम जाओ",
  "ओके छोड़ दो",
  // Mixed scripts and multi-clause.
  "yes but wait",
  "ok but no",
  "haan lekin ruko",
  "sure but cancel the second one",
  "go ahead no stop",
  "yes, no, maybe",
  "haan nahi haan",
  "ok ok no",
];

/** Short answers that are a yes in Latin, Hinglish and Devanagari. */
const ALWAYS_YES: readonly string[] = [
  "yes",
  "yeah",
  "yep",
  "yup",
  "ok",
  "okay",
  "sure",
  "go ahead",
  "do it",
  "confirm",
  "confirmed",
  "proceed",
  "haan",
  "han",
  "haa",
  "ha",
  "haanji",
  "hanji",
  "haan ji",
  "ji haan",
  "theek hai",
  "thik hai",
  "kar do",
  "haan karo",
  "haan kar do",
  "ha kar do",
  "bilkul",
  "ji bilkul",
  "zaroor",
  "zarur",
  "yes do it",
  "okay go ahead",
  "theek hai kar do",
  "kar do na",
  "haan na",
  "Yes!",
  "Yes.",
  "OK.",
  "Okay, go ahead.",
  "yes please",
  "please do it",
  "haan bhai",
  "ok friday",
  "friday yes",
  "umm yes",
  "haan kar do isko",
  "kar do please",
  "yes, do it",
  "sure, go ahead",
  "haan haan",
  "ok ok",
  "yeah sure",
  "हाँ",
  "हां",
  "हाँ करो",
  "हाँ कर दो",
  "हां कर दो",
  "जी हाँ",
  "जी हां",
  "हाँ जी",
  "ठीक है",
  "ठीक है कर दो",
  "कर दो",
  "बिल्कुल",
  "बिलकुल",
  "ज़रूर",
  "जरूर",
  "ओके",
  "जी बिल्कुल",
  "हाँ जी कर दो",
  "yes हाँ",
  "ok ठीक है",
  "हाँ ok",
  "हाँ।",
  "ठीक है।",
];

/** Words that put an answer off or leave it open: with any yes they are never a yes. */
const LATER_OR_MAYBE = [
  "maybe",
  "shayad",
  "parso",
  "kabhi aur",
  "phir kabhi",
  "probably",
  "perhaps",
  "sochta hoon",
  "dekhte hain",
  "शायद",
  "परसों",
  "फिर कभी",
];

/** Names and words that hold a stop word inside them: never a no, never a yes. */
const NAMES = [
  "Kalpana",
  "basket",
  "Nottingham",
  "bandwidth",
  "kalam",
  "notepad",
  "Bastar",
  "matlab",
  "नमस्ते",
  "मतलब",
  "नया",
  "बंदर",
  "कलम",
  "बादल",
];

const NOW = 1_000_000;
const fresh = { ownPlayback: false };
const send = () =>
  buildConfirmDigest({
    command: "send 5000 rupees to rahul",
    turnId: "t1",
    now: NOW,
    kind: "irreversible",
  });

/** A read-back whose own words appear in none of the lines above, so no line can repeat it. */
const pay = () =>
  buildConfirmDigest({
    command: "transfer 700 dollars to meera",
    turnId: "t1",
    now: NOW,
    kind: "irreversible",
  });

describe("the spoken yes allowlist", () => {
  it.each(NEVER_YES.map((line) => [line]))("%j is never a yes", (line) => {
    expect(confirmationVerdict(line)).not.toBe("yes");
    expect(isBoundConfirmation(line, (v) => confirmationVerdict(v) === "yes")).toBe(false);
  });

  it.each(NEVER_YES.map((line) => [line]))("%j never approves a read-back", (line) => {
    expect(explainDigestAnswer(pay(), line, NOW + 1000, fresh).answer).not.toBe("yes");
  });

  it.each(ALWAYS_YES.map((line) => [line]))("%j is a yes", (line) => {
    expect(confirmationVerdict(line)).toBe("yes");
    expect(explainDigestAnswer(send(), line, NOW + 1000, fresh).answer).toBe("yes");
  });

  it("every phrase in the yes table is a yes on its own, in its own script", () => {
    for (const phrase of CONFIRM_WORDS.yes) expect(confirmationVerdict(phrase), phrase).toBe("yes");
  });

  it("a yes phrase next to any no phrase is a no, in either order", () => {
    for (const yes of CONFIRM_WORDS.yes)
      for (const no of CONFIRM_WORDS.no) {
        expect(confirmationVerdict(`${yes} ${no}`), `${yes} ${no}`).toBe("no");
        expect(confirmationVerdict(`${no} ${yes}`), `${no} ${yes}`).toBe("no");
      }
  });

  it("a yes phrase next to a later or a maybe is never a yes", () => {
    for (const yes of CONFIRM_WORDS.yes)
      for (const later of LATER_OR_MAYBE) {
        expect(confirmationVerdict(`${yes} ${later}`), `${yes} ${later}`).not.toBe("yes");
        expect(confirmationVerdict(`${later} ${yes}`), `${later} ${yes}`).not.toBe("yes");
      }
  });

  it("a yes phrase next to a name or a word that holds a stop word is never a yes", () => {
    for (const yes of CONFIRM_WORDS.yes)
      for (const name of NAMES)
        expect(confirmationVerdict(`${yes} ${name}`), `${yes} ${name}`).toBe("unclear");
    for (const name of NAMES) expect(confirmationVerdict(name), name).toBe("unclear");
  });

  it("the review's false yeses are a no or unclear, as listed", () => {
    const expected: Record<string, "no" | "unclear"> = {
      "na karo": "no",
      "nai karo": "no",
      "haan ruk": "no",
      "ok tham jao": "no",
      "pause karo": "no",
      "ok skip": "no",
      "baadme karo": "no",
      "ok parso": "unclear",
      "haan kabhi aur": "unclear",
      "yes maybe": "unclear",
      "haan shayad": "unclear",
      "ok रहने दे": "no",
      "ok छोड़": "no",
      "ok ठहरो": "no",
      "no problem": "unclear",
      "why not": "unclear",
      na: "no",
    };
    for (const [line, verdict] of Object.entries(expected))
      expect(confirmationVerdict(line), line).toBe(verdict);
  });

  it("the Devanagari yes is a yes with either nasal mark and with or without the nukta", () => {
    for (const line of ["हाँ", "हां", "हाँ करो", "हां करो", "जी हाँ", "जी हां", "ठीक है", "ज़रूर", "जरूर"])
      expect(confirmationVerdict(line), line).toBe("yes");
  });

  it(`a yes is at most ${CONFIRM_YES_MAX_WORDS} words once the fillers are gone`, () => {
    expect(confirmationVerdict("yes ok sure haan")).toBe("yes");
    expect(confirmationVerdict("yes ok sure haan yes")).toBe("unclear");
    expect(confirmationVerdict("please yes ok friday sure haan")).toBe("yes");
  });

  it("fillers alone are no answer", () => {
    for (const filler of CONFIRM_WORDS.fillers)
      expect(confirmationVerdict(filler), filler).toBe("unclear");
  });

  it("a curly apostrophe reads like a straight one", () => {
    expect(confirmationVerdict("don’t")).toBe("no");
    expect(confirmationVerdict("ok don’t")).toBe("no");
  });
});

describe("a yes that repeats the read-back", () => {
  it("is a yes only when every extra word is the order's own", () => {
    expect(explainDigestAnswer(send(), "yes send it to Rahul", NOW + 1000, fresh).answer).toBe(
      "yes",
    );
    expect(explainDigestAnswer(send(), "haan 5000", NOW + 1000, fresh).answer).toBe("yes");
    expect(explainDigestAnswer(send(), "yes send it to Rohan", NOW + 1000, fresh).reason).toBe(
      "mismatch",
    );
    expect(explainDigestAnswer(send(), "yes send 9000", NOW + 1000, fresh).reason).toBe("mismatch");
    for (const line of [
      "yes send it later",
      "yes send maybe",
      "haan bhejo mat",
      "yes send it tomorrow",
    ])
      expect(explainDigestAnswer(send(), line, NOW + 1000, fresh).answer, line).not.toBe("yes");
  });

  it("the words after a leading yes are read in the table's spelling; a no or no yes gives none", () => {
    expect(wordsAfterYes("Yes, send it to Rahul.")).toEqual(["send", "it", "to", "rahul"]);
    expect(wordsAfterYes("haan ji")).toEqual([]);
    expect(wordsAfterYes("yes no")).toBeNull();
    expect(wordsAfterYes("send it")).toBeNull();
    expect(wordsAfterYes("yes?")).toBeNull();
  });
});

describe("one table", () => {
  it("lives only in voice-session.ts and the digest reads the same verdict", () => {
    const session = readFileSync("src/lib/friday/voice-session.ts", "utf8");
    expect(session).toMatch(/export const CONFIRM_WORDS = \{/);
    expect(session).not.toMatch(/const (?:YES_WORDS|NO_WORDS|DEVANAGARI_NO_WORDS)\b/);
    const digest = readFileSync("src/lib/friday/voice-engine/confirm-digest.ts", "utf8");
    expect(digest).toMatch(/confirmationVerdict\(heard\) === "yes"/);
    expect(digest).toMatch(/wordsAfterYes\(/);
  });

  it("finds an answer word inside a line she says herself", () => {
    expect(mentionsConfirmWord("On it, Haan.")).toBe(true);
    expect(mentionsConfirmWord("एक पल, हाँ।")).toBe(true);
    expect(mentionsConfirmWord("Ek minute, Kalpana.")).toBe(false);
    expect(mentionsConfirmWord("One moment.")).toBe(false);
  });
});
