/**
 * FRIDAY · Gemini provider contract.
 *
 * Gemini has exactly ONE surface in FRIDAY: Google's OpenAI-compatible
 * endpoint. Model discovery, key verification and chat all go to
 * https://generativelanguage.googleapis.com/v1beta/openai and all authenticate
 * with `Authorization: Bearer <key>`. The native /v1beta/models surface (with
 * its x-goog-api-key header and `{ models: [...] }` shape) must never be used
 * for the provider health check again: it made the badge report a different
 * API than the one real chat turns use.
 *
 * The last test is a real network diagnostic: it performs an actual request and
 * reports status, endpoint, auth mode and the provider's own error body.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const models = require_("../../electron/models.cjs");

const BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
const gemini = models.CLOUD.gemini;

describe("Gemini endpoints", () => {
  it("lists models from the OpenAI-compatible surface", () => {
    expect(gemini.url).toBe(`${BASE}/models`);
    expect(gemini.url).not.toBe("https://generativelanguage.googleapis.com/v1beta/models");
  });

  it("keeps the canonical chat base, so chat resolves to /chat/completions", () => {
    expect(gemini.chat).toBe(BASE);
    expect(`${gemini.chat}/chat/completions`).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
  });

  it("routes on the OpenAI wire", () => {
    expect(gemini.wire).toBe("online");
  });
});

describe("Gemini authentication", () => {
  it("authenticates the model list with Authorization: Bearer only", () => {
    const headers = gemini.headers("AIzaTESTKEY");
    expect(headers).toEqual({ Authorization: "Bearer AIzaTESTKEY" });
    expect(headers["x-goog-api-key"]).toBeUndefined();
  });

  it("authenticates chat with the exact same header set", () => {
    const chat = models.chatHeaders(gemini, "AIzaTESTKEY");
    expect(chat).toEqual({ Authorization: "Bearer AIzaTESTKEY" });
    expect(chat["x-goog-api-key"]).toBeUndefined();
  });

  it("never sends both schemes on the OpenAI-compatible surface", () => {
    for (const set of [gemini.headers("k"), models.chatHeaders(gemini, "k")]) {
      const names = Object.keys(set).map((n) => n.toLowerCase());
      expect(names).toContain("authorization");
      expect(names).not.toContain("x-goog-api-key");
    }
  });
});

describe("Gemini model-list parsing", () => {
  it("reads ids from the OpenAI-compatible { data: [{ id }] } shape", () => {
    const ids = gemini.list({
      object: "list",
      data: [{ id: "models/gemini-2.5-flash" }, { id: "gemini-2.5-pro" }],
    });
    expect(ids).toEqual(["gemini-2.5-flash", "gemini-2.5-pro"]);
  });

  it("returns nothing for the native shape instead of inventing ids", () => {
    expect(gemini.list({ models: [{ name: "models/gemini-2.5-flash" }] })).toEqual([]);
  });
});

describe("Gemini diagnostics", () => {
  it("reports the provider's real words, never a canned cause", () => {
    const real = {
      ok: false,
      status: 400,
      body: { error: { code: 400, message: "API key not valid. Please pass a valid API key." } },
    };
    expect(models.providerMessage(real)).toBe("API key not valid. Please pass a valid API key.");
    expect(models.describeFailure(real)).toBe(
      "HTTP 400 — API key not valid. Please pass a valid API key.",
    );
  });

  it("performs a real request and reports status, body, endpoint and auth mode", async () => {
    const report = await models.testProvider("gemini", { apiKey: "AIza-not-a-real-key" });
    const diagnostic = {
      endpoint: gemini.url,
      authMode: "Authorization: Bearer",
      online: report.online,
      latencyMs: report.latencyMs,
      models: report.models,
      error: report.error,
    };
    // Printed so a failing key in the field shows what Google actually said.
    console.info("Gemini diagnostic:", JSON.stringify(diagnostic, null, 2));

    // Never "connected" without a successful real model-list request.
    expect(report.online).toBe(false);
    expect(report.error).toBeTruthy();
    expect(report.models).toBe(0);
    // The provider's own message survives; the hint is only ever appended.
    expect(String(report.error)).not.toMatch(/rejected this key — \./);
  }, 30_000);
});
