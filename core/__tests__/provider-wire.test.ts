/**
 * Fake servers for the wires FRIDAY actually speaks.
 * No live key. The report writer must not keep a key.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pinKnowledgeClock } from "./helpers/knowledge-clock";

const require_ = createRequire(import.meta.url);
pinKnowledgeClock();

const models = require_("../../electron/models.cjs");
const handlers = require_("../../electron/provider-handler.cjs");
const router = require_("../../electron/model-router.cjs");
const { registerAll } = require_("../../electron/handlers/index.cjs");
const { writeLiveReport } = require_("../../scripts/models-check.cjs");

registerAll();

const roots: string[] = [];
const servers: http.Server[] = [];

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-wire-"));
  roots.push(dir);
  return dir;
}

function listen(handler: http.RequestListener) {
  return new Promise<{ server: http.Server; port: number }>((resolve) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, port });
    });
  });
}

afterEach(async () => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("provider wires through a fake server", () => {
  it("lists and routes an OpenAI-compatible Gemini body, and redacts the key", async () => {
    let chat = 0;
    const { port } = await listen((req, res) => {
      if (req.method === "GET") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "gemini-2.5-flash" }] }));
        return;
      }
      chat += 1;
      res.statusCode = 429;
      res.setHeader("retry-after", "2");
      res.end(JSON.stringify({ error: { message: "slow down sk-aaaaaaaaaaaaaaaa" } }));
    });
    const root = tempRoot();
    expect(models.writeEndpoint(root, "gemini", `http://127.0.0.1:${port}/v1beta/openai`).ok).toBe(
      true,
    );
    const probed = await models.testProviderChat("gemini", {
      userData: root,
      apiKey: "sk-aaaaaaaaaaaaaaaa",
      policy: "free-preferred",
    });
    expect(JSON.stringify(probed)).not.toContain("sk-aaaaaaaaaaaaaaaa");
    expect(probed.category).toBe("rate_limited");
    expect(probed.modelId).toBe("gemini-2.5-flash");
    expect(chat).toBe(1);
    const mapped = handlers.getHandler("gemini").mapError({
      status: 429,
      message: "slow down",
      headers: { "retry-after": "2" },
    });
    expect(mapped.category).toBe("rate_limited");
    expect(mapped.cooldownMs).toBe(2000);
    expect(mapped.nextStep.length).toBeGreaterThan(0);
  });

  it("reads one streamed clause from an OpenAI-compatible body", async () => {
    const { port } = await listen((req, res) => {
      if (req.method === "GET") {
        res.end(JSON.stringify({ data: [{ id: "gemini-2.5-flash" }] }));
        return;
      }
      res.end(
        'data: {"choices":[{"delta":{"content":"Hello. ","tool_calls":[{"id":"c1","function":{"name":"lookup","arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n',
      );
    });
    const root = tempRoot();
    expect(models.writeEndpoint(root, "gemini", `http://127.0.0.1:${port}/v1beta/openai`).ok).toBe(
      true,
    );
    const probed = await models.testProviderChat("gemini", {
      userData: root,
      apiKey: "sk-aaaaaaaaaaaaaaaa",
      policy: "free-preferred",
    });
    expect(probed.ok).toBe(true);
    expect(probed.stream).toBe(true);
    expect(JSON.stringify(probed)).not.toContain("sk-aaaaaaaaaaaaaaaa");
    const parsed = handlers
      .getHandler("openai")
      .parseStream(
        'data: {"choices":[{"delta":{"content":"Hello. ","tool_calls":[{"id":"c1","function":{"name":"lookup","arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n',
      );
    expect(parsed.content).toBe("Hello.");
    expect(parsed.sawTool).toBe(true);
    expect(parsed.sawDone).toBe(true);
  });

  it("reads Cohere, Ollama, and LM Studio bodies from one local server", async () => {
    const { port } = await listen((req, res) => {
      res.setHeader("content-type", "application/json");
      if ((req.url || "").includes("/api/tags")) {
        res.end(JSON.stringify({ models: [{ name: "llama3.2:latest" }] }));
        return;
      }
      if ((req.url || "").includes("/api/v0/models")) {
        res.end(
          JSON.stringify({
            data: [{ id: "local-model", state: "loaded" }],
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          models: [
            { name: "command-r", endpoints: ["chat"], is_deprecated: false },
            { name: "embed-english", endpoints: ["embed"], is_deprecated: false },
          ],
        }),
      );
    });
    const base = `http://127.0.0.1:${port}`;
    const cohere = await (await fetch(`${base}/v1/models`)).json();
    const tags = await (await fetch(`${base}/api/tags`)).json();
    const studio = await (await fetch(`${base}/api/v0/models`)).json();
    expect(handlers.getHandler("cohere").discoverModels(cohere)).toEqual(["command-r"]);
    expect(handlers.getHandler("ollama").discoverModels(tags)).toEqual(["llama3.2:latest"]);
    expect(models.lmStudioCatalog(studio, "v0")).toEqual([
      expect.objectContaining({ id: "local-model", loaded: true }),
    ]);
    const idle = models.lmStudioCatalog(
      { data: [{ id: "local-model", state: "not-loaded" }] },
      "v0",
    );
    expect(idle[0]?.loaded).toBe(false);
    const result = models.lmStudioResult("http://127.0.0.1:9", idle, 1);
    expect(result.models).toEqual([]);
    expect(result.error).toMatch(/no model loaded/i);
  });

  it("maps a removed model and a dead daemon, then skips them", () => {
    const gone = handlers.getHandler("openai").mapError({
      status: 404,
      message: "model not found",
    });
    expect(gone.category).toBe("model_unavailable");
    expect(gone.delist).toBe(true);
    expect(gone.nextStep).toMatch(/next/i);
    const down = handlers.getHandler("ollama").mapError({
      message: "connect ECONNREFUSED 127.0.0.1:11434",
    });
    expect(down.category).toBe("offline");
    expect(down.nextStep.length).toBeGreaterThan(0);
    const stale = {
      id: "ollama:old",
      type: "local",
      providerId: "ollama",
      providerModelId: "old",
      status: "unavailable",
      contextK: 8,
      meta: { kind: "local", providerId: "ollama", modelName: "old", loaded: false },
    };
    const live = {
      id: "ollama:live",
      type: "local",
      providerId: "ollama",
      providerModelId: "live",
      contextK: 8,
      meta: { kind: "local", providerId: "ollama", modelName: "live", loaded: true },
    };
    const plan = router.routeRequest([stale, live], {
      mode: "local-only",
      policy: "free-preferred",
      task: "chat",
    });
    expect(plan.candidates).not.toContain("ollama:old");
    expect(plan.candidates).toContain("ollama:live");
    const rest = router.orderFallbacks([stale, live], stale, "model_unavailable");
    expect(rest.map((row: { id: string }) => row.id)).toEqual(["ollama:live"]);
  });

  it("chooses a lane for a few hundred models from memory", () => {
    const pool = Array.from({ length: 200 }, (_, index) => ({
      id: `ollama:m${index}`,
      type: "local",
      providerId: "ollama",
      providerModelId: `m${index}`,
      contextK: 8,
      meta: { kind: "local", providerId: "ollama", modelName: `m${index}`, loaded: true },
    }));
    const started = performance.now();
    const plan = router.routeRequest(pool, {
      mode: "local-only",
      policy: "free-preferred",
      task: "chat",
    });
    expect(plan.candidates.length).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe("live model report", () => {
  it("writes a redacted file and refuses a key", () => {
    const root = tempRoot();
    const file = path.join(root, "models-check-live.json");
    writeLiveReport(
      [{ id: "groq", result: "FAIL", detail: "bad sk-aaaaaaaaaaaaaaaa", latencyMs: 12 }],
      file,
    );
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain('"id": "groq"');
    expect(text).toContain("sk-redacted");
    expect(text).not.toContain("sk-aaaaaaaaaaaaaaaa");
  });
});
