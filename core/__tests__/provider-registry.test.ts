/**
 * Provider registry contract.
 *
 * ONE canonical provider view: stored keys count as configured, environment
 * keys count as configured, health/cooldown is real, and each route mode only
 * ever reports the provider kinds it is allowed to use.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const registry = require_("../../electron/provider-registry.cjs");
const providers = require_("../../electron/providers.cjs");

const CLOUD_SPECS = {
  openai: { name: "OpenAI", env: "OPENAI_API_KEY", chat: "https://api.openai.com/v1" },
  gemini: {
    name: "Google Gemini",
    env: "GEMINI_API_KEY",
    chat: "https://generativelanguage.googleapis.com/v1beta/openai",
  },
  groq: { name: "Groq", env: "GROQ_API_KEY", chat: "https://api.groq.com/openai/v1" },
};

const inventory = {
  at: 1_000,
  providers: [
    {
      id: "ollama",
      name: "Ollama",
      kind: "local",
      endpoint: "http://127.0.0.1:11434",
      online: false,
      latencyMs: null,
      error: "not running",
      models: [],
    },
    {
      id: "gemini",
      name: "Google Gemini",
      kind: "cloud",
      online: true,
      latencyMs: 220,
      error: null,
      models: [{ id: "gemini-2.0-flash" }, { id: "gemini-2.5-pro" }],
    },
  ],
};

describe("provider registry", () => {
  it("treats a stored workspace key as configured without any env var", () => {
    const snap = registry.buildRegistry({
      inventory,
      cloudSpecs: CLOUD_SPECS,
      storedKeyIds: ["gemini"],
      env: {},
    });
    const gemini = snap.providers.find((p: { id: string }) => p.id === "gemini");
    expect(gemini.configured).toBe(true);
    expect(gemini.keySource).toBe("stored");
    expect(gemini.authenticated).toBe(true);
    expect(gemini.modelCount).toBe(2);
    expect(gemini.validation).toMatchObject({
      keyConfigured: true,
      authenticated: true,
      catalogueFetched: true,
      pricingKnown: false,
      chatVerified: false,
      streamVerified: false,
    });
  });

  it("still honours environment keys", () => {
    const snap = registry.buildRegistry({
      inventory,
      cloudSpecs: CLOUD_SPECS,
      storedKeyIds: [],
      env: { OPENAI_API_KEY: "sk-test" },
    });
    const openai = snap.providers.find((p: { id: string }) => p.id === "openai");
    expect(openai.configured).toBe(true);
    expect(openai.keySource).toBe("environment");
    expect(openai.reachable).toBe(false);
  });

  it("never leaks a key value into a record", () => {
    const snap = registry.buildRegistry({
      inventory,
      cloudSpecs: CLOUD_SPECS,
      storedKeyIds: ["gemini"],
      env: { OPENAI_API_KEY: "sk-secret-value" },
    });
    expect(JSON.stringify(snap)).not.toContain("sk-secret-value");
  });

  it("lists every declared cloud provider even when unconfigured", () => {
    const snap = registry.buildRegistry({ inventory, cloudSpecs: CLOUD_SPECS });
    for (const id of Object.keys(CLOUD_SPECS)) {
      expect(snap.providers.some((p: { id: string }) => p.id === id)).toBe(true);
    }
  });

  it("reports rate-limit cooldown instead of healthy", () => {
    const now = 10_000;
    const snap = registry.buildRegistry({
      inventory,
      cloudSpecs: CLOUD_SPECS,
      storedKeyIds: ["gemini"],
      health: [
        {
          modelId: "gemini:gemini-2.0-flash",
          status: "rate_limited",
          category: "rate_limited",
          cooldownUntil: now + 60_000,
          failures: 2,
          lastError: "429",
          lastOkAt: now - 5_000,
        },
      ],
      now,
    });
    const gemini = snap.providers.find((p: { id: string }) => p.id === "gemini");
    expect(gemini.coolingDown).toBe(true);
    expect(gemini.health).toBe("rate_limited");
    expect(gemini.lastSuccess).toBe(now - 5_000);
  });

  it("keeps cloud-only free of local providers and vice versa", () => {
    const snap = registry.buildRegistry({
      inventory,
      cloudSpecs: CLOUD_SPECS,
      storedKeyIds: ["gemini"],
    });
    const cloudOnly = registry.modeReadiness(snap, "cloud-only");
    expect(cloudOnly.ready).toBe(true);
    expect(cloudOnly.providers).toEqual(["gemini"]);

    const localOnly = registry.modeReadiness(snap, "local-only");
    expect(localOnly.ready).toBe(false);
    expect(localOnly.reason).toMatch(/local engine/i);
  });

  it("does not require a local engine for a cloud-only answer", () => {
    const snap = registry.buildRegistry({
      inventory,
      cloudSpecs: CLOUD_SPECS,
      storedKeyIds: ["gemini"],
    });
    expect(registry.kindsForMode("cloud-only")).toEqual(["cloud"]);
    expect(registry.modeReadiness(snap, "auto").ready).toBe(true);
  });
});

describe("provider detection uses the canonical catalogue", () => {
  it("derives cloud providers from the model manager table", () => {
    const detected = providers.detectCloudProviders({}, null);
    const ids = detected.map((p: { id: string }) => p.id);
    for (const id of ["openai", "anthropic", "gemini", "groq", "mistral", "deepseek"]) {
      expect(ids).toContain(id);
    }
    expect(detected.every((p: { status: string }) => p.status === "not-configured")).toBe(true);
  });

  it("marks a provider configured from the environment", () => {
    const detected = providers.detectCloudProviders({ GROQ_API_KEY: "gsk-test" }, null);
    const groq = detected.find((p: { id: string }) => p.id === "groq");
    expect(groq.configured).toBe(true);
    expect(groq.keySource).toBe("environment");
  });
});
