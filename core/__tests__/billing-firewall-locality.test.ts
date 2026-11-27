import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { pinKnowledgeClock } from "./helpers/knowledge-clock";

const require_ = createRequire(import.meta.url);

pinKnowledgeClock();
const firewall = require_("../../electron/billing-firewall.cjs");
const policy = require_("../../electron/billing-policy.cjs");

const billing = () => policy.normaliseBilling({ ...policy.DEFAULT_BILLING });
const savedHost = process.env["OLLAMA_HOST"];

afterEach(() => {
  if (savedHost === undefined) delete process.env["OLLAMA_HOST"];
  else process.env["OLLAMA_HOST"] = savedHost;
});

describe("billing firewall locality", () => {
  it("does not bill a forged remote row typed local as free", () => {
    const forged = { id: "evil/x", type: "local", endpoint: "https://api.example.com/v1" };
    expect(firewall.billingClass(forged)).not.toBe("free");
    expect(firewall.isBillable(forged)).toBe(true);
    expect(firewall.guardProviderRequest({ model: forged, billing: billing() }).allowed).toBe(
      false,
    );
    const viaMeta = { id: "evil/y", meta: { kind: "local" }, endpoint: "https://10.0.0.5:9/v1" };
    expect(firewall.billingClass(viaMeta)).not.toBe("free");
  });

  it("keeps a loopback local model free", () => {
    for (const endpoint of ["http://127.0.0.1:11434", "http://localhost:8080/v1", ""]) {
      const model = { id: "ollama/llama3", type: "local", endpoint };
      expect(firewall.billingClass(model)).toBe("free");
      expect(firewall.guardProviderRequest({ model, billing: billing() }).allowed).toBe(true);
    }
  });

  it("trusts the host the owner set in OLLAMA_HOST", () => {
    const model = { id: "ollama/llama3", type: "local", endpoint: "http://gpu-box.lan:11434" };
    delete process.env["OLLAMA_HOST"];
    expect(firewall.billingClass(model)).not.toBe("free");
    process.env["OLLAMA_HOST"] = "http://gpu-box.lan:11434";
    expect(firewall.billingClass(model)).toBe("free");
  });

  it("never lets unknown cost through without owner authorisation", () => {
    const unknown = { id: "mystery/m", type: "cloud", access: "unknown" };
    const verdict = firewall.guardProviderRequest({
      model: unknown,
      billing: billing(),
      policy: "free-preferred",
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.billingClass).toBe("unknown");
  });
});
