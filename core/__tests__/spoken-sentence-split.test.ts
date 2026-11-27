import { describe, expect, it } from "vitest";

import { guardBoilerplate, preferSpoken } from "../../src/lib/friday/conversation-style";
import { splitSpokenSentences } from "../../src/lib/friday/voice-engine/language-segmenter";
import { spokenSummary } from "../../src/lib/friday/voice-library";

describe("one spoken-sentence splitter", () => {
  it("never cuts inside a decimal, a version, a price or an abbreviation", () => {
    expect(splitSpokenSentences("Send 2,500.50 rupees to Rahul. Say yes to confirm.")).toEqual([
      "Send 2,500.50 rupees to Rahul.",
      "Say yes to confirm.",
    ]);
    expect(splitSpokenSentences("Version 1.2.5.8 aa gaya hai. Aur kuch?")).toEqual([
      "Version 1.2.5.8 aa gaya hai.",
      "Aur kuch?",
    ]);
    expect(splitSpokenSentences("temperature 32.5 degree hai. Baarish nahi hogi.")).toEqual([
      "temperature 32.5 degree hai.",
      "Baarish nahi hogi.",
    ]);
    expect(splitSpokenSentences("Price is ₹3.5 only. Okay.")).toEqual([
      "Price is ₹3.5 only.",
      "Okay.",
    ]);
    expect(splitSpokenSentences("Please ask Dr. Singh. Then call.")).toEqual([
      "Please ask Dr. Singh.",
      "Then call.",
    ]);
    expect(splitSpokenSentences("तापमान ३२.५ डिग्री है। बारिश नहीं होगी।")).toEqual([
      "तापमान ३२.५ डिग्री है।",
      "बारिश नहीं होगी।",
    ]);
  });

  it("returns nothing for blank text", () => {
    expect(splitSpokenSentences("   ")).toEqual([]);
  });
});

describe("spoken text keeps what was said", () => {
  it("keeps the confirmation tail of an amount line (no '2,500. 50' re-join)", () => {
    const line = "Send 2,500.50 rupees to Rahul. Say yes to confirm.";
    expect(preferSpoken(line)).toBe(line);
    expect(guardBoilerplate(line)).toBe(line);
    expect(spokenSummary(line)).toBe(line);
  });

  it("keeps versions and decimals whole in English, Hinglish and Hindi", () => {
    expect(preferSpoken("Version 1.2.5.8 aa gaya hai. Aur kuch?")).toBe(
      "Version 1.2.5.8 aa gaya hai. Aur kuch?",
    );
    expect(preferSpoken("temperature 32.5 degree hai. Baarish nahi hogi. Chhata lo.")).toBe(
      "temperature 32.5 degree hai. Baarish nahi hogi.",
    );
    expect(preferSpoken("कीमत ₹3.5 है। ठीक है। तीसरा।")).toBe("कीमत ₹3.5 है। ठीक है।");
    expect(preferSpoken("Ask Dr. Singh today. Then rest. Third.")).toBe(
      "Ask Dr. Singh today. Then rest.",
    );
    expect(spokenSummary("Reading is 32.5 degrees. Rain is unlikely. Third stays off.")).toBe(
      "Reading is 32.5 degrees. Rain is unlikely.",
    );
  });

  it("a direct count answer is not silenced as boilerplate", () => {
    expect(preferSpoken("12 memories saved hain")).toBe("12 memories saved hain");
    expect(preferSpoken("I have 120 memories saved.")).toBe("I have 120 memories saved.");
    expect(guardBoilerplate("Three agents are running.")).toBe("Three agents are running.");
    // The stock phrases stay filtered.
    expect(guardBoilerplate("Agents standing by. The file is saved.")).toBe("The file is saved.");
  });

  it("says a short 'on screen' line when the whole reply was stock filler", () => {
    expect(preferSpoken("As an AI, I'm here to help.")).toBe("It is on screen.");
    expect(preferSpoken("")).toBe("");
  });

  it("can skip the two-sentence and 320-character cap", () => {
    const four = "One is here. Two is here. Three is here. Four is here.";
    expect(preferSpoken(four)).toBe("One is here. Two is here.");
    expect(preferSpoken(four, { uncapped: true })).toBe(four);
    const long = Array.from({ length: 9 }, (_, i) => `Sentence number ${i + 1} is spoken in full.`);
    const text = long.join(" ");
    expect(text.length).toBeGreaterThan(320);
    expect(spokenSummary(text).length).toBeLessThanOrEqual(320);
    expect(spokenSummary(text, { uncapped: true })).toBe(text);
  });
});
