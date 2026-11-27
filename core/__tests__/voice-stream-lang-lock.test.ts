import { describe, expect, it } from "vitest";
import {
  TurnTracker,
  buildTurnRecord,
  parseStreamTurn,
  preferStreamLang,
  STREAM_LANG_MIN_CONF,
  type TurnLang,
} from "../../src/lib/friday/voice-engine/stream-session";

const base = { turnId: "t1", event: "end", text: "hello", vadP: 0.9, speechMs: 800 };

describe("parseStreamTurn language lock", () => {
  it("keeps today's shape when the ear sends no language keys", () => {
    const turn = parseStreamTurn(base);
    expect(turn).toEqual({ turnId: "t1", event: "end", text: "hello", vadP: 0.9, speechMs: 800 });
  });

  it("reads lang, langConf and langLocked", () => {
    const turn = parseStreamTurn({ ...base, lang: "hi", langConf: 0.82, langLocked: true });
    expect(turn?.lang).toBe("hi");
    expect(turn?.langConf).toBe(0.82);
    expect(turn?.langLocked).toBe(true);
  });

  it("clamps the confidence and drops a wrong shape", () => {
    expect(parseStreamTurn({ ...base, lang: "en", langConf: 7 })?.langConf).toBe(1);
    expect(parseStreamTurn({ ...base, lang: "en", langConf: -2 })?.langConf).toBe(0);
    const bad = parseStreamTurn({ ...base, lang: "fr", langConf: "x", langLocked: "yes" });
    expect(bad).not.toBeNull();
    expect(bad?.lang).toBeUndefined();
    expect(bad?.langConf).toBeUndefined();
    expect(bad?.langLocked).toBeUndefined();
  });
});

describe("preferStreamLang", () => {
  const table: [TurnLang, "hi" | "en" | undefined, number | null | undefined, TurnLang][] = [
    ["en", "hi", 0.9, "hi"],
    ["hi", "en", 0.6, "en"],
    ["en", "hi", 0.59, "en"],
    ["en", "hi", null, "en"],
    ["en", "hi", undefined, "en"],
    ["en", undefined, 0.99, "en"],
    ["hi-en", "hi", 0.95, "hi"],
    ["", "en", 0.8, "en"],
    ["hi", "hi", 0.9, "hi"],
    ["en", "hi", Number.NaN, "en"],
  ];
  it.each(table)("heuristic %s, stream %s conf %s gives %s", (h, s, c, want) => {
    expect(preferStreamLang(h, s, c)).toBe(want);
  });
  it("uses a 0.6 floor", () => {
    expect(STREAM_LANG_MIN_CONF).toBe(0.6);
  });
});

describe("TurnRecord streamLang", () => {
  const tracker = (lang: Record<string, unknown>) => {
    const t = new TurnTracker();
    const turn = parseStreamTurn({ ...base, ...lang });
    if (!turn) throw new Error("turn");
    t.ingest(turn, 1000);
    return t.take(1100);
  };

  it("adds streamLang only when locked with conf >= 0.6", () => {
    const facts = tracker({ lang: "hi", langConf: 0.7, langLocked: true });
    expect(buildTurnRecord({ text: "hello there", facts }).streamLang).toBe("hi");
  });

  it("leaves the record unchanged when not locked or weak", () => {
    for (const lang of [
      { lang: "hi", langConf: 0.7, langLocked: false },
      { lang: "hi", langConf: 0.5, langLocked: true },
      {},
    ]) {
      const rec = buildTurnRecord({ text: "hello there", facts: tracker(lang) });
      expect("streamLang" in rec).toBe(false);
    }
  });

  it("keeps every v2 key", () => {
    const rec = buildTurnRecord({ text: "hello", facts: tracker({}) });
    expect(Object.keys(rec).sort()).toEqual(
      [
        "v",
        "canonical",
        "romanised",
        "spans",
        "asrBand",
        "eotWaitMs",
        "text",
        "textRaw",
        "lang",
        "mix",
        "confidence",
        "turnId",
        "eager",
        "speaker",
        "env",
        "clipped",
        "interruptedPlayedMs",
      ].sort(),
    );
  });
});
