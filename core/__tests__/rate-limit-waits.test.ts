/**
 * A rate limit rests a model for exactly the wait the provider names, and no
 * longer: Groq's "try again in 7.66s", Gemini's "retry in 21.96s" and a
 * Retry-After header all become the cooldown. A per-minute limit that says
 * "quota exceeded" (Gemini's free tier) is a burst, never a 30-minute freeze.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

const router = createRequire(import.meta.url)("../../electron/model-router.cjs") as {
  classifyError: (input: unknown) => {
    category: string;
    cooldownMs: number;
    exact?: boolean;
  };
  retryHintFromText: (text: string) => number;
  ProviderHealthManager: new () => {
    noteFailure: (id: string, error: unknown, now?: number) => { cooldownMs: number };
  };
  selectParallel: (
    models: unknown[],
    options: Record<string, unknown>,
  ) => Array<{ id: string; providerId: string }>;
};

const wait = (message: string, status = 429) => router.classifyError({ message, status });

describe("the wait a provider names", () => {
  it.each([
    ["Rate limit reached for model x on tokens per minute (TPM). Please try again in 7.66s.", 7660],
    ["Please try again in 14m22.5s", 862_500],
    ["Please retry in 21.96s", 21_960],
    ['{"retryDelay": "34s"}', 34_000],
    ["too many requests, retry after 12 seconds", 12_000],
    ["HTTP 429: busy (retry-after 5)", 5000],
    ["Please try again in 250ms", 250],
  ])("reads %s", (text, ms) => {
    expect(router.retryHintFromText(text)).toBe(ms);
  });

  it("finds nothing in an ordinary message", () => {
    expect(router.retryHintFromText("something else failed")).toBe(0);
  });
});

describe("what a 429 means", () => {
  it("rests a per-minute limit for the named wait", () => {
    const row = wait("Rate limit reached on tokens per minute (TPM). Please try again in 7.66s.");
    expect(row).toMatchObject({ category: "rate_limited", cooldownMs: 7660, exact: true });
  });

  it("does not freeze a Gemini model for 30 minutes on a per-minute free-tier limit", () => {
    const row = wait(
      "Quota exceeded for metric generate_content_free_tier_requests, limit: 15, quotaId GenerateRequestsPerMinutePerProjectPerModel-FreeTier. Please retry in 21.96s",
    );
    expect(row.category).toBe("rate_limited");
    expect(row.cooldownMs).toBe(21_960);
  });

  it("keeps a daily Gemini or Groq limit as a daily limit", () => {
    expect(wait("GenerateRequestsPerDayPerProjectPerModel-FreeTier").category).toBe("daily_limit");
    expect(
      wait("Rate limit reached on tokens per day (TPD). Please try again in 14m22.5s").category,
    ).toBe("daily_limit");
  });

  it("still treats an exhausted billing plan as quota", () => {
    expect(wait("You exceeded your current quota, please check your plan").category).toBe(
      "quota_exceeded",
    );
  });

  it("reads a Hugging Face credit message as billing", () => {
    expect(
      router.classifyError({
        message: "You have exceeded your monthly included credits",
        status: 402,
      }).category,
    ).toBe("billing_required");
  });
});

describe("how long a model rests after repeated limits", () => {
  it("uses a named wait as told, however many times it repeats", () => {
    const health = new router.ProviderHealthManager();
    const message = "HTTP 429: Please try again in 5s";
    expect(health.noteFailure("m", message).cooldownMs).toBe(5000);
    expect(health.noteFailure("m", message).cooldownMs).toBe(5000);
    expect(health.noteFailure("m", message).cooldownMs).toBe(5000);
  });

  it("grows a guessed per-minute wait only to four times", () => {
    const health = new router.ProviderHealthManager();
    const waits = Array.from(
      { length: 6 },
      () => health.noteFailure("m", "HTTP 429 rate limit").cooldownMs,
    );
    expect(waits).toEqual([20_000, 40_000, 80_000, 80_000, 80_000, 80_000]);
  });
});

describe("several models at once", () => {
  const model = (id: string, providerId: string, rank: number) => ({
    id,
    providerId,
    type: "cloud",
    kind: "cloud",
    access: "free",
    role: "brain",
    capabilities: { chat: true, tools: true },
    contextK: 8 + rank,
    accessRecord: {
      billingMode: "FREE_QUOTA",
      eligibility: "ELIGIBLE",
      verification: "UNVERIFIED",
    },
    meta: { providerId },
  });

  it("takes one model from each provider before a second from the same one", () => {
    const pool = [
      model("groq:a", "groq", 9),
      model("groq:b", "groq", 8),
      model("gemini:a", "gemini", 3),
      model("nvidia:a", "nvidia", 2),
    ];
    const picked = router
      .selectParallel(pool, { task: "chat", policy: "free-only", mode: "multi", count: 3 })
      .map((m) => m.providerId);
    expect(new Set(picked).size).toBe(Math.min(3, picked.length));
  });
});

describe("the short wait is taken in place", () => {
  it("main waits out a stated wait of three seconds or less on the same model, once", () => {
    const main = readFileSync(path.resolve(import.meta.dirname, "../../electron/main.cjs"), "utf8");
    expect(main).toContain("function shortRateWaitMs(result)");
    expect(main).toMatch(/verdict\.exact && verdict\.cooldownMs <= 3000/);
    expect(main).toMatch(/const pause = shortRateWaitMs\(result\);\s*if \(pause\) \{/);
  });
});
