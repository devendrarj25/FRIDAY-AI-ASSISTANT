import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const router = require_("../../electron/model-router.cjs");
const access = require_("../../electron/model-access.cjs");

const model = (id: string, kind: "local" | "cloud", provider: string) => {
  const base = {
    id,
    label: id,
    provider,
    endpoint: "http://127.0.0.1:11434",
    role: "brain",
    contextK: 32,
    status: "ready",
    options: { model: id },
    meta: { providerId: provider, kind, modelName: id, resident: false, sizeGb: 4 },
  };
  return kind === "cloud" && provider === "gemini" ? access.stampVerified(base) : base;
};

const inventory = [
  model("llama3.1:8b", "local", "ollama"),
  // Canonical provider id is "gemini" (see electron/models.cjs CLOUD keys).
  model("gemini-2.0-flash", "cloud", "gemini"),
  model("gpt-4o", "cloud", "openai"),
];

describe("online / offline routing", () => {
  it("automatically includes free cloud but excludes paid cloud under free-first", () => {
    const chosen = router.selectEligible(inventory, { policy: "free-preferred" });
    const ids = chosen.map((m: { id: string }) => m.id);
    expect(ids).toContain("llama3.1:8b");
    expect(ids).toContain("gemini-2.0-flash");
    expect(ids).not.toContain("gpt-4o");

    const picked = router
      .selectEligible(inventory, { policy: "free-preferred", preferred: ["gemini-2.0-flash"] })
      .map((m: { id: string }) => m.id);
    expect(picked).toContain("gemini-2.0-flash");
    expect(picked).not.toContain("gpt-4o");
  });

  it("does not auto-select unknown-cost cloud models under free-first", () => {
    const mystery = model("mystery-cloud", "cloud", "custom-openai");
    const ids = router
      .selectEligible([...inventory, mystery], { policy: "free-preferred" })
      .map((m: { id: string }) => m.id);
    expect(ids).toContain("llama3.1:8b");
    expect(ids).not.toContain("mystery-cloud");
    expect(ids).not.toContain("gpt-4o");
  });

  it("uses local models offline without violating Cloud-only", () => {
    for (const mode of ["auto", "hybrid"]) {
      const chosen = router.selectEligible(inventory, {
        mode,
        offline: true,
        policy: "allow-paid",
      });
      expect(chosen.every((m: { type: string }) => m.type === "local")).toBe(true);
    }
    expect(
      router.selectEligible(inventory, {
        mode: "cloud-only",
        offline: true,
        policy: "allow-paid",
      }),
    ).toEqual([]);
    expect(router.typesForMode("cloud-only", true)).toEqual([]);
  });

  it("says so honestly when offline with no local model running", () => {
    const message = router.explainFailure({ offline: true, checked: [], failures: [] });
    expect(message).toMatch(/offline/i);
    expect(message).toMatch(/local model/i);
  });
});

describe("cost modes", () => {
  it("maps every owner-facing cost mode onto a hard policy", () => {
    expect(router.policyForCostMode("free-only")).toBe("free-only");
    expect(router.policyForCostMode("free-first")).toBe("free-preferred");
    expect(router.policyForCostMode("balanced")).toBe("free-preferred");
    expect(router.policyForCostMode("quality-first")).toBe("allow-paid");
    expect(router.policyForCostMode("paid")).toBe("allow-paid");
    expect(router.policyForCostMode("paid-only")).toBe("paid-only");
  });

  it("falls back to a free-first policy for an unknown mode", () => {
    expect(router.normaliseCostMode("nonsense")).toBe("free-first");
    expect(router.policyForCostMode(undefined)).toBe("free-preferred");
  });
});
