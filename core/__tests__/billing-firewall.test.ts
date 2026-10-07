import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { pinKnowledgeClock } from "./helpers/knowledge-clock";

const require_ = createRequire(import.meta.url);

pinKnowledgeClock();
const firewall = require_("../../electron/billing-firewall.cjs");
const policy = require_("../../electron/billing-policy.cjs");

const local = { id: "ollama/llama3", type: "local", access: "free" };
const freeCloud = { id: "openrouter/x:free", type: "cloud", access: "free" };
const paid = { id: "openai/gpt-5", type: "cloud", access: "paid", label: "GPT-5" };
const unknown = { id: "mystery/model", type: "cloud", access: "unknown" };

const billing = (patch: Record<string, unknown> = {}) =>
  policy.normaliseBilling({ ...policy.DEFAULT_BILLING, ...patch });

describe("billing firewall", () => {
  it("classifies unknown billing as billable, never free", () => {
    expect(firewall.billingClass(unknown)).toBe("unknown");
    expect(firewall.isBillable(unknown)).toBe(true);
    expect(firewall.isBillable(local)).toBe(false);
    expect(firewall.isBillable(freeCloud)).toBe(false);
    expect(firewall.isBillable(null)).toBe(true);
  });

  it("always allows local and verified free models", () => {
    for (const model of [local, freeCloud]) {
      expect(firewall.guardProviderRequest({ model, billing: billing() }).allowed).toBe(true);
    }
  });

  it("blocks paid and unknown-cost models until the owner authorises spend", () => {
    const paidVerdict = firewall.guardProviderRequest({
      model: paid,
      billing: billing(),
      policy: "free-preferred",
    });
    expect(paidVerdict.allowed).toBe(false);
    expect(paidVerdict.requiresApproval).toBe(true);
    const unknownVerdict = firewall.guardProviderRequest({
      model: unknown,
      billing: billing(),
      policy: "free-preferred",
    });
    expect(unknownVerdict.allowed).toBe(false);
    expect(unknownVerdict.requiresApproval).toBe(true);
    expect(
      firewall.guardProviderRequest({ model: unknown, billing: billing(), policy: "free-only" })
        .allowed,
    ).toBe(false);
  });

  it("does not treat a configured key or auto routing as authorisation", () => {
    // autoPaidUsage on but paid access still off = no spending.
    const verdict = firewall.guardProviderRequest({
      model: paid,
      billing: billing({ autoPaidUsage: true }),
    });
    expect(verdict.allowed).toBe(false);
  });

  it("allows a paid model only when the owner picked it, unless auto paid is on", () => {
    const unlocked = billing({ paidAccess: true });
    expect(firewall.guardProviderRequest({ model: paid, billing: unlocked }).allowed).toBe(false);
    expect(
      firewall.guardProviderRequest({ model: paid, billing: unlocked, explicitPaid: true }).allowed,
    ).toBe(true);
    expect(
      firewall.guardProviderRequest({
        model: paid,
        billing: billing({ paidAccess: true, autoPaidUsage: true }),
      }).allowed,
    ).toBe(true);
  });

  it("honours a temporary owner grant and the free-only cost mode", () => {
    const granted = policy.applyGrant(billing(), "session");
    expect(
      firewall.guardProviderRequest({ model: paid, billing: granted, explicitPaid: true }).allowed,
    ).toBe(true);
    expect(
      firewall.guardProviderRequest({
        model: paid,
        billing: billing({ paidAccess: true, autoPaidUsage: true }),
        policy: "free-only",
      }).allowed,
    ).toBe(false);
  });

  it("lets the kill switch override every grant and toggle", () => {
    const killed = policy.setKillSwitch(
      billing({ paidAccess: true, autoPaidUsage: true, grantScope: "always" }),
      true,
    );
    const verdict = firewall.guardProviderRequest({
      model: paid,
      billing: killed,
      explicitPaid: true,
    });
    expect(verdict.allowed).toBe(false);
    expect(firewall.describeBlock(verdict, paid)).toContain("GPT-5");
  });

  it("never blocks local work while paid access is locked down", () => {
    const killed = policy.setKillSwitch(billing(), true);
    expect(firewall.guardProviderRequest({ model: local, billing: killed }).allowed).toBe(true);
    for (const type of ["lmstudio", "vllm", "llamacpp", "localai", "jan", "mlx"]) {
      expect(
        firewall.guardProviderRequest({
          model: { id: `${type}/model`, type },
          billing: killed,
        }).allowed,
      ).toBe(true);
      expect(firewall.billingClass({ type })).toBe("free");
    }
  });

  it("allows official Gemini free-tier evidence and still blocks an unlisted id", () => {
    const gemini = {
      id: "gemini:gemini-2.5-flash",
      meta: { providerId: "gemini", kind: "cloud", modelName: "gemini-2.5-flash" },
    };
    const oldGemini = {
      id: "gemini:gemini-1.5-pro",
      meta: { providerId: "gemini", kind: "cloud", modelName: "gemini-1.5-pro" },
    };
    const groq = {
      id: "groq:llama",
      meta: { providerId: "groq", kind: "cloud", modelName: "llama" },
    };
    expect(firewall.billingClass(gemini)).toBe("free");
    expect(firewall.guardProviderRequest({ model: gemini, billing: billing() }).allowed).toBe(true);
    expect(firewall.billingClass(oldGemini)).toBe("unknown");
    expect(firewall.billingClass(groq)).toBe("unknown");
    expect(firewall.guardProviderRequest({ model: oldGemini, billing: billing() }).allowed).toBe(
      false,
    );
    expect(firewall.guardProviderRequest({ model: groq, billing: billing() }).allowed).toBe(false);
  });

  it("allows a live-verified free-quota model without a paid-access unlock", () => {
    const access = require_("../../electron/model-access.cjs");
    const gemini = access.stampVerified({
      id: "gemini:gemini-2.5-flash",
      type: "cloud",
      meta: { providerId: "gemini", kind: "cloud", modelName: "gemini-2.5-flash" },
    });
    expect(firewall.billingClass(gemini)).toBe("free");
    expect(firewall.guardProviderRequest({ model: gemini, billing: billing() }).allowed).toBe(true);
  });

  it("still treats a raw OpenAI spec as paid so a key is not silent spend", () => {
    const openai = {
      id: "openai:gpt-4o",
      meta: { providerId: "openai", kind: "cloud", modelName: "gpt-4o" },
    };
    expect(firewall.billingClass(openai)).toBe("paid");
    expect(firewall.guardProviderRequest({ model: openai, billing: billing() }).allowed).toBe(
      false,
    );
  });

  it("allows unknown-cost only when the owner authorises paid usage", () => {
    expect(
      firewall.guardProviderRequest({
        model: unknown,
        billing: billing({ paidAccess: true }),
        explicitPaid: true,
        policy: "free-preferred",
      }).allowed,
    ).toBe(true);
  });
});
