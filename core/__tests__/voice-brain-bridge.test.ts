import { describe, expect, it } from "vitest";
import {
  CONTEXT_MAX_CHARS,
  LADDER_QUICK_FIRST_TOKEN_MS,
  ackWanted,
  nextRung,
  planLadder,
  refusalKeepsForeground,
  speculationAllowed,
  voiceSendOptions,
  type LadderStep,
} from "../../src/lib/friday/voice-engine/brain-bridge";

const base = { text: "what is the time", commandHit: false, quickEligible: false, busy: false };
const lanes = (plan: readonly LadderStep[]) => plan.map((s) => s.lane);
const secret = (s: string) => /password|pin \d+/i.test(s);

describe("planLadder", () => {
  it("a plain idle turn goes straight to full with no timebox", () => {
    const plan = planLadder(base);
    expect(lanes(plan)).toEqual(["full"]);
    expect(plan[0]?.timeboxMs).toBeNull();
  });

  it("puts the command lane first when a command matched", () => {
    expect(lanes(planLadder({ ...base, commandHit: true, quickEligible: true }))).toEqual([
      "command",
      "quick",
      "full",
    ]);
  });

  it("quick is tried before full, boxed at 1000 ms of first token", () => {
    const plan = planLadder({ ...base, quickEligible: true });
    expect(lanes(plan)).toEqual(["quick", "full"]);
    expect(plan[0]?.timeboxMs).toBe(LADDER_QUICK_FIRST_TOKEN_MS);
    expect(LADDER_QUICK_FIRST_TOKEN_MS).toBe(1000);
    expect(plan[1]?.timeboxMs).toBeNull();
  });

  it("a busy plan never contains a second full run", () => {
    for (const commandHit of [false, true]) {
      for (const quickEligible of [false, true]) {
        const plan = planLadder({ text: "and the weather", commandHit, quickEligible, busy: true });
        expect(lanes(plan)).not.toContain("full");
      }
    }
    expect(lanes(planLadder({ ...base, quickEligible: true, busy: true }))).toEqual(["quick"]);
  });

  it("a busy turn that is not quick eligible has nothing to run beside the foreground", () => {
    expect(planLadder({ ...base, busy: true })).toEqual([]);
  });

  it("blank text plans nothing", () => {
    expect(planLadder({ ...base, text: "   " })).toEqual([]);
  });

  it("every non-empty idle plan ends with full", () => {
    for (const commandHit of [false, true]) {
      for (const quickEligible of [false, true]) {
        const plan = planLadder({ ...base, commandHit, quickEligible });
        expect(plan.at(-1)?.lane).toBe("full");
        expect(plan.filter((s) => s.lane === "full")).toHaveLength(1);
      }
    }
  });

  it("the plan and its steps are frozen", () => {
    const plan = planLadder({ ...base, commandHit: true, quickEligible: true });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(plan.every((s) => Object.isFrozen(s))).toBe(true);
    expect(() =>
      (plan as LadderStep[]).push({ lane: "full", timeboxMs: null, foregroundSafe: false }),
    ).toThrow();
    expect(() => {
      (plan[0] as { timeboxMs: number | null }).timeboxMs = 5;
    }).toThrow();
  });

  it("planning twice gives equal but independent plans", () => {
    const a = planLadder({ ...base, quickEligible: true });
    const b = planLadder({ ...base, quickEligible: true });
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});

describe("nextRung", () => {
  const plan = planLadder({ ...base, commandHit: true, quickEligible: true });

  it("a first token accepts the rung and ends the ladder", () => {
    expect(nextRung(plan, 1, "first-token")).toBeNull();
  });

  it("a quick timeout at 1000 ms falls to full", () => {
    const at = lanes(plan).indexOf("quick");
    expect(plan[at]?.timeboxMs).toBe(1000);
    const next = nextRung(plan, at, "timeout");
    expect(next).not.toBeNull();
    expect(plan[next as number]?.lane).toBe("full");
  });

  it("quick refused falls to full and keeps the foreground", () => {
    const at = lanes(plan).indexOf("quick");
    expect(plan[at]?.foregroundSafe).toBe(true);
    expect(refusalKeepsForeground(plan[at] as LadderStep)).toBe(true);
    expect(plan[nextRung(plan, at, "refused") as number]?.lane).toBe("full");
  });

  it("a command that does not apply moves down the ladder", () => {
    expect(nextRung(plan, 0, "refused")).toBe(1);
  });

  it("the last rung is exhausted, never a loop", () => {
    expect(nextRung(plan, plan.length - 1, "timeout")).toBeNull();
    expect(nextRung(plan, plan.length - 1, "refused")).toBeNull();
  });

  it("a busy quick refusal ends the plan and never invents a full run", () => {
    const busyPlan = planLadder({ ...base, quickEligible: true, busy: true });
    expect(nextRung(busyPlan, 0, "refused")).toBeNull();
    expect(nextRung(busyPlan, 0, "timeout")).toBeNull();
  });

  it("an out of range or fractional position is null", () => {
    expect(nextRung(plan, -1, "timeout")).toBeNull();
    expect(nextRung(plan, 99, "timeout")).toBeNull();
    expect(nextRung(plan, 0.5, "timeout")).toBeNull();
    expect(nextRung([], 0, "timeout")).toBeNull();
  });

  it("leaves the plan untouched", () => {
    nextRung(plan, 0, "timeout");
    expect(Object.isFrozen(plan)).toBe(true);
    expect(lanes(plan)).toEqual(["command", "quick", "full"]);
  });
});

describe("voiceSendOptions", () => {
  it("routingSurface is always voice", () => {
    for (const lane of ["quick", "full"] as const) {
      expect(voiceSendOptions({ lane, turnId: "t1" }).routingSurface).toBe("voice");
    }
  });

  it("carries lane and turn id and no context key when none is given", () => {
    const o = voiceSendOptions({ lane: "quick", turnId: "t9" });
    expect(o).toEqual({ routingSurface: "voice", lane: "quick", turnId: "t9" });
    expect("context" in o).toBe(false);
  });

  it("trims the context to 800 characters", () => {
    const o = voiceSendOptions({
      lane: "full",
      turnId: "t2",
      context: `  ${"a".repeat(2000)}  `,
      isSensitive: secret,
    });
    expect(CONTEXT_MAX_CHARS).toBe(800);
    expect(o.context).toBe("a".repeat(800));
  });

  it("does not cut a surrogate pair in half", () => {
    const o = voiceSendOptions({
      lane: "full",
      turnId: "t3",
      context: `${"a".repeat(799)}\u{1F600}tail`,
      isSensitive: secret,
    });
    expect(o.context).toBe("a".repeat(799));
  });

  it("keeps a short safe context as given, trimmed", () => {
    const o = voiceSendOptions({
      lane: "full",
      turnId: "t4",
      context: "  earlier we spoke of lunch ",
      isSensitive: secret,
    });
    expect(o.context).toBe("earlier we spoke of lunch");
  });

  it("drops a sensitive context, even when the marker sits past the 800 cut", () => {
    const early = voiceSendOptions({
      lane: "full",
      turnId: "t5",
      context: "my password is x",
      isSensitive: secret,
    });
    expect("context" in early).toBe(false);
    const late = voiceSendOptions({
      lane: "full",
      turnId: "t6",
      context: `${"a".repeat(900)} password`,
      isSensitive: secret,
    });
    expect("context" in late).toBe(false);
  });

  it("drops the context when no classifier is injected or the classifier fails", () => {
    expect("context" in voiceSendOptions({ lane: "full", turnId: "t7", context: "hello" })).toBe(
      false,
    );
    const boom = (): boolean => {
      throw new Error("classifier down");
    };
    expect(
      "context" in
        voiceSendOptions({ lane: "full", turnId: "t8", context: "hello", isSensitive: boom }),
    ).toBe(false);
  });

  it("drops a blank context", () => {
    expect(
      "context" in
        voiceSendOptions({ lane: "full", turnId: "t10", context: "   ", isSensitive: secret }),
    ).toBe(false);
  });
});

describe("ackWanted", () => {
  it("is true only above 1500 ms", () => {
    expect(ackWanted({ lane: "full", expectedMs: 1500 })).toBe(false);
    expect(ackWanted({ lane: "full", expectedMs: 1501 })).toBe(true);
    expect(ackWanted({ lane: "quick", expectedMs: 1501 })).toBe(true);
    expect(ackWanted({ lane: "quick", expectedMs: 400 })).toBe(false);
  });

  it("the command lane never gets an ack", () => {
    expect(ackWanted({ lane: "command", expectedMs: 60_000 })).toBe(false);
  });

  it("an unknown estimate does not trigger one", () => {
    expect(ackWanted({ lane: "full", expectedMs: Number.NaN })).toBe(false);
    expect(ackWanted({ lane: "full", expectedMs: -5 })).toBe(false);
  });
});

describe("speculationAllowed gate matrix", () => {
  const combos: Array<[boolean, boolean, boolean, boolean, boolean]> = [];
  for (const privacyChanged of [false, true]) {
    for (const paidChanged of [false, true]) {
      for (const autonomyChanged of [false, true]) {
        for (const readOnly of [false, true]) {
          combos.push([
            privacyChanged,
            paidChanged,
            autonomyChanged,
            readOnly,
            readOnly && !privacyChanged && !paidChanged && !autonomyChanged,
          ]);
        }
      }
    }
  }

  it("covers all 16 combinations of the four flags", () => {
    expect(combos).toHaveLength(16);
    expect(combos.filter((c) => c[4])).toHaveLength(1);
  });

  it.each(combos)(
    "privacy=%s paid=%s autonomy=%s readOnly=%s -> %s",
    (privacyChanged, paidChanged, autonomyChanged, readOnly, expected) => {
      expect(speculationAllowed({ privacyChanged, paidChanged, autonomyChanged, readOnly })).toBe(
        expected,
      );
    },
  );
});
