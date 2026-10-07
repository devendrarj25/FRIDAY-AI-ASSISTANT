import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { pinKnowledgeClock } from "./helpers/knowledge-clock";

const require_ = createRequire(import.meta.url);

pinKnowledgeClock();
const billing = require_("../../electron/billing-policy.cjs");
const router = require_("../../electron/model-router.cjs");
const models = require_("../../electron/models.cjs");

const paidModel = {
  id: "openai:gpt-4o",
  contextK: 128,
  meta: { providerId: "openai", kind: "cloud", modelName: "gpt-4o" },
};
const freeModel = {
  id: "ollama:qwen2.5",
  contextK: 32,
  provider: "ollama",
  meta: { providerId: "ollama", kind: "local", modelName: "qwen2.5", sizeGb: 5 },
};

describe("billing safety", () => {
  it("keeps paid usage locked by default", () => {
    const state = billing.normaliseBilling(undefined);
    expect(state.paidAccess).toBe(false);
    expect(state.autoPaidUsage).toBe(false);
    expect(billing.paidUnlocked(state).allowed).toBe(false);
    expect(billing.effectivePolicy(state, { requested: "allow-paid" })).toBe("free-preferred");
  });

  it("does not let a stored key or a requested policy unlock spending", () => {
    const policy = billing.effectivePolicy(
      { paidAccess: false, autoPaidUsage: true },
      {
        requested: "allow-paid",
      },
    );
    expect(policy).toBe("free-preferred");
    expect(
      require_("../../electron/billing-firewall.cjs").guardProviderRequest({
        model: { type: "cloud", access: "paid" },
        billing: { paidAccess: false, autoPaidUsage: true },
        policy,
      }).allowed,
    ).toBe(false);
  });

  it("allows paid only for an explicit pick until automatic paid usage is on", () => {
    const on = billing.normaliseBilling({ paidAccess: true });
    expect(billing.effectivePolicy(on, { explicitPaid: true })).toBe("allow-paid");
    expect(billing.effectivePolicy(on, {})).toBe("free-preferred");
    const auto = billing.normaliseBilling({ paidAccess: true, autoPaidUsage: true });
    expect(billing.effectivePolicy(auto, { requested: "allow-paid" })).toBe("allow-paid");
  });

  it("expires a session grant and spends a one-shot request grant", () => {
    const now = 1_000_000;
    const session = billing.applyGrant({}, "session", now);
    expect(billing.paidUnlocked(session, now).allowed).toBe(true);
    expect(billing.paidUnlocked(session, now + billing.SESSION_GRANT_MS + 1).allowed).toBe(false);

    const once = billing.applyGrant({}, "request", now);
    expect(billing.paidUnlocked(once, now).allowed).toBe(true);
    expect(billing.paidUnlocked(billing.consumeGrant(once), now).allowed).toBe(false);
  });

  it("kill switch overrides everything, including grants", () => {
    const state = billing.setKillSwitch({ paidAccess: true, autoPaidUsage: true }, true);
    expect(billing.paidUnlocked(state).allowed).toBe(false);
    expect(billing.effectivePolicy(state, { explicitPaid: true })).toBe("free-preferred");
    expect(billing.applyGrant(state, "always").grantScope).toBe("off");
  });

  it("the router really drops paid models under the resulting policy", () => {
    const locked = billing.effectivePolicy(billing.normaliseBilling(undefined), {});
    const eligible = router.selectEligible([paidModel, freeModel], { policy: locked });
    expect(eligible.map((m: { id: string }) => m.id)).toEqual(["ollama:qwen2.5"]);

    const unlocked = billing.effectivePolicy({ paidAccess: true }, { explicitPaid: true });
    // Cloud/paid is opt-in and manual only: the owner picking the model IS
    // the opt-in, so it is passed as an explicit preference here.
    const withPaid = router.selectEligible([paidModel, freeModel], {
      policy: unlocked,
      preferred: ["openai:gpt-4o"],
    });
    expect(withPaid.map((m: { id: string }) => m.id)).toContain("openai:gpt-4o");
  });
});

describe("per-provider cost tier", () => {
  it("does not let the owner declare a metered API model free", () => {
    expect(
      router.classifyAccess({
        id: "openai:gpt-4o",
        meta: { providerId: "openai", kind: "cloud", modelName: "gpt-4o", declaredAccess: "free" },
      }),
    ).toBe("paid");
  });

  it("keeps only evidence-backed free candidates when a provider is set to free", () => {
    const list = [
      {
        id: "meta/llama:free",
        name: "llama",
        provider: "openrouter",
        pricing: { prompt: "0", completion: "0" },
      },
      {
        id: "meta/llama",
        name: "llama",
        provider: "openrouter",
        pricing: { prompt: "0.0001", completion: "0.0001" },
      },
    ];
    expect(
      models.filterByTier(list, "free", "openrouter").map((m: { id: string }) => m.id),
    ).toEqual(["meta/llama:free"]);
    expect(
      models.filterByTier(list, "paid", "openrouter").map((m: { id: string }) => m.id),
    ).toEqual(["meta/llama"]);
    expect(models.filterByTier(list, "auto")).toHaveLength(2);
  });

  it("fails closed when a free filter has no evidence-backed candidates", () => {
    const list = [{ id: "gemini-2.0-flash", name: "gemini" }];
    expect(models.filterByTier(list, "free")).toHaveLength(0);
    expect(
      models.filterByTier([{ id: "gemini-2.0-flash", provider: "gemini" }], "free", "gemini"),
    ).toHaveLength(0);
    expect(
      models.filterByTier(
        [
          {
            id: "gemini-2.0-flash",
            provider: "gemini",
            account: { projectTier: "free" },
          },
        ],
        "free",
        "gemini",
      ),
    ).toHaveLength(0);
    expect(
      models.filterByTier(
        [
          {
            id: "gemini-2.5-flash",
            provider: "gemini",
            account: { projectTier: "free" },
          },
        ],
        "free",
        "gemini",
      ),
    ).toHaveLength(1);
  });

  it("does not treat an OpenRouter :free suffix as proof without pricing", () => {
    expect(
      router.classifyAccess({
        id: "openrouter:meta-llama/llama-3.3-70b-instruct:free",
        meta: {
          providerId: "openrouter",
          kind: "cloud",
          modelName: "meta-llama/llama-3.3-70b-instruct:free",
        },
      }),
    ).toBe("unknown");
    expect(
      router.classifyAccess({
        id: "openrouter:meta-llama/llama-3.3-70b-instruct:free",
        meta: {
          providerId: "openrouter",
          kind: "cloud",
          modelName: "meta-llama/llama-3.3-70b-instruct:free",
          catalogue: { pricing: { prompt: "0", completion: "0" } },
        },
      }),
    ).toBe("free");
    const verified = require_("../../electron/model-access.cjs").stampVerified(
      {
        id: "openrouter:openrouter/free",
        meta: { providerId: "openrouter", kind: "cloud", modelName: "openrouter/free" },
      },
      "ZERO_COST",
    );
    expect(router.classifyAccess(verified)).toBe("free");
    expect(
      router.classifyAccess({
        id: "openrouter:new-model",
        meta: { providerId: "openrouter", kind: "cloud", modelName: "new-model" },
      }),
    ).toBe("unknown");
  });
});
