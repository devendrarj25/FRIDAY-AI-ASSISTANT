import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const require_ = createRequire(import.meta.url);
const models = require_("../../electron/models.cjs");
const capabilities = require_("../../electron/model-capabilities.cjs");

const spec = (id: string, role: string, modelName: string) => ({
  id,
  label: id,
  provider: "ollama",
  endpoint: "http://127.0.0.1:11434",
  role,
  params: "",
  contextK: 8,
  status: "ready",
  options: { model: modelName },
  meta: { providerId: "ollama", kind: "local", modelName, resident: false, sizeGb: 1 },
});

describe("auto model routing", () => {
  const inventory = [
    spec("ollama:qwen2.5:32b", "brain", "qwen2.5:32b"),
    spec("ollama:deepseek-coder:6.7b", "coder", "deepseek-coder:6.7b"),
    spec("ollama:nomic-embed-text", "embed", "nomic-embed-text"),
  ];

  it("puts the role-matching model first when nothing is preferred", () => {
    const ordered = models.selectForTask(inventory, "code", []);
    expect(ordered[0].id).toBe("ollama:deepseek-coder:6.7b");
  });

  it("never routes chat to an embedding model", () => {
    const ordered = models.selectForTask(inventory, "chat", []);
    expect(ordered.some((m: { role: string }) => m.role === "embed")).toBe(false);
  });

  it("matches a catalogue id against the real engine tag", () => {
    const ordered = models.selectForTask(inventory, "chat", ["qwen2.5-32b"]);
    expect(ordered[0].id).toBe("ollama:qwen2.5:32b");
  });

  it("ignores a preference that is not installed instead of failing", () => {
    const ordered = models.selectForTask(inventory, "chat", ["not-installed-model"]);
    expect(ordered.length).toBeGreaterThan(0);
  });

  it("uses the hardened router for the renderer selection IPC and strips API keys", () => {
    const main = readFileSync(resolve(process.cwd(), "electron/main.cjs"), "utf8");
    const handler = main.slice(
      main.indexOf('ipcMain.handle("models:select"'),
      main.indexOf('ipcMain.handle("privacy:last"'),
    );
    expect(handler).toContain("await resolveChatModels(");
    expect(handler).not.toContain("selectForTask(");
    expect(handler).toContain("api_key: _key");
    expect(handler).toContain("api_key: _metaKey");
  });

  it("classifies Code Llama as coding without marking every Llama model as coding", () => {
    expect(
      capabilities.resolveCapabilities(spec("codellama", "coder", "codellama:13b")).coding,
    ).toBe(true);
    expect(
      capabilities.resolveCapabilities(spec("llama", "brain", "llama-3.3-70b-instruct")).coding,
    ).toBe(false);
  });

  it("keeps one-shot and phone kernel fallbacks inside the published route pool", () => {
    const kernel = readFileSync(resolve(process.cwd(), "kernel/main.py"), "utf8");
    const complete = kernel.slice(
      kernel.indexOf('if method == "chat.complete":'),
      kernel.indexOf('if method == "task.run":'),
    );
    expect(complete).toContain("router.ids_for_live(live)");
    expect(complete).not.toContain("best_available(");
    expect(complete).toContain("None of the requested models is ready and chat-capable.");

    const phone = kernel.slice(
      kernel.indexOf("async def companion_chat"),
      kernel.indexOf("async def companion_speak"),
    );
    expect(phone).toContain("if model_ids is None:");
    expect(phone).toContain("allow_fallback=False");
    expect(phone).toContain("route_mode=");
  });

  it("sends the owner route mode through desktop chat.stream so the kernel can re-enforce it", () => {
    const main = readFileSync(resolve(process.cwd(), "electron/main.cjs"), "utf8");
    const stream = main.slice(
      main.indexOf("async function streamOnce"),
      main.indexOf("async function startChat"),
    );
    expect(stream).toContain('method: "chat.stream"');
    expect(stream).toContain("routeMode: request.routeMode || modelRouteMode()");
    expect(stream).toContain("allowFallback: false");

    const rpc = main.slice(
      main.indexOf('ipcMain.handle("kernel:rpc"'),
      main.indexOf('ipcMain.handle("permissions:tool-policy"'),
    );
    expect(rpc).toContain("payload.routeMode = modelRouteMode()");
  });

  it("never translates local-only/cloud-only into multi just because models are selected", () => {
    const main = readFileSync(resolve(process.cwd(), "electron/main.cjs"), "utf8");
    expect(main).toContain("const routeMode = request.routeMode || modelRouteMode()");
    expect(main).not.toContain('wanted.length ? "multi"');
    expect(main).toContain("exclusive: wanted.length > 0");
    expect(main).toContain("function startModelRegistryRefresh()");
    expect(main).toContain("function emitModelLifecycle(");
  });

  it("maps health categories onto the shared lifecycle kinds", () => {
    const router = require_("../../electron/model-router.cjs");
    expect(router.MODEL_EVENT_KINDS).toContain("ROUTE_CHANGED");
    expect(router.MODEL_EVENT_KINDS).toContain("API_KEY_CHANGED");
    expect(router.lifecycleKindFromHealth("rate_limited")).toBe("MODEL_RATE_LIMITED");
    expect(router.lifecycleKindFromHealth("quota_exceeded")).toBe("MODEL_EXHAUSTED");
    expect(router.lifecycleKindFromHealth("model_unavailable")).toBe("MODEL_RETIRED");
    expect(router.lifecycleKindFromHealth("available")).toBe("MODEL_VERIFIED");
  });
});
