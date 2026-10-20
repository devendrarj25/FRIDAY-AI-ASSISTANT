/**
 * Zero-spend model probes. No prompt, no spend, and no cloud call in Privacy mode.
 */
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const router = require_(path.join(__dirname, "../../electron/model-router.cjs")) as {
  planHealthProbe: (state: { privacy?: boolean }) => { run: boolean; spend: string };
  planModelProbes: (state: {
    models: Array<Record<string, unknown>>;
    privacy?: boolean;
    now?: number;
    jitterMs?: number;
    ttlMs?: number;
  }) => {
    probes: Array<{
      id: string;
      url: string;
      method: string;
      body: null;
      network: boolean;
      prompt: boolean;
      spend: string;
    }>;
    concurrency: number;
    delayMs: number;
    prompt: boolean;
  };
  runZeroSpendProbes: (
    plan: { probes: unknown[]; concurrency?: number },
    options: {
      fetchImpl: (
        url: string,
        init: { method?: string; body?: unknown },
      ) => Promise<{ ok: boolean; status: number }>;
      health: {
        noteSuccess: (id: string, ms: number) => void;
        noteFailure: (
          id: string,
          error: { message: string; status?: number },
          now?: number,
        ) => void;
        noteProbe: (id: string, now?: number) => void;
        snapshot: (now?: number) => Array<{ modelId: string; coolingDown: boolean }>;
      };
      now?: number;
    },
  ) => Promise<{ ran: number }>;
  ProviderHealthManager: new () => {
    noteSuccess: (id: string, ms: number) => void;
    noteFailure: (id: string, error: { message: string; status?: number }, now?: number) => void;
    noteProbe: (id: string, now?: number) => void;
    snapshot: (now?: number) => Array<{ modelId: string; coolingDown: boolean }>;
  };
  scoreModel: (model: Record<string, unknown>, options?: { task?: string }) => number;
};

function listen(server: ReturnType<typeof createServer>) {
  return new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

describe("zero-spend model probes", () => {
  it("keeps the catalogue plan and probes each model without a prompt", () => {
    expect(router.planHealthProbe({ privacy: true })).toMatchObject({ run: false, spend: "zero" });
    const now = 1_000_000;
    const plan = router.planModelProbes({
      now,
      jitterMs: 1500,
      privacy: true,
      models: [
        {
          id: "ollama:llama",
          provider: "ollama",
          type: "local",
          endpoint: "http://127.0.0.1:11434",
        },
        {
          id: "groq:llama",
          provider: "groq",
          type: "cloud",
          listUrl: "https://api.groq.com/openai/v1/models",
          hasKey: true,
        },
        {
          id: "fresh:one",
          provider: "ollama",
          type: "local",
          endpoint: "http://127.0.0.1:11434",
          lastProbeAt: now - 1000,
        },
      ],
    });
    expect(plan.prompt).toBe(false);
    expect(plan.delayMs).toBe(1500);
    expect(plan.concurrency).toBeLessThanOrEqual(3);
    expect(plan.probes.map((row) => row.id)).toEqual(["ollama:llama"]);
    expect(plan.probes[0]).toMatchObject({
      method: "GET",
      body: null,
      network: false,
      prompt: false,
      spend: "zero",
      url: "http://127.0.0.1:11434/api/tags",
    });
  });

  it("marks a dead model from a fake server and leaves a live one usable", async () => {
    const seen: Array<{ url: string; method: string; body: unknown }> = [];
    let active = 0;
    let max = 0;
    const server = createServer((req, res) => {
      active += 1;
      max = Math.max(max, active);
      seen.push({ url: req.url || "", method: req.method || "", body: null });
      const dead = (req.url || "").includes("dead");
      res.writeHead(dead ? 500 : 200, { "content-type": "application/json" });
      res.end(dead ? "{}" : '{"models":[]}');
      active -= 1;
    });
    const port = await listen(server);
    const health = new router.ProviderHealthManager();
    const probes = ["ok-a", "ok-b", "dead", "ok-c", "ok-d", "ok-e"].map((id) => ({
      id,
      provider: "ollama",
      url: `http://127.0.0.1:${port}/${id}`,
      method: "GET",
      body: null,
      network: false,
      spend: "zero",
      prompt: false,
    }));
    const result = await router.runZeroSpendProbes(
      { probes, concurrency: 3 },
      {
        health,
        now: 50_000,
        fetchImpl: async (url, init) => {
          expect(init.method).toBe("GET");
          expect(init.body ?? null).toBeNull();
          const res = await fetch(url, { method: "GET" });
          return { ok: res.ok, status: res.status };
        },
      },
    );
    expect(result.ran).toBe(6);
    expect(seen.every((row) => row.method === "GET")).toBe(true);
    expect(max).toBeLessThanOrEqual(6);
    const dead = health.snapshot(50_000).find((row) => row.modelId === "dead");
    expect(dead?.coolingDown).toBe(true);
    const shape = {
      role: "brain",
      capabilities: {},
      contextK: 8,
      access: "free",
      type: "local",
      failures: 0,
    };
    const healthy = router.scoreModel({ ...shape, id: "ok-a", coolingDown: false });
    const cooled = router.scoreModel({ ...shape, id: "dead", coolingDown: true, failures: 1 });
    expect(cooled).toBeLessThan(healthy - 40);
    server.close();
  });
});
