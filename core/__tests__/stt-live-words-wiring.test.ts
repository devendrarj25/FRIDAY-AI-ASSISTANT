import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const stt = require("../../electron/stt.cjs");
const source = readFileSync("electron/stt.cjs", "utf8").replace(/\r\n/g, "\n");

describe("a live pass in the speech bridge", () => {
  it("asks the worker for the lean live path only for a provisional read", () => {
    expect(stt.decodeExtras({ provisional: true, livePass: true, utteranceId: "live-3" })).toEqual({
      provisional: true,
      utteranceId: "live-3",
      live: true,
    });
    // a final decode can never be turned into a live one by a flag
    expect(stt.decodeExtras({ livePass: true, utteranceId: "live-3" })).toEqual({});
    expect(stt.decodeExtras({ provisional: true, utteranceId: "live-3" })).toEqual({
      provisional: true,
      utteranceId: "live-3",
    });
  });

  it("gives back only clean, bounded timed words and segments", () => {
    const out = stt.liveReplyFields({
      words: [
        { text: "open", start: 0.1, end: 0.4 },
        { text: "", start: 0.5, end: 0.6 },
        { text: "x", start: Number.NaN, end: 1 },
        { text: "यह", start: "1", end: 2 },
        { text: "a".repeat(200), start: 1, end: 2 },
        "junk",
        null,
      ],
      segments: [{ start: 0, end: 1.2 }, { start: 3 }, 5],
    });
    expect(out.words.map((w: { text: string }) => w.text)).toEqual(["open", "a".repeat(64)]);
    expect(out.segments).toEqual([{ start: 0, end: 1.2 }]);
  });

  it("is empty for a reply with no words, and bounds a runaway list", () => {
    expect(stt.liveReplyFields({ text: "plain" })).toEqual({});
    const many = Array.from({ length: 900 }, (_, i) => ({ text: `w${i}`, start: i, end: i + 0.5 }));
    expect(stt.liveReplyFields({ words: many }).words).toHaveLength(400);
  });

  it("reads a live pass with the worker that is already loaded, never loading or switching a model", () => {
    expect(
      stt.liveModel(
        { livePass: true, provisional: true, model: "large-v3" },
        { alive: true, loaded: true, modelName: "small" },
      ),
    ).toBe("small");
    expect(stt.liveModel({ livePass: true, provisional: true }, null)).toBe("");
    expect(
      stt.liveModel(
        { provisional: true, model: "base" },
        { alive: true, loaded: true, modelName: "small" },
      ),
    ).toBe("");
  });

  it("is wired: the reply carries the words, and an engine that cannot read early says so", () => {
    expect(source).toMatch(/\.\.\.liveReplyFields\(parsed\)/);
    expect(source).toMatch(/reason: "not-ready", \.\.\.EARLY_READ_UNSUPPORTED/);
    expect(source).toMatch(/EARLY_READ_UNSUPPORTED = \{[^}]*unsupportedEngine: true/);
    expect(source).toMatch(/liveModel\(req, worker\)/);
    expect(source).toMatch(/load: !ladderEngine && !liveWith/);
  });
});
