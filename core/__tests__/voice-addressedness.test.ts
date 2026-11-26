import { describe, expect, it } from "vitest";
import {
  judgeAddressedness,
  type AddressednessInput,
} from "../../src/lib/friday/voice-engine/addressedness";

const NARRATION = "and the minister said the new road will open next month in the city";

function input(over: Partial<AddressednessInput> = {}): AddressednessInput {
  return {
    text: "open the notes",
    lang: "en",
    baseRequireWake: false,
    wakeHeard: false,
    followUp: false,
    expectingAnswer: false,
    handsFree: true,
    sinceLastTurnMs: 2_000,
    ...over,
  };
}

describe("addressedness gate", () => {
  it("a TV scene with a 10-word narration needs the wake word", () => {
    const out = judgeAddressedness(input({ text: NARRATION, scene: { kind: "tv", score: 0.8 } }));
    expect(out.addressed).toBe("not");
    expect(out.requireWake).toBe(true);
    expect(out.score).toBeGreaterThanOrEqual(0.5);
    expect(out.reasons).toContain("scene:tv");
    expect(out.reasons).toContain("narration");
  });

  it("a short order in a quiet room is directed and adds nothing", () => {
    const out = judgeAddressedness(input());
    expect(out).toMatchObject({ addressed: "directed", requireWake: false, score: 0 });
  });

  it("a question or a second-person cue is not narration", () => {
    const q = judgeAddressedness(
      input({ text: "what is the weather going to be like in the city tomorrow" }),
    );
    const you = judgeAddressedness(
      input({ text: "i think you should remind me about the meeting later on" }),
    );
    const hi = judgeAddressedness(
      input({ text: "kal subah mujhe office ke liye jaldi uthana yaad dilao" }),
    );
    for (const out of [q, you, hi]) expect(out.reasons).not.toContain("narration");
  });

  it("the unsure band adds the wake word only with hands-free on and no follow-up", () => {
    // tv 0.40 alone = unsure
    const base = { scene: { kind: "music" as const, score: 0.7 } };
    expect(judgeAddressedness(input({ ...base, handsFree: true })).addressed).toBe("unsure");
    expect(judgeAddressedness(input({ ...base, handsFree: true })).requireWake).toBe(true);
    expect(judgeAddressedness(input({ ...base, handsFree: false })).requireWake).toBe(false);
    expect(
      judgeAddressedness(input({ ...base, handsFree: true, followUp: true })).requireWake,
    ).toBe(false);
  });

  it("each signal adds its documented weight", () => {
    expect(judgeAddressedness(input({ speaker: "other" })).score).toBe(0.25);
    expect(judgeAddressedness(input({ asrLogProb: -1.4 })).score).toBe(0.15);
    expect(judgeAddressedness(input({ asrLogProb: null })).score).toBe(0);
    expect(judgeAddressedness(input({ speechMs: 9_000 })).score).toBe(0.2);
    expect(judgeAddressedness(input({ sinceLastTurnMs: 90_000 })).score).toBe(0.1);
    expect(judgeAddressedness(input({ sinceLastTurnMs: 90_000, followUp: true })).score).toBe(0);
    expect(judgeAddressedness(input({ scene: { kind: "tv", score: 0.5 } })).score).toBe(0);
    expect(judgeAddressedness(input({ scene: { kind: "speech", score: 0.9 } })).score).toBe(0);
  });

  it("the owner's voice is a colour only: it lowers nothing and approves nothing", () => {
    const other = { text: NARRATION, scene: { kind: "tv" as const, score: 0.9 } };
    const owner = judgeAddressedness(input({ ...other, speaker: "owner" }));
    const unknown = judgeAddressedness(input({ ...other, speaker: "unknown" }));
    expect(owner.score).toBe(unknown.score);
    expect(owner.requireWake).toBe(true);
    expect(owner).not.toHaveProperty("approved");
    expect(judgeAddressedness(input({ baseRequireWake: true, speaker: "owner" })).requireWake).toBe(
      true,
    );
  });

  it("a heard wake word or an expected answer labels directed but never lowers the wake rule", () => {
    const woke = judgeAddressedness(input({ baseRequireWake: true, wakeHeard: true }));
    expect(woke).toMatchObject({ addressed: "directed", requireWake: true });
    const ans = judgeAddressedness(
      input({ baseRequireWake: true, expectingAnswer: true, text: "haan" }),
    );
    expect(ans).toMatchObject({ addressed: "directed", requireWake: true });
    const tv = judgeAddressedness(
      input({ text: NARRATION, scene: { kind: "tv", score: 0.9 }, wakeHeard: true }),
    );
    expect(tv.addressed).toBe("directed");
    expect(tv.requireWake).toBe(true);
  });

  it("a 200-row table: requireWake is never below baseRequireWake", () => {
    let seed = 20261126;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;
    const texts = [
      NARRATION,
      "open the notes",
      "kya time hai",
      "",
      "haan",
      "send it to Rohan please",
    ];
    const scenes = [
      undefined,
      { kind: "tv" as const, score: 0.9 },
      { kind: "noise" as const, score: 0.4 },
    ];
    const speakers = [undefined, "owner", "other", "unknown"] as const;
    let added = 0;
    for (let row = 0; row < 200; row += 1) {
      const base = rand() < 0.5;
      const i: AddressednessInput = {
        text: pick(texts),
        lang: pick(["hi", "en", "hi-en", ""] as const),
        baseRequireWake: base,
        wakeHeard: rand() < 0.3,
        followUp: rand() < 0.3,
        expectingAnswer: rand() < 0.2,
        handsFree: rand() < 0.5,
        sinceLastTurnMs: pick([null, 1_000, 120_000]),
        asrLogProb: pick([null, -0.2, -2]),
        speechMs: pick([null, 500, 12_000]),
        ...(pick([true, false]) ? { scene: pick(scenes) ?? { kind: "speech", score: 0 } } : {}),
        ...(pick([true, false]) ? { speaker: pick(speakers) ?? "unknown" } : {}),
      };
      const out = judgeAddressedness(i);
      expect(Number(out.requireWake)).toBeGreaterThanOrEqual(Number(base));
      if (base) expect(out.requireWake).toBe(true);
      const owner = judgeAddressedness({ ...i, speaker: "owner" });
      expect(Number(owner.requireWake)).toBeGreaterThanOrEqual(Number(base));
      if (out.requireWake && !base) added += 1;
    }
    expect(added).toBeGreaterThan(0);
  });
});
