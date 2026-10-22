import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { pinKnowledgeClock } from "./helpers/knowledge-clock";

const require_ = createRequire(import.meta.url);

pinKnowledgeClock();
const firewall = require_("../../electron/billing-firewall.cjs");
const billingPolicy = require_("../../electron/billing-policy.cjs");
const access = require_("../../electron/model-access.cjs");
const privacy = require_("../../electron/privacy-firewall.cjs");

const KINDS = ["local", "ollama", "llamacpp", "lmstudio", "vllm", "localai", "jan", "mlx"];
// Every cost mode the owner can pick except Paid-only, which excludes free models by design.
const POLICIES = ["free-only", "free-preferred", "allow-paid", null];
const SECRET = "my key is sk-live-4eC39HqLyjWDarjtT1zdp7dc and password: hunter2";
const ORDINARY = "what is on my calendar tomorrow and who emailed me from alice@example.com";

const billing = (patch: Record<string, unknown> = {}) =>
  billingPolicy.normaliseBilling({ ...billingPolicy.DEFAULT_BILLING, ...patch });

describe("a local model is free and private for normal use", () => {
  for (const kind of KINDS) {
    it(`${kind}: never paid or unknown, never blocked, with paid access off`, () => {
      // Bare spec: no stamp, no access record, no pricing at all.
      const bare = { id: `${kind}/any-model`, type: kind, label: "Local" };
      const stale = {
        ...bare,
        accessRecord: {
          billingMode: "UNKNOWN",
          failureReason: "pricing_stale",
          evidence: { stale: true },
        },
      };
      for (const model of [bare, stale]) {
        expect(firewall.billingClass(model)).toBe("free");
        expect(access.classifyAccess(model)).toBe("free");
        for (const policy of POLICIES) {
          const verdict = firewall.guardProviderRequest({ model, billing: billing(), policy });
          expect(verdict.allowed, `${kind} ${policy}`).toBe(true);
          expect(verdict.billingClass).toBe("free");
          expect(verdict.requiresApproval).toBe(false);
        }
        // Even with the kill switch on, a local model costs nothing and stays usable.
        const killed = firewall.guardProviderRequest({
          model,
          billing: billing({ killSwitch: true }),
          policy: "free-preferred",
        });
        expect(killed.allowed).toBe(true);
      }
    });

    it(`${kind}: ordinary text and even secrets never leave the PC, so no privacy block`, () => {
      const model = { id: `${kind}/m`, type: kind };
      for (const text of [ORDINARY, SECRET]) {
        const verdict = privacy.guardEgress({ model, content: text, connected: false });
        expect(verdict.external).toBe(false);
        expect(verdict.autoAllowed).toBe(true);
        expect(verdict.requiresConfirmation).toBe(false);
        expect(verdict.hardStop).toBeUndefined();
      }
    });
  }

  it("keeps the sensitive hard stop for a cloud destination", () => {
    const cloud = { id: "openrouter/x:free", type: "cloud" };
    const verdict = privacy.guardEgress({ model: cloud, content: SECRET, connected: true });
    expect(verdict.external).toBe(true);
    expect(verdict.hardStop).toBe(true);
    expect(verdict.autoAllowed).toBe(false);
    // Ordinary text to a connected cloud provider still goes without a click.
    const ordinary = privacy.guardEgress({ model: cloud, content: ORDINARY, connected: true });
    expect(ordinary.autoAllowed).toBe(true);
  });

  it("does not treat a cloud model as local because its name says local", () => {
    const cloud = { id: "openai/local-llama-clone", type: "cloud", access: "unknown" };
    expect(firewall.billingClass(cloud)).toBe("unknown");
    expect(firewall.guardProviderRequest({ model: cloud, billing: billing() }).allowed).toBe(false);
  });
});
