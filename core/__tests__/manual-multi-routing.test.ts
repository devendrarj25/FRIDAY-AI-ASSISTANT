/**
 * Manual and multi-model routing contract.
 *
 * A manual pick is a POOL, not a preference: when the owner selects A/B/C the
 * router may only use A/B/C, in that order, and parallel multi-model execution
 * only happens when it is asked for explicitly (it costs real tokens).
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const router = require_("../../electron/model-router.cjs");
const access = require_("../../electron/model-access.cjs");

const model = (
  id: string,
  kind: "local" | "cloud",
  provider: string,
  role = "brain",
  contextK = 32,
) => {
  const base = {
    id,
    label: id,
    provider,
    role,
    contextK,
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
  model("groq:qwen-coder", "cloud", "groq", "coder"),
  model("openai:gpt-4o", "cloud", "openai"),
];

const ids = (list: Array<{ id: string }>) => list.map((m) => m.id);

describe("manual pool", () => {
  it("uses only the selected models, never an unrelated one", () => {
    const picked = router.selectEligible(POOL, {
      mode: "manual",
      preferred: ["ollama:llama3.1", "groq:llama-3.3-70b"],
      limit: 5,
    });
    expect(ids(picked)).toEqual(["ollama:llama3.1", "groq:llama-3.3-70b"]);
  });

  it("keeps the owner's order so fallback walks A → B → C", () => {
    const picked = router.selectEligible(POOL, {
      mode: "manual",
      preferred: ["groq:llama-3.3-70b", "gemini:gemini-2.0-flash", "ollama:llama3.1"],
      limit: 5,
    });
    expect(ids(picked)).toEqual([
      "groq:llama-3.3-70b",
      "gemini:gemini-2.0-flash",
      "ollama:llama3.1",
    ]);
  });

  it("still refuses a paid pick while the owner is on free-only", () => {
    const picked = router.selectEligible(POOL, {
      mode: "manual",
      preferred: ["openai:gpt-4o", "groq:llama-3.3-70b"],
      policy: "free-only",
      limit: 5,
    });
    expect(ids(picked)).toEqual(["groq:llama-3.3-70b"]);
  });

  it("drops a manually picked model that is cooling down after a 429", () => {
    const health = new router.ProviderHealthManager();
    health.noteFailure("groq:llama-3.3-70b", { status: 429, message: "rate limit" });
    const picked = router.selectEligible(POOL, {
      mode: "manual",
      preferred: ["groq:llama-3.3-70b", "gemini:gemini-2.0-flash"],
      health,
      limit: 5,
    });
    expect(ids(picked)).toEqual(["gemini:gemini-2.0-flash"]);
  });

  it("does not let a manual pick bypass required capabilities", () => {
    const picked = router.selectEligible(POOL, {
      mode: "manual",
      task: "code",
      preferred: ["ollama:llama3.1"],
      limit: 5,
    });
    expect(ids(picked)).toEqual([]);
  });
});

describe("parallel multi-model", () => {
  it("returns the selected pool to run concurrently", () => {
    const picked = router.selectParallel(POOL, {
      preferred: ["ollama:llama3.1", "gemini:gemini-2.0-flash", "groq:llama-3.3-70b"],
      count: 3,
    });
    expect(ids(picked)).toEqual([
      "ollama:llama3.1",
      "gemini:gemini-2.0-flash",
      "groq:llama-3.3-70b",
    ]);
  });

  it("never duplicates a model across the parallel fan-out", () => {
    const picked = router.selectParallel(POOL, {
      preferred: ["ollama:llama3.1", "ollama:llama3.1"],
      count: 3,
    });
    expect(picked).toHaveLength(1);
  });

  it("is not what a normal auto request does", () => {
    const auto = router.selectEligible(POOL, { mode: "auto", limit: 1 });
    expect(auto).toHaveLength(1);
  });
});

describe("unknown pricing", () => {
  const unknownModel = model("customgw:mystery", "cloud", "customgw");

  it("is never treated as free while the owner is on free-only", () => {
    expect(router.classifyAccess(unknownModel)).toBe("unknown");
    const picked = router.selectEligible([unknownModel], { policy: "free-only" });
    expect(picked).toHaveLength(0);
  });

  it("never outranks a verified free model when it is allowed", () => {
    const picked = router.selectEligible([unknownModel, POOL[1]!], {
      policy: "free-preferred",
      // "Cloud only" is itself the owner's explicit cloud decision.
      mode: "cloud-only",
      limit: 2,
    });
    expect(picked[0]!.id).toBe("gemini:gemini-2.0-flash");
  });

  it("marks verified pricing on the record", () => {
    expect(router.describe(POOL[1]!, null).pricingVerified).toBe(true);
    expect(router.describe(unknownModel, null).pricingVerified).toBe(false);
  });
});
