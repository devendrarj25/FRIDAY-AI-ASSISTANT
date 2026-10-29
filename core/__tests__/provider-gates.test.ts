/**
 * Cloud failures keep their real category. A local engine sentence is only
 * for a local runner. Unknown cost stays out of automatic routing.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pinKnowledgeClock } from "./helpers/knowledge-clock";

const require_ = createRequire(import.meta.url);
pinKnowledgeClock();

const router = require_("../../electron/model-router.cjs");
const access = require_("../../electron/model-access.cjs");
const models = require_("../../electron/models.cjs");
const handlers = require_("../../electron/provider-handler.cjs");
const { registerAll } = require_("../../electron/handlers/index.cjs");

registerAll();

const root = path.resolve(__dirname, "../..");

function cloud(providerId: string, modelId: string, extra: Record<string, unknown> = {}) {
  return {
    id: `${providerId}:${modelId}`,
    type: "cloud",
    contextK: 8,
    providerId,
    providerModelId: modelId,
    meta: { providerId, kind: "cloud", modelName: modelId, connected: true },
    ...extra,
  };
}

describe("error classification", () => {
  const rows: Array<{
    name: string;
    input: Record<string, unknown>;
    category: string;
    step: RegExp;
  }> = [
    {
      name: "invalid key",
      input: { status: 401, message: "invalid api key", modelId: "openrouter:a" },
      category: "invalid_key",
      step: /API key/i,
    },
    {
      name: "credits",
      input: { status: 402, message: "insufficient credit", modelId: "openrouter:a" },
      category: "billing_required",
      step: /paid access/i,
    },
    {
      name: "moderation",
      input: { status: 403, message: "content policy", modelId: "openai:gpt" },
      category: "content_filter",
      step: /^$/,
    },
    {
      name: "data policy",
      input: {
        status: 404,
        code: "data_policy",
        message: "No endpoints found matching your data policy",
        modelId: "openrouter:google/gemma-4-26b-a4b-it:free",
        provider: "openrouter",
      },
      category: "account_setting_required",
      step: /openrouter.ai\/settings\/privacy/,
    },
    {
      name: "removed",
      input: { status: 404, message: "model was removed", modelId: "openrouter:gone" },
      category: "model_unavailable",
      step: /next candidate/i,
    },
    {
      name: "daily limit",
      input: {
        status: 429,
        message: "free-models-per-day exceeded",
        modelId: "openrouter:a:free",
      },
      category: "daily_limit",
      step: /daily limit/i,
    },
    {
      name: "timeout",
      input: { status: 408, message: "timed out", modelId: "groq:llama" },
      category: "timeout",
      step: /smaller reply/i,
    },
    {
      name: "upstream",
      input: { status: 503, message: "bad gateway", modelId: "together:x" },
      category: "provider_error",
      step: /different provider/i,
    },
    {
      name: "streamed error object",
      input: {
        status: 200,
        streamError: { message: "No endpoints found matching your data policy", status: 404 },
        modelId: "openrouter:a:free",
      },
      category: "account_setting_required",
      step: /privacy/i,
    },
    {
      name: "cloud network",
      input: {
        message: "connect ECONNREFUSED 1.2.3.4:443",
        modelId: "openrouter:google/gemma-4-26b-a4b-it:free",
        kind: "cloud",
      },
      category: "network",
      step: /network could not reach/i,
    },
    {
      name: "local engine",
      input: { message: "connect ECONNREFUSED 127.0.0.1:11434", modelId: "ollama:llama3.2" },
      category: "offline",
      step: /engine is not running/i,
    },
    {
      name: "kernel bridge",
      input: {
        message: "connection failed to the local AI service",
        modelId: "openrouter:a",
        kind: "cloud",
      },
      category: "kernel_down",
      step: /local AI service/i,
    },
  ];

  it.each(rows)("$name → $category", ({ input, category, step }) => {
    const out = router.classifyError(input);
    expect(out.category).toBe(category);
    expect(out.nextStep || "").toMatch(step);
    if (category !== "offline") {
      expect(out.nextStep || "").not.toMatch(/engine is not running/i);
    }
    expect(JSON.stringify(out.facts || {})).not.toMatch(/sk-[a-z0-9]{8,}/i);
  });

  it("strips a key from the stored facts", () => {
    const out = router.classifyError({
      status: 401,
      message: "invalid api key sk-livekeyvalue99",
      modelId: "openai:gpt",
      body: "Authorization: Bearer sk-livekeyvalue99",
    });
    expect(JSON.stringify(out)).not.toMatch(/sk-livekeyvalue99/);
    expect(out.facts.status).toBe(401);
    expect(out.facts.body).toContain("secret");
  });
});

describe("gates and billing", () => {
  it("gives every cloud handler one gate descriptor", () => {
    for (const id of ["openrouter", "gemini", "groq", "ollama"]) {
      const gate = handlers.getHandler(id).gate();
      expect(gate.id).toBe(id);
      expect(gate.healthProbe).toBe("zero-spend");
    }
    const open = handlers.getHandler("openrouter").gate();
    expect(open.listUrl).toBe("https://openrouter.ai/api/v1/models");
    expect(open.chatUrl).toBe("https://openrouter.ai/api/v1");
    expect(open.mayTrain).toBe(true);
    expect(open.privacyUrl).toContain("openrouter.ai/settings/privacy");
    expect(handlers.getHandler("gemini").gate().mayTrain).toBe(false);
  });

  it("classifies zero price as free and a bare :free id as unknown", () => {
    const priced = access.classifyModel({
      providerId: "openrouter",
      modelId: "google/gemma-4-26b-a4b-it:free",
      catalogue: { pricing: { prompt: "0", completion: "0" } },
    });
    expect(priced.billingMode).toBe("ZERO_COST");
    const bare = access.classifyModel({
      providerId: "openrouter",
      modelId: "google/gemma-4-26b-a4b-it:free",
    });
    expect(bare.billingMode).toBe("UNKNOWN");
  });

  it("does not auto-route unknown, paid, or strict-privacy free models", () => {
    const free = cloud("openrouter", "writer:free", {
      pricing: { prompt: "0", completion: "0" },
    });
    const unknown = cloud("openrouter", "mystery-model");
    const capped = cloud("openrouter", "mystery-model", { spendCapUsd: 1 });
    const paid = cloud("groq", "openai/gpt-oss-20b");
    const local = {
      id: "ollama:llama3.2",
      type: "local",
      contextK: 8,
      meta: { providerId: "ollama", kind: "local", modelName: "llama3.2", connected: true },
    };
    const open = router.planRoute([free, unknown, paid, local], {
      policy: "allow-paid",
      mode: "auto",
      limit: 8,
    });
    expect(open.candidates).toContain(free.id);
    expect(open.candidates).toContain(local.id);
    expect(open.candidates).toContain(paid.id);
    expect(open.candidates).not.toContain(unknown.id);
    const freeOnly = router.planRoute([free, unknown, paid, local], {
      policy: "free-preferred",
      mode: "auto",
      limit: 8,
    });
    expect(freeOnly.candidates).not.toContain(paid.id);
    expect(freeOnly.candidates).not.toContain(unknown.id);
    const withCap = router.planRoute([capped], { policy: "allow-paid", mode: "auto" });
    expect(withCap.candidates).toContain(capped.id);
    const strict = router.planRoute([free, local], {
      policy: "allow-paid",
      requirements: { strictPrivacy: true },
    });
    expect(strict.candidates).toEqual([local.id]);
    const privateTurn = router.planRoute([free, local], {
      requirements: { privacy: "private" },
    });
    expect(privateTurn.candidates).toEqual([local.id]);
  });
});

describe("fallback", () => {
  it("leaves a failed provider and resumes a stream only for outages", () => {
    const failed = cloud("openrouter", "old:free");
    const sibling = cloud("openrouter", "new:free");
    const other = cloud("groq", "llama-3.3-70b-versatile");
    const next = router.orderFallbacks(
      [failed, sibling, other],
      failed,
      "account_setting_required",
    );
    expect(next.map((row: { id: string }) => row.id)[0]).toBe(other.id);
    const removed = router.orderFallbacks(
      [
        failed,
        {
          ...cloud("openrouter", "old:free"),
          id: "openrouter:old:free@2",
          canonicalModelId: failed.id,
        },
        other,
      ],
      { ...failed, canonicalModelId: failed.id },
      "model_unavailable",
    );
    expect(removed[0].id).toBe("openrouter:old:free@2");
    expect(router.midStreamFallback("stream_failure").resume).toBe(true);
    expect(router.midStreamFallback("network").resume).toBe(true);
    expect(router.midStreamFallback("invalid_request").resume).toBe(false);
    expect(router.midStreamFallback("billing_required").resume).toBe(false);
  });

  it("names the real reason and never the local-engine sentence for a cloud miss", () => {
    const text = router.explainFailure({
      checked: ["Connected cloud models"],
      failures: [
        {
          label: "OpenRouter google/gemma-4-26b-a4b-it:free",
          category: "network",
          facts: { status: 404, code: "data_policy" },
          nextStep: router.classifyError({
            status: 404,
            message: "No endpoints found matching your data policy",
            modelId: "openrouter:google/gemma-4-26b-a4b-it:free",
          }).nextStep,
        },
      ],
    });
    expect(text).toContain("network error");
    expect(text).toContain("HTTP 404");
    expect(text).toContain("openrouter.ai/settings/privacy");
    expect(text).not.toMatch(/engine is not running/i);
    expect(text).not.toMatch(/sk-/i);
  });
});

describe("probe funnel", () => {
  it("sends the OpenRouter chat to the official path and records the status", async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
      seen.push(String(url));
      const headers = init?.headers;
      const auth = String(headers?.["Authorization"] || headers?.["authorization"] || "");
      expect(auth.startsWith("Bearer ")).toBe(true);
      expect(auth).not.toMatch(/sk-/);
      if (String(url).includes("/models")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: "google/gemma:free" }] }),
          text: async () => "",
        };
      }
      return {
        ok: false,
        status: 404,
        text: async () =>
          JSON.stringify({
            error: { message: "No endpoints found matching your data policy", code: 404 },
          }),
      };
    };
    const probe = await models.testProviderChat("openrouter", {
      apiKey: "or-test-token",
      fetchImpl,
      policy: "free-preferred",
    });
    expect(seen[0]).toBe("https://openrouter.ai/api/v1/models");
    expect(["not-usable", "http", "ok", "empty", "list", "network", "cost"]).toContain(
      probe.category,
    );
    if (probe.category === "http") {
      expect(seen.some((url) => url.includes("/chat/completions"))).toBe(true);
      expect(probe.detail).toContain("404");
    }
    if (probe.category === "not-usable" || probe.category === "cost") {
      expect(seen.some((url) => url.includes("/chat/completions"))).toBe(false);
    }
    expect(probe.detail || probe.category).toBeTruthy();
    expect(JSON.stringify(probe)).not.toMatch(/or-test-token/);
  });

  it("probes a second wire and keeps the key out of the result", async () => {
    const fetchImpl = async (url: string) => {
      if (String(url).includes("generativelanguage")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ models: [{ name: "models/gemini-2.5-flash" }] }),
          text: async () => "",
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => 'data: {"choices":[{"delta":{"content":"Hi"}}]}',
      };
    };
    const probe = await models.testProviderChat("gemini", {
      apiKey: "gemini-test-token",
      fetchImpl,
      policy: "free-preferred",
      modelId: "gemini-2.5-flash",
    });
    expect(["ok", "not-usable", "http", "auth", "empty", "list"].includes(probe.category)).toBe(
      true,
    );
    expect(JSON.stringify(probe)).not.toContain("gemini-test-token");
  });
});

describe("one probe path", () => {
  it("sends Test selected models through the existing provider probe", () => {
    const engine = readFileSync(path.join(root, "src/lib/friday/models-engine.ts"), "utf8");
    const page = readFileSync(path.join(root, "src/routes/models.tsx"), "utf8");
    expect(engine).toMatch(/testSelectedModels[\s\S]*testModelProvider/);
    expect(page).toContain("Test selected models");
    expect(page).toMatch(/testSelectedModels\(selected\)/);
    const main = readFileSync(path.join(root, "electron/main.cjs"), "utf8");
    expect(main).toMatch(/kernel_down[\s\S]{0,400}restartKernel/);
  });
});
