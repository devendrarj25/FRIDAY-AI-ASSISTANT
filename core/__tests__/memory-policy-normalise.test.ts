/**
 * Speech-to-text writes a secret the way people say it: spaced letters, dotted letters, Devanagari
 * digits, a Hindi word beside a Roman one. One normalise step (config/sensitive-markers.json) folds
 * those into the text the markers read, and a bare word with no value stays ordinary.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  considerMemory,
  looksSensitive,
  normaliseSensitiveText,
} from "../../src/lib/friday/brain/memory-policy";

const lines = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures", "sensitive-lines.json"), "utf8"),
) as { normalise: [string, string][] };

describe("normaliseSensitiveText", () => {
  it.each(lines.normalise)("%s -> %s", (input, expected) => {
    expect(normaliseSensitiveText(input)).toBe(expected);
  });

  it("is safe on empty and non-text input", () => {
    expect(normaliseSensitiveText("")).toBe("");
    expect(normaliseSensitiveText(undefined as unknown as string)).toBe("");
  });
});

describe("what speech-to-text writes for a secret is SENSITIVE", () => {
  it.each([
    "OTP है 482913",
    "mera O T P 482913",
    "मेरा ओ.टी.पी. 482913",
    "Password hai mera 4821",
    "pass word hai 4821",
    "ओ टी पी १२३४५६ आया",
    "मेरा \uff4f\uff54\uff50 \uff14\uff18\uff12\uff19\uff11\uff13 आया है",
  ])("%s", (line) => {
    expect(looksSensitive(line)).toBe(true);
    expect(considerMemory({ text: line }).keep).toBe(false);
    expect(considerMemory({ text: line }).reason).toContain("sensitive");
  });
});

describe("a bare Hindi word with no value stays ordinary", () => {
  it.each([
    "पासवर्ड बदलने का तरीका क्या है?",
    "कल की बैठक गुप्त रखना",
    "टोकन नंबर 45 कब आएगा?",
    "मेरा आधार कब बना?",
  ])("%s", (line) => {
    expect(looksSensitive(line)).toBe(false);
    expect(considerMemory({ text: line }).reason).not.toContain("sensitive");
  });

  it("a six-digit PIN code stays a postal code and a four-digit PIN stays a secret", () => {
    expect(looksSensitive("my pin code is 110001")).toBe(false);
    expect(looksSensitive("मेरा पिन कोड है 110001")).toBe(false);
    expect(looksSensitive("my pin is 4821")).toBe(true);
    expect(looksSensitive("मेरा पिन 4821 है")).toBe(true);
  });
});
