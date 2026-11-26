/**
 * Spoken numbers written as digits (`voice.itn`, default on) run after FRIDAY Tidy on the shown line only, and every
 * heard line is counted against the script policy.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ScriptPolicyTally,
  shapeHeardText,
} from "../../src/lib/friday/voice-engine/stream-session";
import { DEFAULT_PREFERENCES } from "../../src/lib/friday/preferences";

const modeSource = readFileSync(
  resolve(__dirname, "../../src/lib/friday/assistant-mode.ts"),
  "utf8",
);
const heard = "fifty percent and five hundred rupees at half past three";

describe("ITN after tidy, behind voice.itn", () => {
  it("is on by default", () => {
    expect(DEFAULT_PREFERENCES.voice.itn).toBe(true);
  });

  it("writes spoken numbers as digits and keeps the heard line as raw", () => {
    const out = shapeHeardText(heard, { tidy: true, itn: true, requested: "en-US" });
    expect(out.text).toBe("50% and ₹500 at 3:30");
    expect(out.tidy?.raw).toBe(heard);
  });

  it("off leaves the numbers as spoken", () => {
    const out = shapeHeardText(heard, { tidy: false, itn: false });
    expect(out).toEqual({ text: heard });
  });

  it("the pure shaper also runs alone, and an empty line stays empty", () => {
    expect(shapeHeardText(heard, { tidy: false, itn: true }).text).toBe("50% and ₹500 at 3:30");
    expect(shapeHeardText("", { tidy: true, itn: true })).toEqual({ text: "" });
  });

  it("the conductor shapes only the shown line, with itn read from the setting", () => {
    const body = modeSource.slice(
      modeSource.indexOf("private tidyShown("),
      modeSource.indexOf("private readonly scriptTally"),
    );
    expect(body).toMatch(/return shapeHeardText\(heard, \{/);
    // Tidy off keeps the heard words exactly (the FRIDAY Tidy contract); ITN runs after Tidy.
    expect(body).toMatch(
      /if \(voice\.tidyDictation === false\) return \{ text: heard \};\s*\/\/[^\n]*\n\s*return shapeHeardText/,
    );
    expect(body).toMatch(/tidy: true,/);
    expect(body).toMatch(/itn: voice\.itn !== false,/);
    // The command that reaches the Brain is the heard line; only the caption takes the shaped text.
    expect(modeSource).toMatch(/const shown = this\.tidyShown\(command\);/);
  });
});

describe("script policy counted", () => {
  it("counts violations over a bounded window", () => {
    const tally = new ScriptPolicyTally(2);
    expect(tally.note("कल meeting है", "hi").clean).toBe(true);
    expect(tally.note("yaar कल", "hi").clean).toBe(false);
    tally.note("hello there", "en");
    const sum = tally.summary();
    expect(sum.samples).toBe(2);
    expect(sum.violating).toBe(1);
  });

  it("every final heard in Auto mode is noted, and a violation is traced as counts", () => {
    const final = modeSource.slice(modeSource.indexOf("onFinal: (text, meta) => {"));
    expect(final).toMatch(/const check = this\.scriptTally\.note\(/);
    expect(final).toMatch(/if \(!check\.clean\) \{/);
  });
});
