/**
 * The expected-answer estimator: the pure rule that tells the instant acknowledgement how long the real answer will
 * take, from what this session measured (a rolling median of the first-clause time per lane) or from fixed priors.
 * No clock, no timer: every case feeds plain numbers.
 */
import { describe, expect, it } from "vitest";
import {
  EXPECTED_HISTORY_CAP,
  EXPECTED_MIN_SAMPLES,
  EXPECTED_PRIORS,
  ackLane,
  expectedAnswerMs,
  recordFirstClause,
  type FirstClauseHistory,
} from "../../src/lib/friday/voice-engine/expected-answer";
import { ackWanted } from "../../src/lib/friday/voice-engine/brain-bridge";

const base = { kind: "foreground-turn", toolsLikely: false, history: {} as FirstClauseHistory };

describe("priors", () => {
  it("a command is always instant", () => {
    expect(expectedAnswerMs({ ...base, lane: "command" })).toBe(0);
    expect(expectedAnswerMs({ ...base, lane: "command", toolsLikely: true })).toBe(0);
  });

  it("quick is 800, full is 2500, and full with tools is 4000", () => {
    expect(EXPECTED_PRIORS).toEqual({ quick: 800, full: 2500, tools: 4000 });
    expect(expectedAnswerMs({ ...base, lane: "quick" })).toBe(800);
    expect(expectedAnswerMs({ ...base, lane: "full" })).toBe(2500);
    expect(expectedAnswerMs({ ...base, lane: "full", toolsLikely: true })).toBe(4000);
  });

  it("tools do not raise the quick lane prior", () => {
    expect(expectedAnswerMs({ ...base, lane: "quick", toolsLikely: true })).toBe(800);
  });

  it("the priors decide whether an acknowledgement is wanted: quick no, full yes", () => {
    const wanted = (lane: "quick" | "full") =>
      ackWanted({ lane, expectedMs: expectedAnswerMs({ ...base, lane }) as number });
    expect(wanted("quick")).toBe(false);
    expect(wanted("full")).toBe(true);
  });
});

describe("rolling median", () => {
  it("needs three samples before it replaces the prior", () => {
    expect(EXPECTED_MIN_SAMPLES).toBe(3);
    expect(expectedAnswerMs({ ...base, lane: "full", history: { full: [100, 200] } })).toBe(2500);
    expect(expectedAnswerMs({ ...base, lane: "full", history: { full: [100, 200, 300] } })).toBe(
      200,
    );
  });

  it("is the middle value of an odd count and the mean of the middle two of an even count", () => {
    expect(expectedAnswerMs({ ...base, lane: "full", history: { full: [900, 100, 500] } })).toBe(
      500,
    );
    expect(
      expectedAnswerMs({ ...base, lane: "full", history: { full: [100, 300, 500, 900] } }),
    ).toBe(400);
  });

  it("uses only the last eight samples", () => {
    expect(EXPECTED_HISTORY_CAP).toBe(8);
    const history = {
      full: [9000, 9000, 9000, 9000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000],
    };
    expect(expectedAnswerMs({ ...base, lane: "full", history })).toBe(1000);
  });

  it("keeps the lanes apart", () => {
    const history = { quick: [300, 300, 300], full: [3000, 3000, 3000] };
    expect(expectedAnswerMs({ ...base, lane: "quick", history })).toBe(300);
    expect(expectedAnswerMs({ ...base, lane: "full", history })).toBe(3000);
  });

  it("a measured median beats the tools prior", () => {
    const history = { full: [1000, 1100, 1200] };
    expect(expectedAnswerMs({ ...base, lane: "full", toolsLikely: true, history })).toBe(1100);
  });

  it("a command ignores any history", () => {
    expect(
      expectedAnswerMs({ ...base, lane: "command", history: { command: [5000, 5000, 5000] } }),
    ).toBe(0);
  });

  it("a fast measured lane turns the acknowledgement off, a slow one turns it on", () => {
    const fast = { full: [900, 1000, 1100] };
    const slow = { full: [2600, 2800, 3000] };
    const wanted = (history: FirstClauseHistory) =>
      ackWanted({
        lane: "full",
        expectedMs: expectedAnswerMs({ ...base, lane: "full", history }) as number,
      });
    expect(wanted(fast)).toBe(false);
    expect(wanted(slow)).toBe(true);
  });
});

describe("garbage input", () => {
  it("non-finite, negative and huge samples in the history are ignored", () => {
    const history = { full: [Number.NaN, Number.POSITIVE_INFINITY, -5, 70_000, 1000, 1200] };
    // Only two valid samples remain: the prior stands.
    expect(expectedAnswerMs({ ...base, lane: "full", history })).toBe(2500);
    const enough = { full: [Number.NaN, -1, 800, 1000, 1200] };
    expect(expectedAnswerMs({ ...base, lane: "full", history: enough })).toBe(1000);
  });

  it("a missing or odd history never throws and falls back to the prior", () => {
    expect(expectedAnswerMs({ ...base, lane: "full", history: undefined as never })).toBe(2500);
    expect(expectedAnswerMs({ ...base, lane: "full", history: { full: "x" as never } })).toBe(2500);
    expect(expectedAnswerMs({ ...base, lane: "full", history: { full: null as never } })).toBe(
      2500,
    );
  });

  it("an unknown lane is unknown (null), so the acknowledgement stays silent", () => {
    expect(expectedAnswerMs({ ...base, lane: "weird" as never })).toBeNull();
    expect(expectedAnswerMs(null as never)).toBeNull();
  });

  it("recordFirstClause ignores non-finite, negative and over 60000 values", () => {
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      60_001,
      "5" as never,
      undefined as never,
    ]) {
      const out = recordFirstClause({ full: [1000] }, "full", bad);
      expect(out).toEqual({ full: [1000] });
    }
    expect(recordFirstClause({}, "full", 0)).toEqual({ full: [0] });
    expect(recordFirstClause({}, "full", 60_000)).toEqual({ full: [60_000] });
  });

  it("recordFirstClause ignores the command lane and an unknown lane", () => {
    expect(recordFirstClause({}, "command", 500)).toEqual({});
    expect(recordFirstClause({}, "weird" as never, 500)).toEqual({});
  });
});

describe("recordFirstClause", () => {
  it("appends in order and caps each lane at eight, newest kept", () => {
    let history: FirstClauseHistory = {};
    for (let i = 1; i <= 12; i += 1) history = recordFirstClause(history, "full", i * 100);
    expect(history.full).toEqual([500, 600, 700, 800, 900, 1000, 1100, 1200]);
    history = recordFirstClause(history, "quick", 250);
    expect(history.quick).toEqual([250]);
    expect(history.full).toHaveLength(EXPECTED_HISTORY_CAP);
  });

  it("is immutable: the old history and its arrays are never changed", () => {
    const old: FirstClauseHistory = { full: [1, 2, 3] };
    const frozen = Object.freeze({
      full: Object.freeze([1, 2, 3]),
    }) as unknown as FirstClauseHistory;
    const next = recordFirstClause(old, "full", 4);
    expect(old).toEqual({ full: [1, 2, 3] });
    expect(next).not.toBe(old);
    expect(next.full).not.toBe(old.full);
    expect(() => recordFirstClause(frozen, "full", 4)).not.toThrow();
    expect(() => recordFirstClause(frozen, "quick", 4)).not.toThrow();
  });

  it("does not change the input of the estimator either", () => {
    const history = Object.freeze({
      full: Object.freeze([300, 100, 200]),
    }) as unknown as FirstClauseHistory;
    expect(expectedAnswerMs({ ...base, lane: "full", history })).toBe(200);
    expect(history.full).toEqual([300, 100, 200]);
  });

  it("repairs a damaged lane list instead of throwing", () => {
    expect(recordFirstClause({ full: "x" as never }, "full", 700)).toEqual({ full: [700] });
    expect(recordFirstClause(undefined as never, "full", 700)).toEqual({ full: [700] });
  });
});

describe("determinism", () => {
  it("the same input gives the same answer every time, and a replay of records gives the same history", () => {
    const history = { full: [1200, 800, 2000, 1500] };
    const first = expectedAnswerMs({ ...base, lane: "full", history });
    for (let i = 0; i < 5; i += 1)
      expect(expectedAnswerMs({ ...base, lane: "full", history })).toBe(first);
    const run = () =>
      [900, 1100, 1300].reduce<FirstClauseHistory>(
        (h, ms) => recordFirstClause(h, "quick", ms),
        {},
      );
    expect(run()).toEqual(run());
  });

  it("the estimate never reads the clock", () => {
    const real = Date.now;
    Date.now = () => {
      throw new Error("clock read");
    };
    try {
      expect(expectedAnswerMs({ ...base, lane: "quick" })).toBe(800);
      expect(recordFirstClause({}, "quick", 10)).toEqual({ quick: [10] });
    } finally {
      Date.now = real;
    }
  });
});

describe("ackLane", () => {
  it("a side question is the quick lane", () => {
    expect(ackLane({ kind: "side-question", text: "what time is it" })).toEqual({
      lane: "quick",
      toolsLikely: false,
    });
  });

  it("a question or chat is the full lane without tools", () => {
    expect(ackLane({ kind: "foreground-turn", text: "what is the weather in Delhi" })).toEqual({
      lane: "full",
      toolsLikely: false,
    });
    expect(ackLane({ kind: "chitchat", text: "tell me a story" }).lane).toBe("full");
  });

  it("a new task is the full lane with tools", () => {
    expect(ackLane({ kind: "new-task", text: "summarise my inbox and draft replies" })).toEqual({
      lane: "full",
      toolsLikely: true,
    });
  });

  it("an obvious short control verb is the command lane, in English, Roman Hindi and Devanagari", () => {
    for (const text of [
      "mute",
      "volume up",
      "pause the music",
      "next song",
      "skip",
      "resume",
      "awaaz kam karo",
      "आवाज़ कम करो",
      "म्यूट करो",
    ]) {
      expect(ackLane({ kind: "new-task", text }).lane, text).toBe("command");
    }
  });

  it("a control verb inside a long or real question is not a command", () => {
    expect(
      ackLane({
        kind: "foreground-turn",
        text: "why did the music pause when I opened the browser",
      }).lane,
    ).toBe("full");
    expect(
      ackLane({
        kind: "new-task",
        text: "pause everything and then write a long report about the quarter",
      }).lane,
    ).toBe("full");
  });

  it("garbage in gives the full lane", () => {
    expect(ackLane({ kind: "", text: "" }).lane).toBe("full");
    expect(ackLane({ kind: undefined as never, text: undefined as never }).lane).toBe("full");
  });
});
