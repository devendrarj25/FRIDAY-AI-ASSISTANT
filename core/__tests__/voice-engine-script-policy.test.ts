/** Transcript script policy: the TypeScript policy matches the shared Hinglish fixtures (the Python test reads the same file). */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scriptPolicy } from "../../src/lib/friday/voice-engine/language-segmenter";

type Fixture = { requested: string; cases: Array<{ input: string; expected: unknown }> };
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/voice-hinglish-script.json"), "utf8"),
) as Fixture;

describe("script policy", () => {
  it("covers at least 40 Hinglish fixtures", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(40);
  });

  it("matches the shared fixture for every sentence", () => {
    for (const c of fixture.cases) {
      expect(scriptPolicy(c.input, fixture.requested), c.input).toEqual(c.expected);
    }
  });

  it("keeps the text as spoken and tags Hindi, English and mixed", () => {
    const mixed = scriptPolicy("Chrome खोलो और report भेजो");
    expect(mixed.text).toBe("Chrome खोलो और report भेजो");
    expect(mixed.lang).toBe("mixed");
    expect(scriptPolicy("आज मौसम अच्छा है।").lang).toBe("hi");
    expect(scriptPolicy("What time is it?").lang).toBe("en");
  });

  it("reports Roman Hindi and never rewrites it into Devanagari", () => {
    const p = scriptPolicy("mujhe chai chahiye");
    expect(p.romanHindi).toBe(true);
    expect(p.segments[0]?.script).toBe("roman-hindi");
    expect(p.text).toBe("mujhe chai chahiye");
    expect(/[ऀ-ॿ]/.test(JSON.stringify(p))).toBe(false);
  });

  it("does not call ordinary English Roman Hindi", () => {
    expect(scriptPolicy("The main thing is to do it").romanHindi).toBe(false);
  });

  it("keeps apostrophes, numbers and Devanagari digits whole, and empty text empty", () => {
    expect(scriptPolicy("don't go").segments[0]?.words.map((w) => w.text)).toEqual(["don't", "go"]);
    expect(scriptPolicy("मुझे ३ बजे").segments[0]?.words.map((w) => w.kind)).toEqual([
      "hi",
      "number",
      "hi",
    ]);
    expect(scriptPolicy("   ").segments).toEqual([]);
    expect(scriptPolicy("", "hi-IN").lang).toBe("hi");
  });
});
