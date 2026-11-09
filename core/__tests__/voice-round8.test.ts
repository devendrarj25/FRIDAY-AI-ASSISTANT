/**
 * Round 8: a spoken approval can never be a yes when it also says no, Hinglish answers count, the wake name
 * with a possessive is cleaned, she does not talk over herself, and the self-check does not load a second model.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { assistantMode } from "../../src/lib/friday/assistant-mode";
import { confirmationVerdict } from "../../src/lib/friday/voice-session";
import { matchWakeWord } from "../../src/lib/friday/wake-word";

describe("a spoken approval", () => {
  it("is a yes only when nothing in it says no", () => {
    for (const yes of [
      "yes",
      "yes do it",
      "haan",
      "haan kar do",
      "ha kar do",
      "theek hai kar do",
      "kar do",
      "okay go ahead",
      "ji bilkul",
      "sure",
      "Yes!",
    ])
      expect(confirmationVerdict(yes), yes).toBe("yes");
  });

  it("is a no whenever it says no, even next to a yes", () => {
    for (const no of [
      "no",
      "nahi",
      "nahi mat karo",
      "mat karo",
      "ruko",
      "rehne do",
      "cancel",
      "okay cancel that",
      "ok nahi",
      "haan nahi",
      "yes no wait",
      "don't do it",
      "ok stop",
      "na",
    ])
      expect(confirmationVerdict(no), no).toBe("no");
  });

  it("treats the particle na in a request as part of it, not as a refusal", () => {
    expect(confirmationVerdict("kar do na")).toBe("yes");
    expect(confirmationVerdict("haan na")).toBe("yes");
  });

  it("is unclear for everything else, so nothing runs", () => {
    for (const other of ["", "what time is it", "maybe", "open notepad", "hmm"])
      expect(confirmationVerdict(other), other).toBe("unclear");
  });

  it("is the one rule at every approval site", () => {
    const mode = readFileSync("src/lib/friday/assistant-mode.ts", "utf8");
    expect(mode).not.toMatch(/\bAFFIRM\b|\bDENY\b/);
    expect(mode.match(/confirmationVerdict\(/g)?.length).toBeGreaterThanOrEqual(6);
  });
});

describe("the wake name", () => {
  it("drops the possessive left behind by speech recognition", () => {
    expect(matchWakeWord("Friday's open notepad").command).toBe("open notepad");
    expect(matchWakeWord("friday s open notepad").command).toBe("open notepad");
    expect(matchWakeWord("Friday open notepad").command).toBe("open notepad");
  });
});

type Driver = {
  state: { speaking: boolean } & Record<string, unknown>;
  handleHeard: (text: string) => void;
  dispatch: (command: string) => void;
  cancelSpeech: () => void;
  speak: (text: string) => void;
  emit: () => void;
  spokenText: string;
  echoUntil: number;
  followUpUntil: number;
  awakeUntil: number;
  backchannelUsed: boolean;
  lastWakeAt: number;
};
const d = assistantMode as unknown as Driver;
(globalThis as unknown as { window?: unknown }).window ??= globalThis;

describe("she does not talk over herself", () => {
  let spoken: string[] = [];
  beforeEach(() => {
    spoken = [];
    Object.assign(d.state, {
      mode: "auto",
      paused: false,
      muted: false,
      speaking: false,
      handsFree: false,
      pending: null,
    });
    d.spokenText = "";
    d.echoUntil = 0;
    d.followUpUntil = 0;
    d.awakeUntil = 0;
    d.backchannelUsed = false;
    d.lastWakeAt = 0;
    d.dispatch = () => undefined;
    d.cancelSpeech = () => undefined;
    d.speak = (t: string) => void spoken.push(t);
    d.emit = () => undefined;
  });

  it("stays quiet for 'haan' while she is speaking", () => {
    d.state.speaking = true;
    d.spokenText = "I have opened the calendar and found three meetings today";
    d.followUpUntil = Date.now() + 8000;
    d.awakeUntil = Date.now() + 8000;
    d.handleHeard("haan");
    expect(spoken).toEqual([]);
  });

  it("still holds with 'Mm-hmm' when the owner pauses mid-request and she is not speaking", () => {
    d.handleHeard("Friday uh");
    expect(spoken).toEqual(["Mm-hmm."]);
  });
});

describe("the voice check does not load a second speech model", () => {
  it("looks at a ready engine without loading it again", () => {
    const mode = readFileSync("src/lib/friday/assistant-mode.ts", "utf8");
    expect(mode).toContain("loadModel: !this.state.stt.ready");
    expect(mode).toContain("loadModel: options.loadModel !== false");
  });
});

describe("every wording of a cancel and an expiry still says what happened", () => {
  it("each variant, in every register, says nothing ran or that the approval ran out", async () => {
    const { vary, resetAntiRepeat } = await import("../../src/lib/friday/brain/anti-repeat");
    const cancelled = /nothing (was executed|ran|was done|happened)|kuch .*nahi|कुछ नहीं/i;
    const expired = /expire|timed out|timeout|nikal gaya|समाप्त|समय निकल/i;
    for (const register of ["en", "hinglish", "hi"] as const) {
      for (let step = 0; step < 12; step += 1) {
        resetAntiRepeat();
        const roll = step / 12;
        expect(
          vary("cancelled", { register, chance: () => roll }),
          `cancelled ${register} ${step}`,
        ).toMatch(cancelled);
        resetAntiRepeat();
        expect(
          vary("expired", { register, chance: () => roll }),
          `expired ${register} ${step}`,
        ).toMatch(expired);
      }
    }
  });
});
