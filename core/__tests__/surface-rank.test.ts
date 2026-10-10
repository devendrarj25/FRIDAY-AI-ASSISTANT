import { describe, expect, it } from "vitest";
import {
  hedgeAllowed,
  rankForSurface,
  surfaceRank,
} from "../../src/lib/friday/model-routing-contract";

const pool = [
  {
    id: "slow-strong",
    available: true,
    eligible: true,
    latencyMs: 900,
    quality: 0.9,
    contextK: 32,
    access: "free",
  },
  {
    id: "fast-light",
    available: true,
    eligible: true,
    latencyMs: 80,
    quality: 0.2,
    contextK: 8,
    access: "free",
  },
  {
    id: "paid-hidden",
    available: true,
    eligible: false,
    latencyMs: 5,
    quality: 1,
    contextK: 128,
    access: "paid",
  },
];

describe("surface rank", () => {
  it("uses latency for voice and quality for chat on the same eligible pool", () => {
    expect(surfaceRank("voice")).toBe("latency-first");
    expect(surfaceRank("chat")).toBe("quality-first");
    expect(surfaceRank("manual")).toBe("quality-first");
    expect(rankForSurface(pool, "voice").map((row) => row.id)).toEqual([
      "fast-light",
      "slow-strong",
    ]);
    expect(rankForSurface(pool, "chat").map((row) => row.id)).toEqual([
      "slow-strong",
      "fast-light",
    ]);
    expect(hedgeAllowed("voice")).toBe(false);
    expect(hedgeAllowed("chat")).toBe(true);
  });
});
