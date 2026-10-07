import { describe, expect, it } from "vitest";
import {
  allowedByPolicy,
  allowedModelIds,
  describePolicy,
  isFree,
  orderByPolicy,
} from "../../src/lib/friday/brain/cost-policy";
import type { ModelCapabilityRecord } from "../../src/lib/friday/brain/model-registry";

const record = (id: string, kind: "local" | "cloud", provider: string): ModelCapabilityRecord =>
  ({
    id,
    name: id,
    version: "1",
    provider,
    kind,
    roles: ["planner"],
    contextK: 32,
    vision: false,
    audio: false,
    tools: false,
    speed: null,
    vramGb: 0,
    ramGb: 0,
    sizeGb: 0,
    cost: kind === "local" ? "free" : "metered",
    available: true,
    availability: "ready",
    reliability: null,
    performance: null,
  }) as unknown as ModelCapabilityRecord;

const local = record("local-a", "local", "ollama");
const freeCloud = record("cloud-free", "cloud", "groq");
const paidCloud = record("cloud-paid", "cloud", "openai");
const free = new Set(["cloud-free"]);
// Cloud is opt-in and manual only, so every cloud case below states the
// owner's manual pick explicitly — these tests are about cost ranking, not
// about whether cloud is allowed at all.
const picked = { allowed: true, ids: new Set<string>() };

describe("model cost policy", () => {
  it("counts local models and specific free cloud models as free, never a whole provider", () => {
    expect(isFree(local, free)).toBe(true);
    expect(isFree(freeCloud, free)).toBe(true);
    expect(isFree(paidCloud, free)).toBe(false);
    const otherGroq = record("cloud-groq-paid", "cloud", "groq");
    expect(isFree(otherGroq, free)).toBe(false);
  });

  it("excludes local and free cloud under paid-only", () => {
    const allowed = allowedByPolicy([paidCloud, local, freeCloud], "paid-only", free, picked);
    expect(allowed.map((r) => r.id)).toEqual(["cloud-paid"]);
  });

  it("excludes paid models entirely under free-only", () => {
    const allowed = allowedByPolicy([paidCloud, local, freeCloud], "free-only", free, picked);
    expect(allowed.map((r) => r.id)).toEqual(["local-a", "cloud-free"]);
  });

  it("keeps paid models but ranks them last under free-preferred", () => {
    const ordered = orderByPolicy([paidCloud, freeCloud, local], "free-preferred", free, picked);
    expect(ordered.map((r) => r.id)).toEqual(["cloud-free", "local-a", "cloud-paid"]);
  });

  it("leaves measured order untouched when paid usage is allowed", () => {
    const ordered = orderByPolicy([paidCloud, local], "allow-paid", free, picked);
    expect(ordered.map((r) => r.id)).toEqual(["cloud-paid", "local-a"]);
  });

  it("explains the active policy in one line", () => {
    expect(describePolicy("free-only")).toMatch(/free only/i);
    expect(describePolicy("allow-paid")).toMatch(/allowed/i);
  });
});

describe("hard safety rule — a cloud model nobody picked is not a candidate", () => {
  it("drops it even when the policy would allow paid usage", () => {
    const allowed = allowedByPolicy([paidCloud, local], "allow-paid", free, {
      allowed: false,
      ids: new Set<string>(),
    });
    expect(allowed.map((r) => r.id)).toEqual(["local-a"]);
  });
});

describe("policy enforcement over model ids", () => {
  const lookup = (id: string) =>
    ({ "local-a": local, "cloud-free": freeCloud, "cloud-paid": paidCloud })[id] ?? null;

  it("never routes a paid model while the policy is free only", () => {
    const ids = allowedModelIds(
      ["cloud-paid", "local-a", "cloud-free"],
      "free-only",
      free,
      lookup,
      picked,
    );
    expect(ids).not.toContain("cloud-paid");
    expect(ids).toEqual(["local-a", "cloud-free"]);
  });

  it("keeps a paid model last rather than dropping it when free is preferred", () => {
    expect(
      allowedModelIds(["cloud-paid", "local-a"], "free-preferred", free, lookup, picked),
    ).toEqual(["local-a", "cloud-paid"]);
  });

  it("leaves ids alone when paid usage is allowed", () => {
    expect(allowedModelIds(["cloud-paid", "local-a"], "allow-paid", free, lookup, picked)).toEqual([
      "cloud-paid",
      "local-a",
    ]);
  });

  it("keeps ids the capability registry does not know, for the billing gate to judge", () => {
    expect(allowedModelIds(["mystery", "cloud-paid"], "free-only", free, lookup, picked)).toEqual([
      "mystery",
    ]);
  });

  it("drops unknown ids that look like paid cloud models under free-only", () => {
    expect(
      allowedModelIds(["gpt-4o", "openai/gpt-4.1", "mystery"], "free-only", free, lookup, picked),
    ).toEqual(["mystery"]);
  });
});
