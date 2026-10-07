/**
 * Custom provider endpoint contract.
 *
 * When the owner sets a base URL it must actually be the URL FRIDAY calls —
 * for key validation, for model discovery and for the chat surface handed to
 * the router. A default must never silently replace it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const models = require_("../../electron/models.cjs");

const roots: string[] = [];
const tempRoot = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-endpoint-"));
  roots.push(dir);
  return dir;
};

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("provider endpoints", () => {
  it("falls back to the documented provider URLs when nothing is set", () => {
    const urls = models.resolveEndpoints(tempRoot(), "openai");
    expect(urls.custom).toBe(false);
    expect(urls.base).toBe("https://api.openai.com/v1");
    expect(urls.list).toBe("https://api.openai.com/v1/models");
  });

  it("stores and returns the owner's base URL", () => {
    const root = tempRoot();
    const result = models.writeEndpoint(root, "openai", "https://gateway.internal/v1/");
    expect(result.ok).toBe(true);
    const urls = models.resolveEndpoints(root, "openai");
    expect(urls.custom).toBe(true);
    expect(urls.base).toBe("https://gateway.internal/v1");
    expect(urls.list).toBe("https://gateway.internal/v1/models");
  });

  it("keeps the override on disk so a restart still uses it", () => {
    const root = tempRoot();
    models.writeEndpoint(root, "groq", "https://proxy.local/openai/v1");
    expect(models.readEndpoints(root).groq).toBe("https://proxy.local/openai/v1");
  });

  it("clears the override and returns to the provider default", () => {
    const root = tempRoot();
    models.writeEndpoint(root, "groq", "https://proxy.local/v1");
    models.writeEndpoint(root, "groq", null);
    expect(models.readEndpoints(root).groq).toBeUndefined();
    expect(models.resolveEndpoints(root, "groq").custom).toBe(false);
  });

  it("rejects a base URL that is not http(s)", () => {
    const root = tempRoot();
    const result = models.writeEndpoint(root, "openai", "ftp://nope");
    expect(result.ok).toBe(false);
    expect(models.resolveEndpoints(root, "openai").custom).toBe(false);
  });

  it("never stores an API key inside the endpoint file", () => {
    const root = tempRoot();
    models.writeEndpoint(root, "openai", "https://gateway.internal/v1");
    const raw = fs.readFileSync(path.join(root, "config", "provider-endpoints.json"), "utf8");
    expect(raw).not.toMatch(/sk-/);
  });

  it("returns the configured Jan endpoint before desktop and CLI defaults", () => {
    const root = tempRoot();
    const previous = process.env["FRIDAY_JAN_ENDPOINT"];
    delete process.env["FRIDAY_JAN_ENDPOINT"];
    try {
      models.writeEndpoint(root, "jan", "http://127.0.0.1:7777/");
      expect(models.localEndpointCandidates("jan", root)).toEqual([
        "http://127.0.0.1:7777",
        "http://127.0.0.1:1337",
        "http://127.0.0.1:6767",
      ]);
    } finally {
      if (previous === undefined) delete process.env["FRIDAY_JAN_ENDPOINT"];
      else process.env["FRIDAY_JAN_ENDPOINT"] = previous;
    }
  });

  it("reuses local endpoint candidates in provider detection", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "electron", "providers.cjs"), "utf8");
    expect(source).toContain("localEndpointCandidates(id, keyStore)");
  });
});
