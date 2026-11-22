import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  hardGate,
  listLedger,
  recordAnswer,
  resetAnswerLedger,
} from "../../src/lib/friday/brain/answer-ledger";
import { coreBrain, type Cognition } from "../../src/lib/friday/brain/core-brain";
import { modelRegistry } from "../../src/lib/friday/brain/model-registry";
import { isConsequential } from "../../src/lib/friday/brain/action-risk";
import {
  consultLocalMind,
  distillLocalAnswer,
  localMindGrowth,
  resetLocalMind,
} from "../../src/lib/friday/brain/local-mind";
import { looksLikeLiveFact } from "../../src/lib/friday/brain/research";
import { looksSensitive } from "../../src/lib/friday/brain/memory-policy";

const PROMPT = "how does friday pack a cognitive context packet for a turn";
const ANSWER =
  "FRIDAY keeps the full chat on this PC and sends the model only the ranked lines this turn needs.";

beforeEach(() => {
  resetLocalMind();
  distillLocalAnswer({ prompt: PROMPT, answer: ANSWER, now: 1 });
});

describe("brain-first gate", () => {
  it("skips the model on a covered ask and reports the gate numbers", () => {
    const hit = consultLocalMind({ prompt: PROMPT });
    expect(hit.skipModel).toBe(true);
    expect(hit.gate).toEqual({
      score: 1,
      threshold: 0.55,
      reason: "saved answer covers this ask",
      skippedModel: true,
    });
  });

  it("never skips for a sensitive, live-fact or consequential ask", () => {
    const sensitive = consultLocalMind({ prompt: PROMPT, sensitive: true });
    const blocked = consultLocalMind({ prompt: PROMPT, blocked: true });
    for (const decision of [sensitive, blocked]) {
      expect(decision.skipModel).toBe(false);
      expect(decision.reply).toBeNull();
      expect(decision.gate?.skippedModel).toBe(false);
    }
    expect(sensitive.gate?.reason).toBe("sensitive text is not reused");
    expect(blocked.gate?.reason).toBe("this turn stays with the model");
  });

  it("the call-site classifiers mark those asks so the gate is closed to them", () => {
    expect(looksSensitive("my password is hunter2 and my card is 4111 1111 1111 1111")).toBe(true);
    expect(looksLikeLiveFact("what is the weather in Jaipur right now")).toBe(true);
    expect(isConsequential("delete all files in my documents folder")).toBe(true);
  });

  it("a weak overlap keeps the model with a score under the threshold", () => {
    const miss = consultLocalMind({ prompt: "how does friday pack a packet" });
    expect(miss.skipModel).toBe(false);
    expect(miss.gate?.score).toBeLessThan(0.55);
    expect(miss.gate?.reason).toBe("saved answers do not cover this ask");
  });

  it("is deterministic and does not change counters", () => {
    const before = localMindGrowth();
    const a = consultLocalMind({ prompt: PROMPT });
    const b = consultLocalMind({ prompt: PROMPT });
    expect(b).toEqual(a);
    expect(localMindGrowth()).toEqual(before);
  });
});

describe("the ledger records the model that served the turn", () => {
  const cognition = (ledgerId: number, prompt: string, modelIds: string[]) =>
    ({ ledgerId, prompt, modelIds }) as unknown as Cognition;
  const start = (source: "unknown-model" | "local-model") =>
    recordAnswer({
      kind: "chat",
      source,
      escalated: true,
      confidence: 0.3,
      tier: "STANDARD",
      at: 1_700_000_000_000,
    });

  beforeEach(() => {
    resetAnswerLedger();
    vi.spyOn(modelRegistry, "get").mockImplementation(
      (id: string) =>
        (id === "cloud-a"
          ? { id, kind: "cloud", cost: "metered" }
          : id === "local-a"
            ? { id, kind: "local", cost: "free" }
            : null) as never,
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("a local answer whose first-listed model was cloud leaves no false hard failure", () => {
    const id = start("unknown-model");
    coreBrain.settleLedger(cognition(id, "tell me a joke", ["cloud-a", "local-a"]), "local-a");
    expect(listLedger()[0]?.source).toBe("local-model");
    expect(hardGate(listLedger()).pass).toBe(true);
  });

  it("a served cloud model is recorded as cloud with its paid flag", () => {
    const id = start("unknown-model");
    coreBrain.settleLedger(cognition(id, "tell me a joke", ["cloud-a"]), "cloud-a");
    expect(listLedger()[0]).toMatchObject({ source: "cloud", paid: true });
  });

  it("with no served model: local only when the whole route was local, else unknown", () => {
    const mixed = start("unknown-model");
    coreBrain.settleLedger(cognition(mixed, "hello there", ["cloud-a", "local-a"]));
    const allLocal = start("unknown-model");
    coreBrain.settleLedger(cognition(allLocal, "hello there", ["local-a"]));
    const [first, second] = listLedger();
    expect(first?.source).toBe("unknown-model");
    expect(second?.source).toBe("local-model");
  });
});
