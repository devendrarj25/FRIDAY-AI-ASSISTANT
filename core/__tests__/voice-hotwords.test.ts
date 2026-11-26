/** The streaming ear's hotword list: real sources only, trimmed, deduplicated, at most 64 of at most 40 characters. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  STREAM_HOTWORDS_MAX,
  STREAM_HOTWORD_CHARS,
  streamHotwords,
} from "../../src/lib/friday/voice-engine/hotwords";

const modeSource = readFileSync(
  resolve(__dirname, "../../src/lib/friday/assistant-mode.ts"),
  "utf8",
);

describe("stream hotwords", () => {
  it("none when there is no source", () => {
    expect(streamHotwords(undefined)).toEqual([]);
    expect(streamHotwords({})).toEqual([]);
    expect(
      streamHotwords({ names: ["", "  ", null, undefined], contacts: [], apps: null }),
    ).toEqual([]);
  });

  it("takes names, contacts, app names and the dictionary in that order", () => {
    expect(
      streamHotwords({
        names: ["FRIDAY", "Devendra"],
        contacts: ["Rahul Sharma", "मीना"],
        apps: ["Visual Studio Code", "Chrome"],
        vocabulary: ["kubectl"],
      }),
    ).toEqual([
      "FRIDAY",
      "Devendra",
      "Rahul Sharma",
      "मीना",
      "Visual Studio Code",
      "Chrome",
      "kubectl",
    ]);
  });

  it("trims, folds whitespace and control characters, and dedupes without regard to case", () => {
    expect(
      streamHotwords({
        names: ["  FRIDAY  ", "friday"],
        contacts: ["Rahul\t\nSharma", "rahul sharma"],
        apps: ["Chrome\u0000", "CHROME", "Note\u200bpad"],
      }),
    ).toEqual(["FRIDAY", "Rahul Sharma", "Chrome", "Note pad"]);
  });

  it("drops entries over 40 characters instead of cutting them", () => {
    const long = "x".repeat(STREAM_HOTWORD_CHARS + 1);
    const edge = "y".repeat(STREAM_HOTWORD_CHARS);
    expect(streamHotwords({ apps: [long, edge] })).toEqual([edge]);
    expect(STREAM_HOTWORD_CHARS).toBe(40);
  });

  it("stops at 64, names first", () => {
    const contacts = Array.from({ length: 100 }, (_, i) => `Contact ${i}`);
    const out = streamHotwords({ names: ["FRIDAY"], contacts, apps: ["Chrome"] });
    expect(STREAM_HOTWORDS_MAX).toBe(64);
    expect(out).toHaveLength(64);
    expect(out[0]).toBe("FRIDAY");
    expect(out).not.toContain("Chrome");
    expect(new Set(out.map((w) => w.toLowerCase())).size).toBe(out.length);
  });

  it("the conductor builds the list from the owner's names and dictionary for the stream plan", () => {
    const plan = modeSource.slice(
      modeSource.indexOf("private streamPlan()"),
      modeSource.indexOf("private streamPlan()") + 700,
    );
    expect(plan).toMatch(/hotwords: streamHotwords\(\{/);
    expect(plan).toMatch(/names: \[voice\.addressName, voice\.wakeWord\]/);
    expect(plan).toMatch(/vocabulary: parseVocabulary\(voice\.vocabulary\)/);
  });
});
