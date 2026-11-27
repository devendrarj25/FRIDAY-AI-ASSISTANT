import { describe, expect, it } from "vitest";

import { isSelfEchoTranscript, isWakeToken, matchWakeWord } from "../../src/lib/friday/wake-word";

describe("wake word spellings an ear really writes", () => {
  it("accepts the Devanagari variants, the nukta form included", () => {
    for (const spelling of ["फ्रीडे", "फ़्राइडे", "फ्राइडे", "फ़्राईडे", "फ्रायडे"]) {
      expect(isWakeToken(spelling, "friday"), spelling).toBe(true);
    }
    expect(isWakeToken("फ्राइ", "friday")).toBe(false);
  });

  it("wakes on a Devanagari name inside a Hindi command", () => {
    const hit = matchWakeWord("फ्रीडे यूट्यूब खोलो", "friday");
    expect(hit.matched).toBe(true);
    expect(hit.leading).toBe(true);
    expect(hit.command).toBe("यूट्यूब खोलो");
  });

  it("joins two tokens that the ear split: 'fry day', 'फ्राई डे'", () => {
    const hit = matchWakeWord("hey fry day open notepad", "friday");
    expect(hit.matched).toBe(true);
    expect(hit.leading).toBe(true);
    expect(hit.command).toBe("open notepad");
    expect(matchWakeWord("फ्राई डे समय क्या है", "friday").command).toBe("समय क्या है");
    // ordinary words that do not make the name stay ordinary
    expect(matchWakeWord("fry the rice today", "friday").matched).toBe(false);
  });

  it("keeps the real tolerance: one slip wakes, two do not", () => {
    for (const ok of ["fridey", "frday", "fridy", "Friday,"])
      expect(isWakeToken(ok, "friday")).toBe(true);
    for (const no of ["freeday", "frydey", "fraidy"]) expect(isWakeToken(no, "friday")).toBe(false);
  });
});

describe("her own voice coming back through the microphone, in either script", () => {
  it("Roman Hindi spoken, Devanagari heard", () => {
    expect(
      isSelfEchoTranscript("ठीक है मैं अभी करती हूँ", "theek hai main abhi karti hoon", {
        speaking: true,
      }),
    ).toBe(true);
  });

  it("Devanagari spoken, Roman heard", () => {
    expect(
      isSelfEchoTranscript("kya aap mujhe sun rahe hain", "क्या आप मुझे सुन रहे हैं", {
        speaking: true,
      }),
    ).toBe(true);
  });

  it("the owner's different words in the other script are not an echo", () => {
    expect(
      isSelfEchoTranscript("मुझे संगीत बजाओ", "theek hai main abhi karti hoon", { speaking: true }),
    ).toBe(false);
  });

  it("the existing same-script rules still hold", () => {
    expect(isSelfEchoTranscript("open it now", "Do you want me to open it now?", {})).toBe(true);
    expect(
      isSelfEchoTranscript("open it", "Do you want me to open it now?", { speaking: false }),
    ).toBe(false);
  });
});
