/**
 * Ollama and LM Studio daemon states go through routeRequest.
 * The servers are local fixtures. No vendor process is started.
 */
import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { pinKnowledgeClock } from "./helpers/knowledge-clock";

const require_ = createRequire(import.meta.url);
pinKnowledgeClock();

const models = require_("../../electron/models.cjs");
const router = require_("../../electron/model-router.cjs");
const caps = require_("../../electron/model-capabilities.cjs");
const handlers = require_("../../electron/provider-registry.cjs");

function listen(server: Server) {
  return new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

function close(server: Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function localModel(
  providerId: string,
  name: string,
  raw: Record<string, unknown>,
  resident: boolean,
) {
  return {
    id: `${providerId}:${name}`,
    type: "local" as const,
    providerId,
    status: "ready",
    meta: {
      providerId,
      kind: "local",
      modelName: name,
      connected: true,
      resident,
      catalogue: raw,
    },
  };
}

describe("local daemon funnel", () => {
  it("routes a loaded Ollama model, an empty daemon, a down daemon, a stale id, a stream, and an error", async () => {
    handlers.ensureHandlers();
    const ollama = handlers.handlerFor("ollama");
    let mode: "loaded" | "empty" | "stream" | "error" = "loaded";
    const server = createServer((req, res) => {
      const url = req.url || "";
      if (req.method === "GET" && url.startsWith("/api/tags")) {
        const modelsBody =
          mode === "empty"
            ? []
            : [
                {
                  name: "llama3.2",
                  capabilities: ["completion", "tools"],
                  details: { family: "llama" },
                  model_info: { "llama.context_length": 131072 },
                },
              ];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: modelsBody }));
        return;
      }
      if (req.method === "GET" && url.startsWith("/api/ps")) {
        const running =
          mode === "loaded" || mode === "stream" ? [{ name: "llama3.2", size: 1 }] : [];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: running }));
        return;
      }
      if (req.method === "POST" && url.startsWith("/api/chat")) {
        if (mode === "error") {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "model 'gone' not found" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.end(
          '{"message":{"content":"ready"},"done":false}\n{"message":{"content":" now"},"done":true}\n',
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}`;

    mode = "loaded";
    const up = await models.ollamaModels(base);
    const running = await models.ollamaRunning(base);
    expect(up.online).toBe(true);
    expect(up.models.map((row: { name: string }) => row.name)).toEqual(["llama3.2"]);
    expect(running.models.map((row: { id: string }) => row.id)).toEqual(["llama3.2"]);
    const raw = up.models[0].catalogue;
    const loaded = localModel("ollama", "llama3.2", raw, true);
    const stale = {
      ...localModel("ollama", "gone", { name: "gone" }, false),
      status: "unavailable",
      meta: { ...localModel("ollama", "gone", {}, false).meta, loaded: false },
    };
    const routed = router.routeRequest([loaded, stale], {
      mode: "auto",
      policy: "free-preferred",
      task: "chat",
    });
    expect(routed.selected).toBe("ollama:llama3.2");
    expect(routed.candidates).not.toContain("ollama:gone");
    const seen = caps.resolveCapabilities(loaded);
    expect(seen.tools).toBe(true);
    expect(seen.proof.tools).toBe("live");
    expect(seen.proof.context).toBe("live");
    expect(seen.contextK).toBe(128);

    const unnamed = caps.resolveCapabilities({
      id: "llama3.2",
      meta: { modelName: "llama3.2", catalogue: { name: "llama3.2" } },
    });
    expect(unnamed.tools).toBe(true);
    expect(unnamed.proof.tools).toBe("unverified");

    mode = "empty";
    const none = await models.ollamaModels(base);
    expect(none.online).toBe(true);
    expect(none.models).toEqual([]);
    const emptyRoute = router.routeRequest([], {
      mode: "auto",
      policy: "free-preferred",
      task: "chat",
    });
    expect(emptyRoute.selected).toBeNull();

    await close(server);
    const down = await models.ollamaModels(base);
    expect(down.online).toBe(false);
    expect(down.models).toEqual([]);
    expect(down.error).toBe("Ollama not running");

    const streamServer = createServer((req, res) => {
      if (req.method === "POST") {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.end('{"message":{"content":"ready"},"done":true}\n');
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "llama3.2", capabilities: ["completion"] }] }));
    });
    const streamPort = await listen(streamServer);
    const streamRes = await fetch(`http://127.0.0.1:${streamPort}/api/chat`, { method: "POST" });
    const streamText = await streamRes.text();
    const parsed = ollama.parseStream(streamText);
    expect(parsed.content).toBe("ready");
    expect(parsed.sawDone).toBe(true);
    const again = await models.ollamaModels(`http://127.0.0.1:${streamPort}`);
    const streamRoute = router.routeRequest(
      [localModel("ollama", again.models[0].name, again.models[0].catalogue, true)],
      { mode: "auto", policy: "free-preferred", task: "chat" },
    );
    expect(streamRoute.selected).toBe("ollama:llama3.2");
    await close(streamServer);

    const errorServer = createServer((_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "model 'gone' not found" }));
    });
    const errorPort = await listen(errorServer);
    const errorRes = await fetch(`http://127.0.0.1:${errorPort}/api/chat`, { method: "POST" });
    const errorText = await errorRes.text();
    const errorBody = ollama.parseStream(errorText);
    expect(errorBody.error).toMatch(/not found/);
    const mapped = ollama.mapError({ status: errorRes.status, message: errorBody.error });
    expect(mapped.category).toBe("model_unavailable");
    const afterError = router.routeRequest(
      [
        { ...localModel("ollama", "gone", { name: "gone" }, false), status: "unavailable" },
        localModel(
          "ollama",
          "llama3.2",
          { name: "llama3.2", capabilities: ["completion", "tools"] },
          true,
        ),
      ],
      { mode: "auto", policy: "free-preferred", task: "chat" },
    );
    expect(afterError.selected).toBe("ollama:llama3.2");
    expect(afterError.candidates).not.toContain("ollama:gone");
    await close(errorServer);
  });

  it("routes only a loaded LM Studio model and reads its live tools, vision, and context", async () => {
    handlers.ensureHandlers();
    const studio = handlers.handlerFor("lmstudio");
    let body: Record<string, unknown> = {
      models: [
        {
          type: "llm",
          key: "google/gemma",
          loaded_instances: [{ id: "live" }],
          max_context_length: 8192,
          capabilities: { vision: false, trained_for_tool_use: true },
        },
      ],
    };
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}`;
    const loaded = await models.lmStudioEngine([base]);
    expect(loaded.online).toBe(true);
    expect(loaded.models.map((row: { id: string }) => row.id)).toEqual(["google/gemma"]);
    const row = loaded.models[0];
    const model = localModel("lmstudio", row.id, row.catalogue, true);
    const routed = router.routeRequest([model], {
      mode: "auto",
      policy: "free-preferred",
      task: "chat",
    });
    expect(routed.selected).toBe("lmstudio:google/gemma");
    const seen = caps.resolveCapabilities(model);
    expect(seen.tools).toBe(true);
    expect(seen.vision).toBe(false);
    expect(seen.proof.tools).toBe("live");
    expect(seen.proof.vision).toBe("live");
    expect(seen.proof.context).toBe("live");
    expect(seen.contextK).toBe(8);

    body = {
      models: [
        {
          type: "llm",
          key: "google/gemma",
          loaded_instances: [],
          max_context_length: 8192,
          capabilities: { vision: true, trained_for_tool_use: false },
        },
      ],
    };
    const none = await models.lmStudioEngine([base]);
    expect(none.online).toBe(true);
    // A downloaded model that is not loaded stays visible with the reason and is never routable.
    expect(none.error).toBe("model not loaded in LM Studio");
    expect(none.models).toHaveLength(1);
    expect(none.models[0]).toMatchObject({ id: "google/gemma", loaded: false });
    expect(none.models.filter((row: { loaded?: boolean }) => row.loaded !== false)).toEqual([]);
    body = {
      models: [
        {
          type: "embedding",
          key: "nomic-embed",
          loaded_instances: [{ id: "embed" }],
          max_context_length: 2048,
        },
      ],
    };
    const embedDaemon = await models.lmStudioEngine([base]);
    expect(embedDaemon.models.map((row: { id: string }) => row.id)).toEqual(["nomic-embed"]);
    const embedOnly = localModel(
      "lmstudio",
      "nomic-embed",
      { type: "embedding", key: "nomic-embed", max_context_length: 2048 },
      true,
    );
    const embedRoute = router.routeRequest([embedOnly], {
      mode: "auto",
      policy: "free-preferred",
      task: "chat",
    });
    expect(embedRoute.selected).toBeNull();
    expect(caps.resolveCapabilities(embedOnly).embeddings).toBe(true);
    expect(caps.resolveCapabilities(embedOnly).chat).toBe(false);

    await close(server);
    const down = await models.lmStudioEngine([base]);
    expect(down.online).toBe(false);
    expect(down.models).toEqual([]);

    const chat = createServer((req, res) => {
      if (req.url === "/error") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "model not found" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"studio"}}]}\n\ndata: [DONE]\n');
    });
    const chatPort = await listen(chat);
    const streamRes = await fetch(`http://127.0.0.1:${chatPort}/v1/chat/completions`, {
      method: "POST",
    });
    const stream = studio.parseStream(await streamRes.text());
    expect(stream.content).toBe("studio");
    expect(stream.sawDone).toBe(true);
    const errorRes = await fetch(`http://127.0.0.1:${chatPort}/error`, { method: "POST" });
    const errorJson = (await errorRes.json()) as { error: { message: string } };
    const mapped = studio.mapError({ status: errorRes.status, message: errorJson.error.message });
    expect(mapped.category).toBe("model_unavailable");
    const stale = router.routeRequest(
      [{ ...localModel("lmstudio", "old", { key: "old" }, false), status: "unavailable" }],
      { mode: "auto", policy: "free-preferred", task: "chat" },
    );
    expect(stale.selected).toBeNull();
    await close(chat);
  });
});
