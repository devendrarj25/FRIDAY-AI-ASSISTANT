import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { pinKnowledgeClock } from "./helpers/knowledge-clock";

const require_ = createRequire(import.meta.url);

pinKnowledgeClock();
const access = require_("../../electron/model-access.cjs");
const firewall = require_("../../electron/privacy-firewall.cjs");

const REMOTE = "https://evil.example.test/v1";
const LAN = "http://192.168.1.5:11434";
const SECRET = "my password is hunter2";

// The same rule as kernel/tests/test_locality_rule.py: local only on loopback or on the host the owner set
// in the process environment (OLLAMA_HOST); a row, a renderer value or a model field never adds a host.
let saved: string | undefined;
beforeEach(() => {
  saved = process.env["OLLAMA_HOST"];
  delete process.env["OLLAMA_HOST"];
});
afterEach(() => {
  if (saved === undefined) delete process.env["OLLAMA_HOST"];
  else process.env["OLLAMA_HOST"] = saved;
});

const row = (provider: string, endpoint: string, extra: Record<string, unknown> = {}) => ({
  id: `${provider}:m`,
  provider,
  type: "local",
  endpoint,
  ...extra,
});

describe("locality rule (JS side)", () => {
  it("a forged remote llamacpp or ollama row is never local, never free, and counts as external", () => {
    for (const provider of ["llamacpp", "ollama", "lmstudio", "local"]) {
      const forged = row(provider, REMOTE);
      expect(access.isLocalModel(forged), provider).toBe(false);
      expect(access.classifyAccess(forged), provider).not.toBe("free");
      expect(access.accessOf(forged).billingMode, provider).not.toBe("ZERO_COST");
      expect(firewall.isLocalKind(forged), provider).toBe(false);
      expect(firewall.isExternal(forged), provider).toBe(true);
    }
  });

  it("a forged remote row never gets a local pass for sensitive text", () => {
    const decision = firewall.guardEgress({
      model: row("llamacpp", REMOTE),
      content: SECRET,
      connected: true,
    });
    expect(decision.external).toBe(true);
    expect(decision.requiresConfirmation).toBe(true);
  });

  it("the endpoint may sit in meta, and a remote one there is also not local", () => {
    const forged = { id: "x", provider: "ollama", type: "local", meta: { endpoint: REMOTE } };
    expect(access.isLocalModel(forged)).toBe(false);
    expect(firewall.isLocalKind(forged)).toBe(false);
  });

  it("loopback engines stay local and free", () => {
    for (const endpoint of [
      "http://127.0.0.1:8080/v1",
      "http://localhost:11434",
      "http://[::1]:1234/v1",
      "",
    ]) {
      const engine = row("llamacpp", endpoint);
      expect(access.isLocalModel(engine), endpoint).toBe(true);
      expect(access.classifyAccess(engine), endpoint).toBe("free");
      expect(firewall.isLocalKind(engine), endpoint).toBe(true);
      expect(firewall.isExternal(engine), endpoint).toBe(false);
    }
  });

  it("a host a lookalike URL hides is not loopback", () => {
    for (const endpoint of [
      "http://127.0.0.1.evil.test/v1",
      "http://evil.test/127.0.0.1",
      "http://127.0.0.1@evil.test/v1",
      "http://localhost.evil.test",
    ]) {
      expect(access.isLocalModel(row("llamacpp", endpoint)), endpoint).toBe(false);
    }
  });

  it("OLLAMA_HOST set by the owner keeps a LAN engine local and free", () => {
    const lan = row("ollama", LAN);
    expect(access.isLocalModel(lan)).toBe(false); // not trusted until the owner sets it
    process.env["OLLAMA_HOST"] = "192.168.1.5";
    expect(access.isLocalModel(lan)).toBe(true);
    expect(access.classifyAccess(lan)).toBe("free");
    expect(access.accessOf(lan).billingMode).toBe("ZERO_COST");
    expect(firewall.isLocalKind(lan)).toBe(true);
    expect(firewall.isExternal(lan)).toBe(false);
    const decision = firewall.guardEgress({ model: lan, content: SECRET });
    expect(decision.external).toBe(false);
  });

  it.each(["192.168.1.5", "192.168.1.5:11434", "http://192.168.1.5:11434/", " 192.168.1.5 "])(
    "env value shape %j is read as the host 192.168.1.5",
    (value) => {
      process.env["OLLAMA_HOST"] = value;
      expect([...access.trustedEngineHosts()]).toEqual(["192.168.1.5"]);
      expect(access.isLocalEndpoint("http://192.168.1.5:9/v1")).toBe(true);
    },
  );

  it("the env host trusts that host only", () => {
    process.env["OLLAMA_HOST"] = "192.168.1.5";
    for (const endpoint of [
      "http://192.168.1.6:11434",
      "http://192.168.1.5.evil.test/v1",
      "http://evil.test/192.168.1.5",
      "http://192.168.1.5@evil.test/v1",
      REMOTE,
    ]) {
      expect(access.isLocalEndpoint(endpoint), endpoint).toBe(false);
    }
  });

  it("a host named by the row, the renderer or the model is never trusted", () => {
    const lan = row("ollama", LAN, {
      trustedHost: "192.168.1.5",
      host: "192.168.1.5",
      env: { OLLAMA_HOST: "192.168.1.5" },
      meta: { env: { OLLAMA_HOST: "192.168.1.5" }, trustedHost: "192.168.1.5" },
    });
    expect([...access.trustedEngineHosts()]).toEqual([]);
    expect(access.isLocalModel(lan)).toBe(false);
    expect(firewall.isLocalKind(lan)).toBe(false);
    expect(access.endpointAllowsLocal(lan)).toBe(false);
  });

  it("an empty or unreadable env value trusts nothing", () => {
    for (const value of ["", "   ", "http://", ":::", "http://[bad"]) {
      process.env["OLLAMA_HOST"] = value;
      expect([...access.trustedEngineHosts()], value).toEqual([]);
    }
  });

  it("a local NIM is local only on a real loopback host", () => {
    const nim = (endpoint: string) => ({ id: "n", provider: "nvidia", type: "cloud", endpoint });
    expect(access.isLocalModel(nim("http://127.0.0.1:8000/v1"))).toBe(true);
    expect(access.isLocalModel(nim("http://127.0.0.1.evil.test/v1"))).toBe(false);
    expect(access.isLocalModel(nim("https://evil.test/localhost"))).toBe(false);
  });
});
