/**
 * Route mode contract: Local Only / Cloud Only / Hybrid / Auto.
 *
 * A fallback must never escape the mode the owner chose, and a cloud-only
 * setup must answer without any local inference engine installed.
 */
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
    role: "brain",
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
];

const ids = (list: Array<{ id: string }>) => list.map((m) => m.id);

describe("route modes", () => {
  it("cloud-only never selects a local engine", () => {
    const picked = router.selectEligible(POOL, { mode: "cloud-only" });
    expect(picked.length).toBeGreaterThan(0);
    expect(ids(picked).every((id: string) => !id.startsWith("ollama:"))).toBe(true);
  });

  it("cloud-only answers with no local engine present at all", () => {
    const cloudOnlyPool = POOL.filter((m) => m.meta.kind === "cloud");
    const picked = router.selectEligible(cloudOnlyPool, { mode: "cloud-only" });
    expect(picked.length).toBeGreaterThan(0);
  });

  it("local-only never selects a cloud provider", () => {
    const picked = router.selectEligible(POOL, { mode: "local-only" });
    expect(ids(picked)).toEqual(["ollama:llama3.1"]);
  });

  it("hybrid and auto include connected free cloud but exclude paid cloud", () => {
    for (const mode of ["hybrid", "auto"]) {
      const picked = ids(router.selectEligible(POOL, { mode }));
      expect(picked.some((id: string) => id.startsWith("ollama:"))).toBe(true);
      expect(picked.some((id: string) => id.startsWith("gemini:"))).toBe(true);
      expect(picked.some((id: string) => id.startsWith("groq:"))).toBe(true);
    }
  });

  it("hybrid and auto use the cloud model the owner picked, alongside local", () => {
    for (const mode of ["hybrid", "auto", "multi"]) {
      const picked = ids(
        router.selectEligible(POOL, { mode, preferred: ["gemini:gemini-2.0-flash"] }),
      );
      expect(picked.some((id: string) => id.startsWith("gemini:"))).toBe(true);
      if (mode !== "multi")
        expect(picked.some((id: string) => id.startsWith("ollama:"))).toBe(true);
    }
  });

  it("keeps a 429 fallback inside the same mode", () => {
    const health = new router.ProviderHealthManager();
    health.noteFailure("gemini:gemini-2.0-flash", { status: 429, message: "rate limit" });
    const picked = ids(router.selectEligible(POOL, { mode: "cloud-only", health }));
    expect(picked).not.toContain("gemini:gemini-2.0-flash");
    expect(picked).toContain("groq:llama-3.3-70b");
    expect(picked.every((id: string) => !id.startsWith("ollama:"))).toBe(true);
  });

  it("still enforces the free-only billing policy inside a mode", () => {
    const paid = [...POOL, model("openai:gpt-4o", "cloud", "openai")];
    const picked = ids(router.selectEligible(paid, { mode: "cloud-only", policy: "free-only" }));
    expect(picked).not.toContain("openai:gpt-4o");
    const allowed = ids(router.selectEligible(paid, { mode: "cloud-only", policy: "allow-paid" }));
    expect(allowed).toContain("openai:gpt-4o");
  });

  it("falls back to auto for an unknown mode", () => {
    expect(router.normaliseRouteMode("nonsense")).toBe("auto");
    expect(router.typesForMode("nonsense")).toEqual(["local", "cloud"]);
  });
});
