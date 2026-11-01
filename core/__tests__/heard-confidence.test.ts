import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONFIRM_BELOW,
  heardConfidence,
  heardQualityLine,
  speechModelHint,
  heardReadBack,
  needsHeardConfirmation,
  utteranceConfidence,
} from "../../src/lib/friday/asr-bias";

describe("how far a heard sentence is trusted", () => {
  it("before: a made-up fluent sentence scored as high as a real one, because only the words were looked at", () => {
    expect(utteranceConfidence("I'm going to get a car.")).toBe(0.9);
    expect(utteranceConfidence("chrome kholo")).toBe(0.9);
  });

  it("a weak guess about the language lowers it, and so does a weak per-token score", () => {
    expect(
      heardConfidence("I'm going to get a car.", { languageProbability: 0.65, avgLogprob: -0.9 }),
    ).toBe(0.6);
    expect(heardConfidence("open notepad", { languageProbability: 0.8, avgLogprob: -0.3 })).toBe(
      0.75,
    );
    expect(heardConfidence("open notepad", { languageProbability: 0.99, avgLogprob: -0.55 })).toBe(
      0.8,
    );
    expect(heardConfidence("open notepad", { languageProbability: 0.99, avgLogprob: -1.2 })).toBe(
      0.4,
    );
  });

  it("clear speech, or an engine that reported nothing, is trusted as before", () => {
    expect(
      heardConfidence("Friday, what time is it", { languageProbability: 0.98, avgLogprob: -0.18 }),
    ).toBe(0.9);
    expect(heardConfidence("Friday, what time is it", null)).toBe(0.9);
    expect(
      heardConfidence("Friday, what time is it", { avgLogprob: null, languageProbability: null }),
    ).toBe(0.9);
  });

  it("the words are read back only when the model was unsure, and never for a stop", () => {
    const unsure = { languageProbability: 0.65, avgLogprob: -0.9 };
    expect(heardConfidence("x y z", unsure)).toBeLessThan(CONFIRM_BELOW);
    expect(needsHeardConfirmation("delete the invoice folder", unsure)).toBe(true);
    expect(needsHeardConfirmation("stop", unsure, true)).toBe(false);
    expect(needsHeardConfirmation("", unsure)).toBe(false);
    expect(
      needsHeardConfirmation("delete the invoice folder", {
        languageProbability: 0.97,
        avgLogprob: -0.25,
      }),
    ).toBe(false);
    expect(
      needsHeardConfirmation("open notepad", { languageProbability: 0.8, avgLogprob: -0.3 }),
    ).toBe(false);
  });

  it("the read-back is in the language the words were in", () => {
    expect(heardReadBack("open notepad")).toBe("Did you say “open notepad”? Say yes or no.");
    expect(heardReadBack("chrome kholo yaar")).toMatch(/^Kya aapne kaha: “chrome kholo yaar”\?/);
    expect(heardReadBack("क्रोम खोलो")).toBe("क्या आपने कहा: “क्रोम खोलो”?");
    expect(heardReadBack("a".repeat(300)).length).toBeLessThan(140);
  });
});

describe("the read-back is wired into the live voice path", () => {
  const mode = readFileSync("src/lib/friday/assistant-mode.ts", "utf8");
  const stt = readFileSync("src/lib/friday/voice-stt.ts", "utf8");
  const bridge = readFileSync("electron/stt.cjs", "utf8");

  it("the speech model's scores travel from the kernel to the voice session", () => {
    expect(bridge).toContain("languageProbability");
    expect(bridge).toContain("avgLogprob");
    expect(stt).toContain("quality: {");
    expect(mode).toContain("this.lastHeardQuality = meta?.quality ?? null;");
  });

  it("an addressed command is held for a yes when the model was unsure, a stop is not, and a yes or no is answered", () => {
    expect(mode).toContain(
      "needsHeardConfirmation(command, this.lastHeardQuality, isStopCommand(command))",
    );
    expect(mode).toContain("this.pendingHeard = { command, at: Date.now() };");
    expect(mode).toContain('markTurnStage("routed", false, "read back — waiting for a yes");');
    expect(mode).toContain("this.dispatch(readBack.command);");
    expect(mode).toContain("HEARD_CONFIRM_MS");
  });

  it("the read-back is not counted as a dropped utterance", () => {
    const gate = mode.slice(
      mode.indexOf("needsHeardConfirmation(command"),
      mode.indexOf("needsHeardConfirmation(command") + 900,
    );
    expect(gate).not.toContain("dropLine");
  });
});

describe("what the diagnostics say about how sure she was", () => {
  it("shows the language guess, the token score, the trust and whether it was read back", () => {
    expect(heardQualityLine(null)).toBe("no utterance heard yet");
    expect(
      heardQualityLine(
        { language: "en", languageProbability: 0.65, avgLogprob: -0.9 },
        "I'm going to get a car.",
      ),
    ).toBe("language en (0.65) · token score -0.90 · trust 0.60 · read back before acting");
    expect(
      heardQualityLine(
        { language: "hi", languageProbability: 0.99, avgLogprob: -0.2 },
        "chrome kholo",
      ),
    ).toBe("language hi (0.99) · token score -0.20 · trust 0.90");
  });

  it("names a small model as the likely reason for wrong Hindi, only when it applies", () => {
    expect(speechModelHint("D:\\FRIDAY\\cache\\stt\\base", "en-IN")).toMatch(
      /base model is small for Hindi and Hinglish/,
    );
    expect(speechModelHint("tiny", "hi-IN")).toMatch(/tiny model/);
    expect(speechModelHint("small", "hi-IN")).toBe("");
    expect(speechModelHint("base", "en-US")).toBe("");
    expect(speechModelHint("", "hi-IN")).toBe("");
  });
});
