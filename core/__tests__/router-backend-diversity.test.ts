import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const router = require_("../../electron/model-router.cjs") as {
  selectEligible: (models: unknown[], options?: Record<string, unknown>) => Array<{ id: string }>;
};
const access = require_("../../electron/model-access.cjs");

const cloud = (id: string, provider: string, billing: "paid" | "free" = "paid") => {
  const base = {
    id,
    provider,
    type: "cloud",
    role: "brain",
    connected: true,
    meta: { providerId: provider, kind: "cloud", modelName: id },
  };
  return billing === "free" ? access.stampVerified(base) : { ...base, access: "paid" };
};

const local = (id: string) => ({
  id,
  provider: "ollama",
  type: "local",
  role: "brain",
  installed: true,
  meta: { kind: "local", providerId: "ollama" },
});

describe("chat shortlist spans backends instead of one exhausted provider", () => {
  it("never fills every slot with a single provider when others are eligible", () => {
    const models = [
      cloud("openai/a", "openai"),
      cloud("openai/b", "openai"),
      cloud("openai/c", "openai"),
      cloud("openai/d", "openai"),
      cloud("groq/x", "groq", "free"),
      local("llama3.2-3b"),
    ];
    const ids = router
      .selectEligible(models, {
        task: "chat",
        limit: 4,
        policy: "allow-paid",
        preferred: models.map((m) => m.id),
      })
      .map((m) => m.id);
    expect(ids.length).toBe(4);
    expect(ids.filter((id) => id.startsWith("openai/")).length).toBeLessThan(4);
    expect(ids).toContain("llama3.2-3b");
    expect(ids).toContain("groq/x");
  });

  it("keeps the shortlist unchanged when only one backend is available", () => {
    const models = [cloud("openai/a", "openai"), cloud("openai/b", "openai")];
    const ids = router
      .selectEligible(models, {
        task: "chat",
        limit: 4,
        policy: "allow-paid",
        mode: "cloud-only",
      })
      .map((m) => m.id);
    expect(ids.sort()).toEqual(["openai/a", "openai/b"]);
  });
});
