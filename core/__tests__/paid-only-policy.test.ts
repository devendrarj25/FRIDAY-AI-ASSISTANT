/**
 * paid-only policy + local-only/cloud-only owner-pick pool.
 *
 * Minimum proof for the new cost policy and the empty-pool honest refusal.
 * Existing free-only / free-preferred / allow-paid / route-mode tests stay
 * the regression net for unchanged behaviour.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { pinKnowledgeClock } from "./helpers/knowledge-clock";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const require_ = createRequire(import.meta.url);

pinKnowledgeClock();
const router = require_("../../electron/model-router.cjs");
const billing = require_("../../electron/billing-policy.cjs");
const firewall = require_("../../electron/billing-firewall.cjs");
const access = require_("../../electron/model-access.cjs");

const model = (id: string, kind: "local" | "cloud", provider: string, role = "brain") => {
  const base = {
    id,
    label: id,
    provider,
    role,
    contextK: 32,
    meta: { providerId: provider, kind, modelName: id.split(":")[1] || id },
  };
  return kind === "cloud" && (provider === "gemini" || provider === "groq")
    ? access.stampVerified(base)
    : base;
};

const POOL = [
  model("ollama:llama3.1", "local", "ollama"),
  model("gemini:gemini-2.0-flash", "cloud", "gemini"),
  model("groq:llama-3.3-70b", "cloud", "groq"),
  model("openai:gpt-4o", "cloud", "openai"),
];

const ids = (list: Array<{ id: string }>) => list.map((m) => m.id);

describe("paid-only policy", () => {
  it("keeps only access===paid and drops free plus unknown", () => {
    const mystery = model("customgw:mystery", "cloud", "customgw");
    const picked = router.selectEligible([...POOL, mystery], {
      policy: "paid-only",
      mode: "auto",
      limit: 8,
    });
    expect(ids(picked)).toEqual(["openai:gpt-4o"]);
    expect(ids(picked)).not.toContain("ollama:llama3.1");
    expect(ids(picked)).not.toContain("gemini:gemini-2.0-flash");
    expect(ids(picked)).not.toContain("customgw:mystery");
  });

  it("does not rename or replace the existing three policies", () => {
    expect(router.POLICIES).toEqual(["free-only", "free-preferred", "allow-paid", "paid-only"]);
    expect(router.normalisePolicy("free-only")).toBe("free-only");
    expect(router.normalisePolicy("allow-paid")).toBe("allow-paid");
    expect(router.policyForCostMode("paid")).toBe("allow-paid");
    expect(router.policyForCostMode("paid-only")).toBe("paid-only");
  });

  it("does not silently become free-preferred when paid access is locked", () => {
    const locked = billing.effectivePolicy(billing.normaliseBilling(undefined), {
      requested: "paid-only",
    });
    expect(locked).toBe("paid-only");
    const eligible = router.selectEligible(POOL, { policy: locked, mode: "auto" });
    expect(ids(eligible)).toEqual(["openai:gpt-4o"]);
  });

  it("still cannot spend when the kill switch or paidAccess is off", () => {
    const killed = billing.setKillSwitch({ paidAccess: true, autoPaidUsage: true }, true);
    expect(
      firewall.guardProviderRequest({
        model: { type: "cloud", access: "paid" },
        billing: killed,
        policy: "paid-only",
        explicitPaid: true,
      }).allowed,
    ).toBe(false);
    expect(
      firewall.guardProviderRequest({
        model: { type: "cloud", access: "paid" },
        billing: billing.normaliseBilling({ paidAccess: false, autoPaidUsage: true }),
        policy: "paid-only",
      }).allowed,
    ).toBe(false);
  });

  it("blocks free and local at the firewall under paid-only", () => {
    expect(
      firewall.guardProviderRequest({
        model: { type: "local", access: "free" },
        billing: billing.normaliseBilling({ paidAccess: true, autoPaidUsage: true }),
        policy: "paid-only",
      }).allowed,
    ).toBe(false);
    expect(
      firewall.guardProviderRequest({
        model: { type: "cloud", access: "free" },
        billing: billing.normaliseBilling({ paidAccess: true, autoPaidUsage: true }),
        policy: "paid-only",
      }).allowed,
    ).toBe(false);
  });

  it("allows a paid model under paid-only when access and auto-paid are on", () => {
    expect(
      firewall.guardProviderRequest({
        model: { type: "cloud", access: "paid" },
        billing: billing.normaliseBilling({ paidAccess: true, autoPaidUsage: true }),
        policy: "paid-only",
      }).allowed,
    ).toBe(true);
  });

  it("pushes a cost-policy change to the kernel so companion spendable cannot stay stale", () => {
    const main = readFileSync(resolve(process.cwd(), "electron/main.cjs"), "utf8");
    const fn = main.slice(
      main.indexOf("function setModelUsagePolicy"),
      main.indexOf("async function kernelRequest"),
    );
    expect(fn).toContain("void pushBillingToKernel()");
    expect(fn).toContain('send("models:policy"');
  });
});

describe("local-only + paid-only honest refusal", () => {
  it("has zero eligible models because local is always free", () => {
    const picked = router.selectEligible(POOL, {
      mode: "local-only",
      policy: "paid-only",
      limit: 8,
    });
    expect(picked).toEqual([]);
    const message = router.explainUnavailable({
      mode: "local-only",
      policy: "paid-only",
    });
    expect(message).toMatch(/no paid local models exist/i);
    expect(message).toMatch(/turn off paid-only/i);
    expect(message).not.toMatch(/at |Error|stack/i);
  });

  it("does not silently fall back to auto or free-preferred", () => {
    const picked = router.selectEligible(POOL, {
      mode: "local-only",
      policy: "paid-only",
    });
    expect(ids(picked)).not.toContain("ollama:llama3.1");
    expect(ids(picked)).not.toContain("openai:gpt-4o");
    expect(router.normaliseRouteMode("local-only")).toBe("local-only");
    expect(router.normalisePolicy("paid-only")).toBe("paid-only");
  });
});

describe("local-only / cloud-only owner-pick pool", () => {
  it("restricts local-only to the picked local models when any are selected", () => {
    const extra = model("ollama:qwen2.5", "local", "ollama");
    const picked = router.selectEligible([...POOL, extra], {
      mode: "local-only",
      preferred: ["ollama:qwen2.5"],
      limit: 8,
    });
    expect(ids(picked)).toEqual(["ollama:qwen2.5"]);
  });

  it("keeps every local model when local-only has an empty pick list", () => {
    const extra = model("ollama:qwen2.5", "local", "ollama");
    const picked = ids(
      router.selectEligible([...POOL, extra], { mode: "local-only", preferred: [], limit: 8 }),
    );
    expect(picked).toContain("ollama:llama3.1");
    expect(picked).toContain("ollama:qwen2.5");
    expect(picked.every((id) => id.startsWith("ollama:"))).toBe(true);
  });

  it("does not fall back outside the cloud-only pick list", () => {
    const picked = router.selectEligible(POOL, {
      mode: "cloud-only",
      preferred: ["gemini:gemini-2.0-flash"],
      limit: 8,
    });
    expect(ids(picked)).toEqual(["gemini:gemini-2.0-flash"]);
    expect(ids(picked)).not.toContain("groq:llama-3.3-70b");
  });
});
