import { beforeEach, describe, expect, it } from "vitest";
import { affect, readFeeling } from "../../src/lib/friday/brain/affect";
import { baselineRespond } from "../../src/lib/friday/brain/baseline-responder";
import {
  comfortReply,
  correctMoodReading,
  describeUserMood,
  isPureFeeling,
} from "../../src/lib/friday/brain/comfort";
import { PHRASE_BANK } from "../../src/lib/friday/data/phrase-bank";
import { phraseClaimsFeeling, resetPhraseWindow } from "../../src/lib/friday/phrase-bank";

const calm = () => {
  affect.forgetReadings();
  resetPhraseWindow();
};

describe("reading how the owner feels", () => {
  const reads: [string, string][] = [
    ["mujhe bahut tension ho rahi hai", "anxiety"],
    ["aaj main bahut thak gaya hu", "tiredness"],
    ["I'm completely exhausted", "tiredness"],
    ["bahut kaam hai sab kuch ek saath", "overwhelm"],
    ["mera mood kharab hai", "sadness"],
    ["आज मैं बहुत उदास हूँ", "sadness"],
    ["interview me reject ho gaya", "disappointment"],
    ["finally done, what a relief", "relief"],
    ["yaar ye bakwaas hai, kitni baar bataya", "anger"],
    ["मुझे घबराहट हो रही है", "anxiety"],
    ["mujhe jeene ka mann nahi", "distress"],
    ["i want to end my life", "distress"],
  ];
  it.each(reads)("%s -> %s", (text, label) => {
    expect(readFeeling(text).label).toBe(label);
  });

  it("matches whole words only: a download is not sadness and a plain 'abhi' is not a hurry", () => {
    expect(readFeeling("download the installer").label).toBe("neutral");
    expect(readFeeling("abhi time kya hua hai").label).toBe("neutral");
    expect(readFeeling("I'm not tired at all").label).not.toBe("tiredness");
  });
});

describe("answering it kindly, without a model", () => {
  beforeEach(calm);

  it("a message that is only a feeling gets a warm reply with one concrete offer", () => {
    for (const text of [
      "mujhe bahut tension ho rahi hai",
      "aaj main bahut thak gaya hu",
      "I'm so overwhelmed",
      "bahut udaas hu yaar",
    ]) {
      expect(isPureFeeling(text), text).toBe(true);
      const reply = baselineRespond(text);
      expect(reply.handled, text).toBe(true);
      expect(reply.text.length, text).toBeGreaterThan(30);
      expect(reply.text, text).toMatch(/\?|\.$/);
    }
  });

  it("answers in the language it was written in", () => {
    expect(comfortReply("I'm so overwhelmed")).toMatch(/list|sort/i);
    expect(comfortReply("मुझे बहुत घबराहट हो रही है")).toMatch(/[ऀ-ॿ]/);
    expect(comfortReply("aaj main bahut thak gaya hu")).toMatch(/alag rakh|filhaal/i);
  });

  it("a message with a task in it is not taken over: the task stays with the model", () => {
    for (const text of [
      "tension hai, report bhej do",
      "I'm tired, open chrome",
      "thak gaya hu, 5 baje reminder laga do",
    ]) {
      expect(isPureFeeling(text), text).toBe(false);
      expect(comfortReply(text)).toBeNull();
    }
  });

  it("a person in distress is pointed to a person, with no diagnosis and no claim to be one", () => {
    const reply = comfortReply("i want to end my life") ?? "";
    expect(reply).toMatch(/iCall|AASRA/);
    expect(reply).not.toMatch(/\b(you have|diagnos\w*|depression|disorder)\b/i);
    expect(reply).toMatch(/software|not a clinician|doctor nahi|डॉक्टर नहीं/i);
  });

  it("nothing in the bank claims a human feeling, and every feeling has three different lines", () => {
    expect(phraseClaimsFeeling()).toEqual([]);
    for (const lang of ["en", "hi", "hinglish"]) {
      for (const emotion of [
        "sadness",
        "anxiety",
        "tiredness",
        "overwhelm",
        "disappointment",
        "relief",
        "anger",
      ]) {
        const lines = new Set(
          PHRASE_BANK.filter(
            (row) => row.lang === lang && row.emotion === emotion && row.kind === "ack",
          ).map((row) => row.text),
        );
        expect(lines.size, `${lang}/${emotion}`).toBe(3);
      }
    }
    expect(
      PHRASE_BANK.filter((row) => row.lang === "hi" && row.kind === "ack").every(
        (row) => /[ऀ-ॿ]/.test(row.text) || row.text.includes("iCall"),
      ),
    ).toBe(true);
  });
});

describe("remembering the pattern, and letting the owner correct it", () => {
  beforeEach(calm);

  it("one bad moment is a moment; the same feeling again and again is a mood she names, as a guess", () => {
    affect.observePrompt("mujhe tension hai");
    expect(affect.moodTrend().carrying).toBe(false);
    affect.observePrompt("kaam bahut hai aur tension badh rahi hai");
    affect.observePrompt("phir tension ho rahi hai");
    expect(affect.moodTrend()).toMatchObject({ label: "anxiety", carrying: true });
    const said = describeUserMood("main kaisa lag raha hoon");
    expect(said).toMatch(/andaza/i);
    expect(said).toMatch(/galat ho to/i);
    expect(affect.prompt()).toMatch(/last \d+ messages/);
  });

  it("how do I sound is answered from his words, in his language, and says it is a guess", () => {
    affect.observePrompt("I'm so tired today");
    affect.observePrompt("honestly exhausted");
    expect(describeUserMood("how do i sound")).toMatch(/guess/i);
    const reply = baselineRespond("mera mood kaisa lag raha hai");
    expect(reply.handled).toBe(true);
  });

  it("'you misread me' makes her drop the reading, and she says so", () => {
    affect.observePrompt("bahut udaas hu");
    affect.observePrompt("sab bekaar lag raha hai, udaas hu");
    expect(affect.getSnapshot().user.low).toBeGreaterThan(0.3);
    const said = correctMoodReading("tumne galat padha, main udaas nahi hu");
    expect(said).toMatch(/hata diya/i);
    expect(affect.getSnapshot().user.low).toBe(0);
    expect(affect.moodTrend().carrying).toBe(false);
  });

  it("a low mood changes how she is told to behave, and never lets her claim to feel it", () => {
    affect.observePrompt("bahut udaas hu aaj");
    const prompt = affect.prompt();
    expect(prompt).toMatch(/low or tired/i);
    expect(prompt).toMatch(/do not claim to feel what he feels/i);
    expect(prompt).toMatch(/simulated/i);
    expect(affect.getSnapshot().mood).toBe("empathetic");
  });
});

describe("which language she answers in", () => {
  it("English words that look like Hinglish do not flip the reply language", async () => {
    const { registerOf } = await import("../../src/lib/friday/response-policy");
    expect(registerOf("open the main file")).toBe("en");
    expect(registerOf("I am tired")).toBe("en");
    expect(registerOf("main kaisa lag raha hoon")).toBe("hinglish");
    expect(registerOf("मैं थक गया हूँ")).toBe("hi");
  });
});
