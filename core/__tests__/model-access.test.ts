/**
 * Model access classification: official evidence, not name heuristics.
 * Minimum proof for the free-cloud routing upgrade.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { pinKnowledgeClock } from "./helpers/knowledge-clock";

const require_ = createRequire(import.meta.url);

pinKnowledgeClock();
const access = require_("../../electron/model-access.cjs");
const router = require_("../../electron/model-router.cjs");
const models = require_("../../electron/models.cjs");
const firewall = require_("../../electron/billing-firewall.cjs");
const policy = require_("../../electron/billing-policy.cjs");

const billing = (patch: Record<string, unknown> = {}) =>
  policy.normaliseBilling({ ...policy.DEFAULT_BILLING, ...patch });

describe("model access classification", () => {
  it("A. classifies a model as free from official evidence without a free name", () => {
    const record = access.classifyModel({
      providerId: "openrouter",
      modelId: "meta-llama/llama-3.3-70b-instruct",
      catalogue: { pricing: { prompt: "0", completion: "0" } },
    });
    expect(record.billingMode).toBe("ZERO_COST");
    expect(access.looksFreeName("meta-llama/llama-3.3-70b-instruct")).toBe(false);
    expect(record.verification).toBe("UNVERIFIED");
    expect(access.coarseAccess(record)).toBe("free");
    const verified = access.applyProbe(record, {
      ok: true,
      response: "ok",
      status: 200,
      headers: {},
    });
    expect(access.coarseAccess(verified)).toBe("free");
    expect(access.effectiveStatus(verified)).toBe("VERIFIED_ZERO_COST");
  });

  it("B. does not mark every provider model free because the provider has a free tier", () => {
    const groqOther = access.classifyModel({
      providerId: "groq",
      modelId: "llama-3.3-70b-versatile",
    });
    const groqFreePlan = access.classifyModel({
      providerId: "groq",
      modelId: "openai/gpt-oss-20b",
    });
    expect(groqOther.billingMode).toBe("UNKNOWN");
    expect(groqFreePlan.billingMode).toBe("FREE_QUOTA");
    expect(groqFreePlan.eligibility).toBe("ELIGIBLE");
    expect(groqFreePlan.pricing.input).toBe(0.075);
    expect(groqFreePlan.evidence.source).toBe("provider_free_plan");
    expect(access.coarseAccess(groqFreePlan)).toBe("free");
  });

  it("C. rejects a paid model in free-only mode", () => {
    const paid = {
      id: "openai:gpt-4o",
      contextK: 128,
      meta: { providerId: "openai", kind: "cloud", modelName: "gpt-4o" },
    };
    expect(router.classifyAccess(paid)).toBe("paid");
    expect(router.selectEligible([paid], { policy: "free-only" })).toEqual([]);
  });

  it("D. rejects an unknown-cost model in free-only mode", () => {
    const unknown = {
      id: "customgw:mystery",
      meta: { providerId: "customgw", kind: "cloud", modelName: "mystery" },
    };
    expect(router.classifyAccess(unknown)).toBe("unknown");
    expect(router.selectEligible([unknown], { policy: "free-only" })).toEqual([]);
  });

  it("E. exhausted free quota is not paid", () => {
    const record = access.applyProbe(
      access.makeRecord({
        billingMode: "FREE_QUOTA",
        eligibility: "ELIGIBLE",
        verification: "VERIFIED",
      }),
      { ok: false, status: 429, error: "rate limit: insufficient_quota", headers: {} },
    );
    expect(record.eligibility).toBe("EXHAUSTED");
    expect(record.billingMode).toBe("FREE_QUOTA");
    const model = {
      id: "groq:openai/gpt-oss-20b",
      type: "cloud",
      accessRecord: record,
      meta: {
        providerId: "groq",
        kind: "cloud",
        modelName: "openai/gpt-oss-20b",
        accessRecord: record,
      },
    };
    expect(firewall.billingClass(model)).toBe("unknown");
    expect(
      firewall.guardProviderRequest({ model, billing: billing(), policy: "free-only" }).allowed,
    ).toBe(false);
  });

  it("F. key validation / catalogue listing does not mark a model VERIFIED", () => {
    const listed = access.classifyModel({
      providerId: "openrouter",
      modelId: "openrouter/free",
    });
    expect(listed.verification).toBe("UNVERIFIED");
    expect(access.coarseAccess(listed)).toBe("free");
  });

  it("G. OpenRouter free router is dynamic and does not need a hardcoded model list", () => {
    const routerTarget = access.classifyModel({
      providerId: "openrouter",
      modelId: "openrouter/free",
    });
    expect(routerTarget.billingMode).toBe("ZERO_COST");
    expect(routerTarget.evidence.source).toBe("provider_router");
    const paid = access.classifyModel({
      providerId: "openrouter",
      modelId: "anthropic/claude-3.5-sonnet",
      catalogue: { pricing: { prompt: "0.000003", completion: "0.000015" } },
    });
    expect(paid.billingMode).toBe("PAID");
    const freeOnly = router.selectEligible(
      [
        {
          id: "openrouter:anthropic/claude-3.5-sonnet",
          contextK: 200,
          meta: {
            providerId: "openrouter",
            kind: "cloud",
            modelName: "anthropic/claude-3.5-sonnet",
            catalogue: { pricing: { prompt: "0.000003", completion: "0.000015" } },
          },
        },
      ],
      { policy: "free-only" },
    );
    expect(freeOnly).toEqual([]);
  });

  it("H. Groq prices are isolated provider knowledge, not a name guess", () => {
    expect(access.GROQ_MODEL_PRICING.source).toContain("console.groq.com/docs/models");
    expect(access.GROQ_MODEL_PRICING.ttlMs).toBeGreaterThan(0);
    const namedFree = access.classifyModel({
      providerId: "groq",
      modelId: "definitely-free-llama",
    });
    expect(namedFree.billingMode).toBe("UNKNOWN");
    const plan = access.classifyModel({
      providerId: "groq",
      modelId: "qwen/qwen3.8-27b",
    });
    expect(plan.billingMode).toBe("FREE_QUOTA");
    expect(plan.pricing.input).toBe(0.8);
    expect(plan.pricing.output).toBe(4);
    expect(plan.evidence.source).toBe("provider_free_plan");
  });

  it("I. Gemini Free Tier is model-specific and project-tier-specific", () => {
    const flash = access.classifyModel({
      providerId: "gemini",
      modelId: "gemini-2.5-flash",
    });
    expect(flash.billingMode).toBe("FREE_QUOTA");
    expect(flash.eligibility).toBe("ELIGIBLE");
    expect(access.isFreeCandidate(flash)).toBe(true);
    const freeProject = access.classifyModel({
      providerId: "gemini",
      modelId: "gemini-2.5-flash",
      account: { projectTier: "free" },
    });
    expect(freeProject.eligibility).toBe("ELIGIBLE");
    const usableButUnproven = access.applyProbe(flash, {
      ok: true,
      status: 200,
      response: "ok",
      streamed: true,
      headers: {},
    });
    expect(usableButUnproven.verification).toBe("VERIFIED");
    expect(usableButUnproven.eligibility).toBe("ELIGIBLE");
    expect(access.isFreeOnlyEligible(usableButUnproven)).toBe(true);
    const paidProject = access.classifyModel({
      providerId: "gemini",
      modelId: "gemini-2.5-flash",
      declaredAccess: "paid",
      account: { projectTier: "paid" },
    });
    expect(paidProject.billingMode).toBe("PAID");
    expect(paidProject.eligibility).toBe("ELIGIBLE");
    expect(
      router.selectEligible(
        [
          {
            id: "gemini:gemini-2.5-flash",
            contextK: 1000,
            meta: {
              providerId: "gemini",
              kind: "cloud",
              modelName: "gemini-2.5-flash",
              accessRecord: paidProject,
            },
            accessRecord: paidProject,
          },
        ],
        { policy: "free-only" },
      ),
    ).toEqual([]);
  });

  it("J. Cohere Trial vs Production is account-mode, not a model-name guess", () => {
    const trial = access.classifyModel({
      providerId: "cohere",
      modelId: "command-r-plus",
      account: { keyType: "trial", trial: true },
    });
    expect(trial.billingMode).toBe("FREE_QUOTA");
    const production = access.classifyModel({
      providerId: "cohere",
      modelId: "command-r-plus",
      account: { keyType: "production", trial: false },
    });
    expect(production.billingMode).toBe("PAID");
    expect(access.looksFreeName("command-r-plus")).toBe(false);
  });

  it("K. Hugging Face $0 routes are distinct from account credits", () => {
    const zero = access.classifyModel({
      providerId: "huggingface",
      modelId: "org/model",
      catalogue: {
        providers: [{ provider: "hf-inference", status: "live", pricing: { input: 0, output: 0 } }],
      },
    });
    expect(zero.billingMode).toBe("ZERO_COST");
    const credit = access.classifyModel({
      providerId: "huggingface",
      modelId: "org/other",
      account: { creditsRemaining: 2, creditSource: "GRANT" },
    });
    expect(credit.billingMode).toBe("FREE_CREDIT");
    const funded = access.classifyModel({
      providerId: "huggingface",
      modelId: "org/prepaid",
      catalogue: { pricing: { input: 0.001, output: 0.001 } },
      account: { creditsRemaining: 9, creditSource: "USER_FUNDED" },
    });
    expect(funded.billingMode).toBe("PAID");
    const unknownBalance = access.classifyModel({
      providerId: "huggingface",
      modelId: "org/balance",
      account: { creditsRemaining: 5 },
    });
    expect(unknownBalance.billingMode).not.toBe("FREE_CREDIT");
    const unknown = access.classifyModel({
      providerId: "huggingface",
      modelId: "org/unknown",
    });
    expect(unknown.billingMode).toBe("UNKNOWN");
  });

  it("L. local models remain usable and skip cloud billing", () => {
    for (const provider of ["ollama", "lmstudio", "llamacpp", "vllm", "localai", "jan", "mlx"]) {
      const model = {
        id: `${provider}/m`,
        type: provider,
        meta: { providerId: provider, kind: "local", modelName: "m" },
      };
      expect(router.classifyAccess(model)).toBe("free");
      expect(firewall.guardProviderRequest({ model, billing: billing() }).allowed).toBe(true);
    }
  });

  it("M. paid routing still works when paid access is explicitly authorised", () => {
    const paid = {
      id: "openai:gpt-4o",
      type: "cloud",
      access: "paid",
      meta: { providerId: "openai", kind: "cloud", modelName: "gpt-4o" },
    };
    expect(
      firewall.guardProviderRequest({
        model: paid,
        billing: billing({ paidAccess: true, autoPaidUsage: true }),
        policy: "allow-paid",
      }).allowed,
    ).toBe(true);
    const picked = router.selectEligible(
      [
        paid,
        {
          id: "ollama:qwen",
          provider: "ollama",
          contextK: 32,
          meta: { providerId: "ollama", kind: "local", modelName: "qwen" },
        },
      ],
      { policy: "allow-paid", preferred: ["openai:gpt-4o"] },
    );
    expect(picked.map((m: { id: string }) => m.id)).toContain("openai:gpt-4o");
  });

  it("N. billing firewall remains the final safety boundary", () => {
    const mislabeled = {
      id: "openai:gpt-4o",
      type: "cloud",
      meta: { providerId: "openai", kind: "cloud", modelName: "gpt-4o" },
    };
    expect(firewall.billingClass(mislabeled)).toBe("paid");
    expect(
      firewall.guardProviderRequest({
        model: mislabeled,
        billing: billing({ autoPaidUsage: true }),
        policy: "free-only",
      }).allowed,
    ).toBe(false);
  });

  it("fails closed: filterByTier(free) never returns the leftover catalogue", () => {
    const list = [
      {
        id: "meta/llama",
        name: "llama",
        provider: "openrouter",
        pricing: { prompt: "0.0001", completion: "0.0001" },
      },
      { id: "meta/llama:free", name: "llama free", provider: "openrouter" },
    ];
    expect(models.filterByTier(list, "free", "openrouter")).toEqual([]);
    const priced = [
      {
        id: "meta/llama:free",
        name: "llama",
        provider: "openrouter",
        pricing: { prompt: "0", completion: "0" },
      },
    ];
    expect(
      models.filterByTier(priced, "free", "openrouter").map((m: { id: string }) => m.id),
    ).toEqual(["meta/llama:free"]);
  });

  it("429 on a verified free model is rate-limited, not paid", () => {
    const verified = access.makeRecord({
      billingMode: "FREE_QUOTA",
      eligibility: "ELIGIBLE",
      verification: "VERIFIED",
    });
    const limited = access.applyProbe(verified, {
      ok: false,
      status: 429,
      error: "too many requests",
      headers: { "x-ratelimit-remaining-requests": "0", "retry-after": "10" },
    });
    expect(limited.billingMode).toBe("FREE_QUOTA");
    expect(limited.eligibility).toBe("RATE_LIMITED");
    expect(access.effectiveStatus(limited)).toBe("FREE_RATE_LIMITED");
    expect(limited.rateLimits.remainingRequests).toBe(0);
  });

  it("xAI native pricing fields normalize to PAID without generic pricing.input", () => {
    const record = access.classifyModel({
      providerId: "xai",
      modelId: "grok-4.6",
      catalogue: {
        prompt_text_token_price: 2,
        completion_text_token_price: 6,
        prompt_image_token_price: 0,
        completion_image_token_price: 0,
      },
    });
    expect(record.billingMode).toBe("PAID");
    const pricing = access.cataloguePricing({
      prompt_text_token_price: 2,
      completion_text_token_price: 6,
    });
    expect(pricing.input).toBe(2);
    expect(pricing.output).toBe(6);
    expect(pricing.native.prompt_text_token_price).toBe(2);
    expect(access.looksFreeName("grok-4.6")).toBe(false);
  });

  it("Mistral catalogue without prices still classifies PAID from official API pricing", () => {
    const record = access.classifyModel({
      providerId: "mistral",
      modelId: "mistral-small-latest",
      catalogue: { id: "mistral-small-latest" },
    });
    expect(record.billingMode).toBe("PAID");
    expect(record.evidence.source).toBe("provider_pricing");
    const zero = access.classifyModel({
      providerId: "mistral",
      modelId: "open-zero",
      catalogue: { pricing: { prompt: 0, completion: 0 } },
    });
    expect(zero.billingMode).toBe("ZERO_COST");
  });

  it("Gemini 3.x Flash is Free Tier eligible without free in the name", () => {
    const flash = access.classifyModel({
      providerId: "gemini",
      modelId: "gemini-3.8-flash",
    });
    expect(flash.billingMode).toBe("FREE_QUOTA");
    expect(flash.eligibility).toBe("ELIGIBLE");
    expect(access.looksFreeName("gemini-3.8-flash")).toBe(false);
    const preview = access.classifyModel({
      providerId: "gemini",
      modelId: "gemini-3.8-flash-preview-202609",
    });
    expect(preview.billingMode).toBe("FREE_QUOTA");
    expect(preview.eligibility).toBe("ELIGIBLE");
    const pro = access.classifyModel({
      providerId: "gemini",
      modelId: "gemini-3.0-pro",
    });
    expect(pro.billingMode).toBe("UNKNOWN");
  });

  it("Gemini image-generation models are never Free Tier, even under a Flash prefix", () => {
    for (const modelId of [
      "gemini-3.1-flash-image",
      "gemini-3.1-flash-lite-image",
      "models/gemini-3.1-flash-image-preview",
    ]) {
      const record = access.classifyModel({ providerId: "gemini", modelId });
      expect(record.billingMode, modelId).toBe("UNKNOWN");
    }
    const lite = access.classifyModel({ providerId: "gemini", modelId: "gemini-3.1-flash-lite" });
    expect(lite.billingMode).toBe("FREE_QUOTA");
  });

  it("Groq prices are an exact-id list: contact-sales and unlisted ids stay unknown", () => {
    const listed = access.classifyModel({ providerId: "groq", modelId: "qwen/qwen3.8-27b" });
    expect(listed.billingMode).toBe("FREE_QUOTA");
    for (const modelId of [
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
      "groq/compound",
      "groq/compound-mini",
      "qwen/qwen3.6-27b",
    ]) {
      const record = access.classifyModel({ providerId: "groq", modelId });
      expect(record.billingMode, modelId).toBe("UNKNOWN");
    }
  });

  it("USER_FUNDED balance is PAID, not FREE_CREDIT", () => {
    const record = access.classifyModel({
      providerId: "fireworks",
      modelId: "accounts/fireworks/models/llama-v3",
      account: { creditsRemaining: 12, creditSource: "USER_FUNDED" },
    });
    expect(record.billingMode).toBe("PAID");
    expect(record.creditSource).toBe("USER_FUNDED");
    const promo = access.classifyModel({
      providerId: "cerebras",
      modelId: "llama3.1-8b",
      account: { creditsRemaining: 4, creditSource: "PROMOTIONAL" },
    });
    expect(promo.billingMode).toBe("FREE_CREDIT");
    expect(promo.creditSource).toBe("PROMOTIONAL");
    const trial = access.classifyModel({
      providerId: "fireworks",
      modelId: "accounts/fireworks/models/trial",
      account: { creditsRemaining: 2, creditSource: "TRIAL" },
    });
    expect(trial.billingMode).toBe("FREE_QUOTA");
    expect(trial.creditSource).toBe("TRIAL");
  });

  it("does not classify future Groq family variants from a broad prefix", () => {
    const future = access.classifyModel({
      providerId: "groq",
      modelId: "openai/gpt-oss-999b-paid",
    });
    expect(future.billingMode).toBe("UNKNOWN");
    expect(access.isFreeCandidate(future)).toBe(false);
  });

  it("preserves pricing when a probe returns HTTP 402", () => {
    const freeEvidence = access.makeRecord({
      billingMode: "FREE_QUOTA",
      eligibility: "ELIGIBLE",
      verification: "UNVERIFIED",
    });
    const failed = access.applyProbe(freeEvidence, {
      ok: false,
      status: 402,
      error: "payment required",
      headers: {},
    });
    expect(failed.billingMode).toBe("FREE_QUOTA");
    expect(failed.eligibility).toBe("NOT_ELIGIBLE");
    expect(failed.failureReason).toBe("billing");
  });

  it("retains chat and stream verification independently", () => {
    const candidate = access.makeRecord({
      billingMode: "ZERO_COST",
      eligibility: "ELIGIBLE",
    });
    const verified = access.applyProbe(candidate, {
      ok: true,
      status: 200,
      response: "ok",
      streamed: false,
      streamError: "stream returned no usable assistant text",
      headers: {},
    });
    expect(verified.liveProbe.chatVerified).toBe(true);
    expect(verified.liveProbe.streamVerified).toBe(false);
    expect(verified.liveProbe.streamFailure).toMatch(/no usable/i);
  });

  it("lazy verification has no global three-model cap", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      access.stampVerified(
        {
          id: `groq:openai/gpt-oss-${i}`,
          type: "cloud",
          meta: { providerId: "groq", kind: "cloud", modelName: `openai/gpt-oss-${i}` },
          options: { model: `openai/gpt-oss-${i}`, accessRecord: null },
        },
        "FREE_QUOTA",
      ),
    );
    return models
      .lazyVerifyForRoute(many, { policy: "free-only", limit: 4 })
      .then((out: Array<{ accessRecord?: { verification?: string } }>) => {
        expect(out).toHaveLength(8);
        expect(out.every((m) => m.accessRecord?.verification === "VERIFIED")).toBe(true);
      });
  });

  it("streaming SSE parser yields assistant text from delta.content and [DONE]", () => {
    const sse = models.parseOpenAiSse(
      [
        'data: {"choices":[{"delta":{"content":"Hel"}}]}',
        'data: {"choices":[{"delta":{"content":"lo"}}]}',
        "data: [DONE]",
        "",
      ].join("\n"),
    );
    expect(sse.content).toBe("Hello");
    expect(sse.sawDone).toBe(true);
    const parts = models.parseOpenAiSse(
      'data: {"choices":[{"delta":{"content":[{"type":"text","text":"Hi"}]}}]}\n',
    );
    expect(parts.content).toBe("Hi");
  });

  it("free-only empty pool copy names NO_FREE_MODEL_AVAILABLE", () => {
    const text = router.explainUnavailable({ policy: "free-only", mode: "cloud-only" });
    expect(text).toContain("NO_FREE_MODEL_AVAILABLE");
    expect(text.toLowerCase()).not.toContain("falling back to paid");
  });

  it("filters route mode and provider-declared capability before live verification", () => {
    const free = access.classifyModel({
      providerId: "openrouter",
      modelId: "vendor/moderation",
      catalogue: {
        type: "moderation",
        pricing: { prompt: 0, completion: 0 },
      },
    });
    const spec = {
      id: "openrouter:vendor/moderation",
      provider: "online",
      type: "cloud",
      contextK: 8,
      accessRecord: free,
      options: { model: "vendor/moderation", accessRecord: free },
      meta: {
        providerId: "openrouter",
        kind: "cloud",
        modelName: "vendor/moderation",
        catalogue: { type: "moderation" },
        accessRecord: free,
      },
    };
    expect(router.selectVerificationCandidates([spec], { task: "chat" })).toEqual([]);
    expect(
      router.selectVerificationCandidates([spec], {
        task: "chat",
        mode: "cloud-only",
        offline: true,
      }),
    ).toEqual([]);
  });

  it("keeps Gemini families that left the pricing page unknown", () => {
    for (const modelId of [
      "gemini-2.0-flash",
      "gemini-1.5-pro",
      "gemini-omni-1.1-flash",
      "gemini-3.0-flash",
    ]) {
      const record = access.classifyModel({
        providerId: "gemini",
        modelId,
        account: { projectTier: "free" },
      });
      expect(record.billingMode, modelId).toBe("UNKNOWN");
    }
    const embed = access.classifyModel({ providerId: "gemini", modelId: "gemini-embedding-2" });
    expect(embed.billingMode).toBe("FREE_QUOTA");
    expect(embed.eligibility).toBe("ELIGIBLE");
  });

  it("refuses an empty pricing page and schedules a refresh before the TTL", () => {
    const empty = access.acceptPageEvidence({
      id: "openai",
      pageText: "",
      parsed: { metered: true },
      now: Date.parse("2026-10-07T00:00:00Z"),
      sourceUrl: "https://platform.openai.com/docs/pricing",
    });
    expect(empty.ok).toBe(false);
    const staged = access.acceptPageEvidence({
      id: "openai",
      pageText: "Prices per 1M tokens. Flagship models stay metered.",
      parsed: { metered: true },
      now: Date.parse("2026-10-07T00:00:00Z"),
      sourceUrl: "https://platform.openai.com/docs/pricing",
    });
    expect(staged.ok).toBe(true);
    expect(staged.staged.checkedAt).toBe(Date.parse("2026-10-07T00:00:00Z"));
    const early = Date.parse("2026-10-01T00:00:00Z");
    expect(access.planKnowledgeRefresh(early)).toEqual([]);
    const near = Date.parse("2026-10-19T00:00:00Z");
    const due = access.planKnowledgeRefresh(near) as Array<{
      id: string;
      due: boolean;
      expired: boolean;
    }>;
    expect(due.some((row) => row.id === "mistral" && row.due && !row.expired)).toBe(true);
    expect(due.some((row) => row.id === "groq" && row.due && !row.expired)).toBe(true);
  });

  it("changes a price only when the page parses", () => {
    const now = Date.parse("2026-10-08T00:00:00Z");
    const before = (
      access.knowledgeCatalogue(now) as Array<{ id: string; checkedAt: number }>
    ).find((row) => row.id === "groq");
    const refused = access.commitParsedKnowledge({
      id: "groq",
      pageText: "not a pricing page",
      parsed: { priced: { "openai/gpt-oss-20b": { input: 0, output: 0 } } },
      now,
      sourceUrl: "https://console.groq.com/docs/models",
    });
    expect(refused.applied).toBe(false);
    const stayed = (
      access.knowledgeCatalogue(now) as Array<{ id: string; checkedAt: number }>
    ).find((row) => row.id === "groq");
    expect(stayed?.checkedAt).toBe(before?.checkedAt);
    try {
      const applied = access.commitParsedKnowledge({
        id: "groq",
        pageText: "Supported models. Price per 1M tokens for each listed chat model.",
        parsed: {
          priced: { "openai/gpt-oss-20b": { input: 0, output: 0, unit: "per_1m_tokens" } },
        },
        now,
        sourceUrl: "https://console.groq.com/docs/models",
      });
      expect(applied.applied).toBe(true);
      const next = (
        access.knowledgeCatalogue(now) as Array<{ id: string; checkedAt: number }>
      ).find((row) => row.id === "groq");
      expect(next?.checkedAt).toBe(now);
    } finally {
      access.clearKnowledgeOverlay();
    }
  });
});
