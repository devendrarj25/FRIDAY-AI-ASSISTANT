/**
 * Usable models: one decision for the router and the chat selector.
 * Official free evidence is usable before a probe. Paid and unknown stay out
 * until paid access is on, or the owner declares them.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { pinKnowledgeClock } from "./helpers/knowledge-clock";
import { groupModels, type RegistryModel } from "../../src/lib/friday/model-registry";
import { multiAnsweredBy } from "../../src/lib/friday/brain-engine";

const require_ = createRequire(import.meta.url);
pinKnowledgeClock();

const access = require_("../../electron/model-access.cjs");
const router = require_("../../electron/model-router.cjs");
const models = require_("../../electron/models.cjs");

const cloud = (providerId: string, modelId: string, extra: Record<string, unknown> = {}) => ({
  id: `${providerId}:${modelId}`,
  type: "cloud" as const,
  contextK: 8,
  providerId,
  providerModelId: modelId,
  meta: {
    providerId,
    kind: "cloud",
    modelName: modelId,
    connected: true,
    ...extra,
  },
});

const local = {
  id: "ollama:llama3.2",
  type: "local" as const,
  contextK: 8,
  meta: { providerId: "ollama", kind: "local", modelName: "llama3.2", connected: true },
};

const idsOf = (plan: { candidates?: string[] }) => plan.candidates || [];

describe("official free evidence is usable", () => {
  it("classifies each connected provider from its official source", () => {
    const rows: [string, string, string][] = [
      ["openai", "gpt-4o", "PAID"],
      ["anthropic", "claude-sonnet-4-5", "PAID"],
      ["gemini", "gemini-2.5-flash", "FREE_QUOTA"],
      ["groq", "openai/gpt-oss-20b", "FREE_QUOTA"],
      ["groq", "llama-3.3-70b-versatile", "UNKNOWN"],
      ["mistral", "mistral-small-latest", "PAID"],
      ["deepseek", "deepseek-chat", "PAID"],
      ["perplexity", "sonar", "PAID"],
      ["nvidia", "meta/llama-3.1-8b-instruct", "UNKNOWN"],
      ["zhipu", "glm-4.7-flash", "FREE_QUOTA"],
      ["zhipu", "glm-4.6", "UNKNOWN"],
      ["cerebras", "llama3.1-8b", "UNKNOWN"],
      ["huggingface", "org/model", "UNKNOWN"],
      ["sambanova", "Meta-Llama-3.1-8B-Instruct", "UNKNOWN"],
      ["cohere", "command-r", "UNKNOWN"],
    ];
    for (const [providerId, modelId, billing] of rows) {
      const record = access.classifyModel({ providerId, modelId });
      expect(record.billingMode, `${providerId}/${modelId}`).toBe(billing);
    }
    const pricedNvidia = access.classifyModel({
      providerId: "nvidia",
      modelId: "priced",
      catalogue: { id: "priced", pricing: { prompt: "0.2", completion: "0.2" } },
    });
    expect(pricedNvidia.billingMode).toBe("PAID");
    const listedNvidia = access.classifyModel({
      providerId: "nvidia",
      modelId: "meta/llama-3.1-8b-instruct",
      catalogue: { id: "meta/llama-3.1-8b-instruct" },
    });
    expect(listedNvidia.billingMode).toBe("FREE_QUOTA");
    expect(access.coarseAccess(listedNvidia)).toBe("free");
    const zero = access.classifyModel({
      providerId: "openrouter",
      modelId: "meta/llama",
      catalogue: { pricing: { prompt: "0", completion: "0" } },
    });
    expect(zero.billingMode).toBe("ZERO_COST");
    expect(access.coarseAccess(zero)).toBe("free");
    expect(zero.verification).toBe("UNVERIFIED");
    expect(models.CLOUD.github).toBeUndefined();
    expect(models.CLOUD.cloudflare).toBeUndefined();
  });

  it("keeps a Groq developer account on the published price", () => {
    const record = access.classifyModel({
      providerId: "groq",
      modelId: "openai/gpt-oss-20b",
      declaredAccess: "paid",
    });
    expect(record.billingMode).toBe("PAID");
  });
});

describe("router and selector share usableModels", () => {
  const pool = [
    local,
    cloud("groq", "openai/gpt-oss-20b"),
    cloud("gemini", "gemini-2.5-flash"),
    cloud("openai", "gpt-4o"),
    cloud("cerebras", "llama3.1-8b"),
    cloud("nvidia", "meta/llama-3.1-8b-instruct", { connected: false }),
  ];

  it("Auto uses free models from every connected provider and skips the rest", () => {
    const plan = router.planRoute(pool, { mode: "auto", policy: "free-preferred", limit: 20 });
    const ids = idsOf(plan);
    expect(ids).toContain("ollama:llama3.2");
    expect(ids).toContain("groq:openai/gpt-oss-20b");
    expect(ids).toContain("gemini:gemini-2.5-flash");
    expect(ids).not.toContain("openai:gpt-4o");
    expect(ids).not.toContain("cerebras:llama3.1-8b");
    expect(ids).not.toContain("nvidia:meta/llama-3.1-8b-instruct");
    const rejected = new Map(
      plan.rejected.map((row: { id: string; reason: string }) => [row.id, row.reason]),
    );
    expect(rejected.get("openai:gpt-4o")).toBe("cost");
    expect(rejected.get("cerebras:llama3.1-8b")).toBe("cost");
    expect(rejected.get("nvidia:meta/llama-3.1-8b-instruct")).toBe("unconnected");
  });

  it("covers mode, cost policy, and paid access", () => {
    const free = cloud("groq", "openai/gpt-oss-20b");
    const paid = cloud("openai", "gpt-4o");
    const unknown = cloud("cerebras", "llama3.1-8b");
    const cases: { mode: string; policy: string; want: string[]; skip: string[] }[] = [
      {
        mode: "auto",
        policy: "free-only",
        want: ["ollama:llama3.2", "groq:openai/gpt-oss-20b"],
        skip: ["openai:gpt-4o", "cerebras:llama3.1-8b"],
      },
      {
        mode: "auto",
        policy: "allow-paid",
        want: [
          "ollama:llama3.2",
          "groq:openai/gpt-oss-20b",
          "openai:gpt-4o",
          "cerebras:llama3.1-8b",
        ],
        skip: [],
      },
      {
        mode: "local-only",
        policy: "free-preferred",
        want: ["ollama:llama3.2"],
        skip: ["groq:openai/gpt-oss-20b", "openai:gpt-4o"],
      },
      {
        mode: "cloud-only",
        policy: "free-preferred",
        want: ["groq:openai/gpt-oss-20b"],
        skip: ["ollama:llama3.2", "openai:gpt-4o"],
      },
      {
        mode: "auto",
        policy: "paid-only",
        want: ["openai:gpt-4o"],
        skip: ["groq:openai/gpt-oss-20b", "ollama:llama3.2", "cerebras:llama3.1-8b"],
      },
    ];
    for (const row of cases) {
      const plan = router.planRoute([local, free, paid, unknown], {
        mode: row.mode,
        policy: row.policy,
        limit: 20,
      });
      const ids = idsOf(plan);
      for (const id of row.want) expect(ids, `${row.mode}/${row.policy}`).toContain(id);
      for (const id of row.skip) expect(ids, `${row.mode}/${row.policy}`).not.toContain(id);
    }
    const pinned = router.planRoute([paid], {
      mode: "auto",
      policy: "free-preferred",
      preferred: ["openai:gpt-4o"],
      limit: 5,
    });
    expect(idsOf(pinned)).toEqual([]);
    const allowed = router.planRoute([paid], {
      mode: "manual",
      policy: "allow-paid",
      preferred: ["openai:gpt-4o"],
      limit: 5,
    });
    expect(idsOf(allowed)).toEqual(["openai:gpt-4o"]);
  });

  it("does not put OpenRouter ahead of another free provider", () => {
    const plan = router.planRoute(
      [
        cloud("openrouter", "anthropic/claude", {
          catalogue: { pricing: { prompt: "0.000003", completion: "0.000015" } },
        }),
        cloud("groq", "openai/gpt-oss-20b"),
      ],
      { mode: "auto", policy: "free-preferred", limit: 5 },
    );
    expect(idsOf(plan)[0]).toBe("groq:openai/gpt-oss-20b");
  });

  it("shows the same rows the router would use", () => {
    const view = router.usableModels(pool, { policy: "free-preferred", task: "chat" });
    expect(
      view.rows.find((row: { model: { id: string } }) => row.model.id === "openai:gpt-4o")
        ?.visibility,
    ).toBe("hide");
    expect(view.hint).toMatch(/hidden — turn on paid access/);
    expect(view.hint).toMatch(/connected without free models/);
    for (const row of view.rows) {
      const plan = router.planRoute([row.model], {
        mode: "auto",
        policy: "free-preferred",
        limit: 1,
        task: "chat",
      });
      const reason = plan.rejected[0]?.reason;
      if (row.visibility === "show") {
        expect(reason, row.model.id).not.toBe("cost");
        expect(reason, row.model.id).not.toBe("unconnected");
        expect(idsOf(plan)).toContain(row.model.id);
      } else if (row.visibility === "hide") {
        expect(["cost", "unconnected", "retired", "capability"]).toContain(reason);
      } else {
        expect(["cooldown", "quota"]).toContain(reason);
      }
      expect(row.choiceLabel).toMatch(/ · /);
      expect(row.choiceLabel).not.toMatch(/^online ·/);
      expect(row.providerName).not.toBe("online");
    }
    const shown = view.rows.filter((row: { visibility: string }) => row.visibility === "show");
    expect(shown.map((row: { badge: string }) => row.badge)).toEqual(
      expect.arrayContaining(["LOCAL", "FREE"]),
    );
  });

  it("keeps a cooled-down free model visible and disabled", () => {
    const now = Date.now();
    const health = new router.ProviderHealthManager();
    const model = cloud("groq", "openai/gpt-oss-20b");
    health.noteFailure(model.id, { status: 429, message: "rate limit" }, now);
    const view = router.usableModels([model], {
      policy: "free-preferred",
      health,
      now,
      task: "chat",
    });
    expect(view.rows[0].visibility).toBe("disabled");
    expect(view.rows[0].disabledReason).toMatch(/^limit reached · back in \d+ min$/);
    const plan = router.planRoute([model], {
      mode: "auto",
      policy: "free-preferred",
      health,
      now,
    });
    expect(plan.rejected[0].reason).toBe("cooldown");
  });

  it("shows an exhausted free model disabled, not hidden", () => {
    const record = access.applyProbe(
      access.classifyModel({ providerId: "groq", modelId: "openai/gpt-oss-20b" }),
      { ok: false, status: 429, error: "insufficient_quota", headers: {} },
    );
    expect(record.eligibility).toBe("EXHAUSTED");
    const view = router.usableModels(
      [
        {
          ...cloud("groq", "openai/gpt-oss-20b"),
          accessRecord: record,
        },
      ],
      { policy: "free-preferred", task: "chat" },
    );
    expect(view.rows[0].visibility).toBe("disabled");
    expect(view.rows[0].disabledReason).toBe("out of quota");
  });

  it("names models Provider · Model and groups Local first", () => {
    const view = router.usableModels(
      [cloud("groq", "openai/gpt-oss-20b"), local, cloud("gemini", "gemini-2.5-flash")],
      { policy: "free-preferred", task: "chat" },
    );
    const groq = view.rows.find((row: { model: { id: string } }) =>
      row.model.id.startsWith("groq:"),
    );
    expect(groq.choiceLabel).toBe("Groq · openai/gpt-oss-20b");
    expect(groq.badge).toBe("FREE");
    const groups = groupModels(
      view.rows
        .filter((row: { visibility: string }) => row.visibility !== "hide")
        .map(
          (row: {
            model: { id: string; type: string; access: string };
            choiceLabel: string;
            badge: string;
            providerName: string;
            visibility: string;
            disabledReason: string | null;
          }) =>
            ({
              id: row.model.id,
              label: row.choiceLabel,
              provider: "online",
              providerId: row.model.id.split(":")[0] || "",
              providerName: row.providerName,
              modelName: row.model.id,
              type: row.model.type,
              access: row.model.access,
              role: "brain",
              contextK: 8,
              available: true,
              eligible: row.visibility === "show",
              health: "available",
              healthCategory: null,
              coolingDown: false,
              cooldownUntil: 0,
              latencyMs: null,
              priority: 1,
              supportsStreaming: true,
              supportsTools: false,
              supportsVision: false,
              resident: false,
              sizeGb: 0,
              choiceLabel: row.choiceLabel,
              badge: row.badge,
              visibility: row.visibility,
            }) as RegistryModel,
        ),
    );
    expect(groups[0]?.label).toBe("Local");
    expect(groups.map((group) => group.label)).not.toContain("online");
    expect(groups.map((group) => group.label)).toEqual(
      expect.arrayContaining(["Groq", "Google Gemini"]),
    );
  });

  it("shows a cost-unknown model only when paid access is on", () => {
    const unknown = cloud("cerebras", "llama3.1-8b");
    const off = router.usableModels([unknown], { policy: "free-preferred", task: "chat" });
    expect(off.rows[0].visibility).toBe("hide");
    const on = router.usableModels([unknown], { policy: "allow-paid", task: "chat" });
    expect(on.rows[0].visibility).toBe("show");
    expect(on.rows[0].badge).toBe("cost unknown");
  });
});

describe("answered-by uses the router trace", () => {
  it("names an Auto pick and a fallback", () => {
    const winner = router.describe(cloud("cerebras", "llama3.1-8b"));
    const auto = router.formatAnsweredBy({ winner, auto: true });
    expect(auto.line).toBe("Auto → Cerebras · llama3.1-8b");
    expect(auto.badge).toBe("cost unknown");
    const fallback = router.formatAnsweredBy({
      winner: router.describe(cloud("groq", "openai/gpt-oss-20b")),
      failures: [
        {
          modelId: "gemini:gemini-2.5-flash",
          display: "Google Gemini · gemini-2.5-flash",
          category: "rate_limited",
        },
      ],
    });
    expect(fallback.line).toBe(
      "Google Gemini · gemini-2.5-flash failed (rate limit) → Groq · openai/gpt-oss-20b answered",
    );
    expect(fallback.badge).toBe("FREE");
  });

  it("labels every answer in a multi-model turn", () => {
    const answered = multiAnsweredBy([
      { label: "Groq · openai/gpt-oss-20b", access: "free", type: "cloud" },
      { label: "Ollama · llama3.2", access: "free", type: "local" },
      { label: "Cerebras · llama3.1-8b", access: "unknown", type: "cloud" },
    ]);
    expect(answered.line).toBe(
      "Groq · openai/gpt-oss-20b · FREE · Ollama · llama3.2 · LOCAL · Cerebras · llama3.1-8b · UNKNOWN",
    );
    expect(answered.badge).toBeUndefined();
  });
});

describe("owner-declared evidence", () => {
  it("stores a free-tier flag and a per-model mark without overriding published paid prices", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-access-"));
    const written = models.writeOwnerDeclaration(root, {
      providerId: "cerebras",
      ownerFreeTier: true,
    });
    expect(written.ok).toBe(true);
    models.writeOwnerDeclaration(root, {
      providerId: "mistral",
      modelId: "mistral-small-latest",
      mark: "free",
    });
    const saved = models.readOwnerDeclarations(root);
    expect(saved.providers.cerebras.ownerFreeTier).toBe(true);
    expect(saved.models["mistral/mistral-small-latest"]).toBe("free");
    const promoted = access.classifyModel({
      providerId: "cerebras",
      modelId: "llama3.1-8b",
      ownerDeclaration: { providerFreeTier: true },
    });
    expect(promoted.billingMode).toBe("FREE_QUOTA");
    expect(promoted.evidence.source).toBe("owner_declared");
    const stillPaid = access.classifyModel({
      providerId: "mistral",
      modelId: "mistral-small-latest",
      ownerDeclaration: { providerFreeTier: true },
    });
    expect(stillPaid.billingMode).toBe("PAID");
    const marked = access.classifyModel({
      providerId: "mistral",
      modelId: "mistral-small-latest",
      ownerDeclaration: { model: "free" },
    });
    expect(marked.billingMode).toBe("FREE_QUOTA");
    expect(marked.evidence.source).toBe("owner_declared");
    const view = router.usableModels(
      [
        {
          ...cloud("mistral", "mistral-small-latest"),
          ownerDeclaration: { model: "free" },
          meta: {
            ...cloud("mistral", "mistral-small-latest").meta,
            ownerDeclaration: { model: "free" },
          },
        },
      ],
      { policy: "free-preferred", task: "chat" },
    );
    expect(view.rows[0].visibility).toBe("show");
    expect(view.rows[0].marks).toContain("owner declared");
  });
});

describe("test chat stays on the router path", () => {
  it("does not call a model the router would hide, and does not log the key", async () => {
    const secret = "sk-supersecretkeyvalue";
    const calls: string[] = [];
    const hidden = await models.testProviderChat("openai", {
      apiKey: secret,
      policy: "free-preferred",
      fetchImpl: async (url: string, init?: { method?: string }) => {
        calls.push(`${init?.method || "GET"} ${url}`);
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: "gpt-4o" }] }),
          text: async () => "",
        };
      },
    });
    expect(hidden.ok).toBe(false);
    expect(calls.some((line) => line.startsWith("POST"))).toBe(false);
    expect(JSON.stringify(hidden)).not.toContain(secret);

    const leaked = await models.testProviderChat("groq", {
      apiKey: secret,
      policy: "free-preferred",
      fetchImpl: async () => {
        throw new Error(`boom ${secret}`);
      },
    });
    expect(leaked.detail).toBe("list failed");
    expect(JSON.stringify(leaked)).not.toContain(secret);
  });

  it("streams one token when the router accepts the listed model", async () => {
    const server = http.createServer((req, res) => {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "openai/gpt-oss-20b" }] }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;
    const result = await models.testProviderChat("groq", {
      apiKey: "test-key",
      policy: "free-preferred",
      fetchImpl: async (url: string, init?: { method?: string; body?: string }) => {
        const target = new URL(url);
        const response = await fetch(`${base}${target.pathname}`, {
          method: init?.method || "GET",
          ...(init?.body ? { body: init.body } : {}),
        });
        return {
          ok: response.ok,
          status: response.status,
          json: () => response.json(),
          text: () => response.text(),
        };
      },
    });
    server.close();
    expect(result.ok).toBe(true);
    expect(result.stream).toBe(true);
    expect(result.modelId).toBe("openai/gpt-oss-20b");
    expect(result.display).toContain("Groq ·");
    expect(JSON.stringify(result)).not.toContain("test-key");
  });

  it("lists what is free now with source and age", () => {
    const now = 1_700_000_000_000;
    const board = router.freeNowBoard(
      [
        cloud("openai", "gpt-4o"),
        local,
        {
          id: "groq:cool",
          type: "cloud",
          access: "free",
          capabilities: { chat: true, tools: true },
          connected: true,
          providerId: "groq",
          displayName: "cool",
          coolingDown: true,
          cooldownUntil: now + 60_000,
          accessRecord: {
            evidence: {
              source: "provider_free_plan",
              checkedAt: now - 5000,
              url: "https://console.groq.com/docs/models",
            },
          },
        },
      ],
      { now, policy: "free-preferred" },
    ) as Array<{
      id: string;
      cooling?: boolean;
      source?: string;
      ageMs?: number;
      marks?: string[];
    }>;
    expect(board.some((row) => row.id.includes("gpt-4o"))).toBe(false);
    expect(board.find((row) => row.id === "ollama:llama3.2")?.marks).toContain("local");
    const cool = board.find((row) => row.id === "groq:cool");
    expect(cool?.cooling).toBe(true);
    expect(cool?.source).toBe("provider_free_plan");
    expect(cool?.ageMs).toBe(5000);
  });
});
