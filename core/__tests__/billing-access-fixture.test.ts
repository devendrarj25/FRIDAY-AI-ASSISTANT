/**
 * Desktop and kernel read core/fixtures/billing-access-records.json.
 * A class in that file is the class both sides must return.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pinKnowledgeClock } from "./helpers/knowledge-clock";
import { groupModels, type RegistryModel } from "../../src/lib/friday/model-registry";

const require_ = createRequire(import.meta.url);
pinKnowledgeClock();

const firewall = require_("../../electron/billing-firewall.cjs");
const access = require_("../../electron/model-access.cjs");
const router = require_("../../electron/model-router.cjs");

type FixtureCase = {
  id: string;
  model: {
    id?: string;
    type?: string;
    provider?: string;
    access?: string;
    accessRecord?: Record<string, unknown>;
  };
  class: "free" | "paid" | "unknown";
  allowed: boolean;
};

const fixture = JSON.parse(
  readFileSync(path.resolve(__dirname, "../fixtures/billing-access-records.json"), "utf8"),
) as { paidAccess: boolean; cases: FixtureCase[] };

function row(partial: Partial<RegistryModel> & Pick<RegistryModel, "id">): RegistryModel {
  return {
    label: partial.id,
    provider: "online",
    providerId: "openrouter",
    providerName: "OpenRouter",
    modelName: partial.id,
    type: "cloud",
    access: "free",
    role: "brain",
    contextK: 8,
    available: true,
    eligible: true,
    health: "available",
    healthCategory: null,
    coolingDown: false,
    cooldownUntil: 0,
    latencyMs: null,
    priority: 1,
    supportsStreaming: true,
    supportsTools: false,
    supportsVision: false,
    resident: false,
    sizeGb: 0,
    visibility: "show",
    ...partial,
  };
}

describe("shared billing access fixture", () => {
  it("matches billingClass and the guard while paid access is off", () => {
    expect(fixture.paidAccess).toBe(false);
    expect(fixture.cases.length).toBeGreaterThanOrEqual(8);
    for (const item of fixture.cases) {
      expect(firewall.billingClass(item.model), item.id).toBe(item.class);
      const verdict = firewall.guardProviderRequest({
        model: item.model,
        billing: { paidAccess: false },
      });
      expect(verdict.allowed, item.id).toBe(item.allowed);
      expect(verdict.billingClass, item.id).toBe(item.class);
      expect(verdict.allowed, item.id).toBe(item.class === "free");
    }
  });

  it("keeps a stale zero-cost record unverified on the coarse gate too", () => {
    const stale = fixture.cases.find((item) => item.id === "stale-zero-cost");
    expect(access.coarseAccess(stale?.model.accessRecord)).toBe("unknown");
    const verdict = firewall.guardProviderRequest({
      model: stale?.model,
      billing: { paidAccess: false },
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/pricing info is stale, refresh now/);
  });
});

describe("OpenRouter catalogue prices", () => {
  const later = Date.parse("2026-12-01T00:00:00Z");

  it("treats string and numeric zeroes as zero-cost, including request and image", () => {
    const priced = access.classifyModel(
      {
        providerId: "openrouter",
        modelId: "meta/llama:free",
        catalogue: { pricing: { prompt: "0", completion: 0, request: "0", image: "0" } },
      },
      later,
    );
    expect(priced.billingMode).toBe("ZERO_COST");
    expect(priced.evidence.source).toBe("provider_pricing");
    expect(priced.evidence.checkedAt).toBe(later);
    expect(priced.evidence.stale).toBeFalsy();
    expect(priced.failureReason).toBeNull();
    expect(access.coarseAccess(priced)).toBe("free");
    const imagePaid = access.classifyModel({
      providerId: "openrouter",
      modelId: "meta/llama:free",
      catalogue: { pricing: { prompt: "0", completion: "0", image: "0.001" } },
    });
    expect(imagePaid.billingMode).toBe("PAID");
    const requestPaid = access.classifyModel({
      providerId: "openrouter",
      modelId: "meta/llama:free",
      catalogue: { pricing: { prompt: 0, completion: 0, request: "0.000001" } },
    });
    expect(requestPaid.billingMode).toBe("PAID");
  });

  it("does not inherit another provider's stale doc date", () => {
    const openai = access.classifyModel({ providerId: "openai", modelId: "gpt-4o" }, later);
    expect(openai.failureReason).toBe("pricing_stale");
    const fresh = access.classifyModel(
      {
        providerId: "openrouter",
        modelId: "openrouter/free",
      },
      later,
    );
    expect(fresh.billingMode).toBe("ZERO_COST");
    expect(fresh.evidence.source).toBe("provider_router");
    expect(fresh.evidence.checkedAt).toBe(later);
    expect(fresh.failureReason).toBeNull();
    const bare = access.classifyModel(
      { providerId: "openrouter", modelId: "google/gemma:free" },
      later,
    );
    expect(bare.billingMode).toBe("UNKNOWN");
    expect(access.coarseAccess(bare)).toBe("unknown");
  });
});

describe("Free group and free route", () => {
  it("shows openrouter/free and a priced :free id in their own group", () => {
    const groups = groupModels([
      row({
        id: "ollama:llama3.2",
        type: "local",
        providerId: "ollama",
        providerName: "Ollama",
        access: "free",
      }),
      row({
        id: "openrouter:writer:free",
        providerModelId: "writer:free",
        modelName: "writer:free",
      }),
      row({
        id: "openrouter:openrouter/free",
        providerModelId: "openrouter/free",
        modelName: "openrouter/free",
      }),
      row({
        id: "openrouter:google/gemma:free",
        providerModelId: "google/gemma:free",
        modelName: "google/gemma:free",
        access: "unknown",
      }),
      row({
        id: "openrouter:anthropic/claude",
        providerModelId: "anthropic/claude",
        modelName: "anthropic/claude",
        access: "paid",
        visibility: "show",
      }),
    ]);
    expect(groups.map((group) => group.label)).toEqual(["Local", "Free", "OpenRouter"]);
    expect(groups[1]?.models.map((model) => model.id)).toEqual([
      "openrouter:openrouter/free",
      "openrouter:writer:free",
    ]);
    expect(groups[2]?.models.map((model) => model.id)).toEqual([
      "openrouter:google/gemma:free",
      "openrouter:anthropic/claude",
    ]);
  });

  it("tries the free lane before other cloud models and never a paid fallback", () => {
    const local = {
      id: "ollama:llama3.2",
      type: "local",
      contextK: 8,
      meta: { providerId: "ollama", kind: "local", modelName: "llama3.2", connected: true },
    };
    const freeRouter = {
      id: "openrouter:openrouter/free",
      type: "cloud",
      access: "free",
      contextK: 8,
      providerId: "openrouter",
      providerModelId: "openrouter/free",
      meta: {
        providerId: "openrouter",
        kind: "cloud",
        modelName: "openrouter/free",
        connected: true,
      },
    };
    const variant = {
      id: "openrouter:writer:free",
      type: "cloud",
      access: "free",
      contextK: 8,
      providerId: "openrouter",
      providerModelId: "writer:free",
      meta: {
        providerId: "openrouter",
        kind: "cloud",
        modelName: "writer:free",
        connected: true,
        catalogue: { pricing: { prompt: "0", completion: "0", request: "0", image: "0" } },
      },
    };
    const gemini = {
      id: "gemini:gemini-2.5-flash",
      type: "cloud",
      access: "free",
      contextK: 8,
      providerId: "gemini",
      providerModelId: "gemini-2.5-flash",
      accessRecord: {
        billingMode: "FREE_QUOTA",
        eligibility: "ELIGIBLE",
        verification: "VERIFIED",
        evidence: { source: "provider_free_plan" },
      },
      meta: { providerId: "gemini", kind: "cloud", modelName: "gemini-2.5-flash", connected: true },
    };
    const paid = {
      id: "openrouter:anthropic/claude",
      type: "cloud",
      contextK: 8,
      providerId: "openrouter",
      providerModelId: "anthropic/claude",
      meta: {
        providerId: "openrouter",
        kind: "cloud",
        modelName: "anthropic/claude",
        connected: true,
        catalogue: { pricing: { prompt: "0.000003", completion: "0.000015" } },
      },
    };
    const withLocal = router.selectEligible([paid, gemini, variant, freeRouter, local], {
      policy: "free-preferred",
      mode: "auto",
      limit: 4,
    });
    expect(withLocal.map((model: { id: string }) => model.id)[0]).toBe("ollama:llama3.2");
    expect(withLocal.map((model: { id: string }) => model.id)).toContain(
      "openrouter:openrouter/free",
    );
    expect(withLocal.map((model: { id: string }) => model.id)).not.toContain(paid.id);
    const cloud = router.selectEligible([paid, gemini, variant, freeRouter], {
      policy: "free-preferred",
      mode: "cloud-only",
      limit: 4,
    });
    expect(cloud[0].id).toBe("openrouter:openrouter/free");
    expect(cloud.map((model: { id: string }) => model.id)).not.toContain(paid.id);
    const moved = router.orderFallbacks(
      [freeRouter, paid, variant, gemini],
      freeRouter,
      "rate_limited",
    );
    expect(moved.map((model: { id: string }) => model.id)).not.toContain(paid.id);
    expect(moved.map((model: { id: string }) => model.id)).toContain(variant.id);
  });
});
