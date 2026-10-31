/**
 * Phase 1: one handler per provider, lane decisions, allowlist, paid gate,
 * and a single chat/voice funnel.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pinKnowledgeClock } from "./helpers/knowledge-clock";

const require_ = createRequire(import.meta.url);
pinKnowledgeClock();

const router = require_("../../electron/model-router.cjs");
const handlers = require_("../../electron/provider-handler.cjs");
const registry = require_("../../electron/provider-registry.cjs");
const modelsApi = require_("../../electron/models.cjs");
const { CLOUD_IDS, LOCAL_IDS } = require_("../../electron/handlers/index.cjs");

const ROOT = path.resolve(__dirname, "../..");

const cloud = (providerId: string, modelId: string) => ({
  id: `${providerId}:${modelId}`,
  type: "cloud" as const,
  contextK: 32,
  providerId,
  providerModelId: modelId,
  meta: { providerId, kind: "cloud", modelName: modelId, connected: true },
});

const local = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "local" as const,
  contextK: 8,
  providerId: String(extra["providerId"] || "ollama"),
  meta: {
    providerId: "ollama",
    kind: "local",
    modelName: id.split(":")[1] || id,
    connected: true,
    ...extra,
  },
});

const FREE = cloud("gemini", "gemini-2.5-flash");
const FREE_OTHER = cloud("gemini", "gemini-2.5-pro");
const PAID = cloud("groq", "openai/gpt-oss-20b");
const LOCAL = local("ollama:llama3.2");
const POOL = [LOCAL, FREE, PAID];

describe("provider handlers", () => {
  const registered = registry.ensureHandlers();

  it("registers one handler for every cloud and local provider", () => {
    expect([...CLOUD_IDS].sort()).toEqual(Object.keys(modelsApi.CLOUD).sort());
    expect(LOCAL_IDS).toEqual([
      "ollama",
      "lmstudio",
      "llamacpp",
      "vllm",
      "localai",
      "jan",
      "koboldcpp",
      "transformers",
      "gpt4all",
      "mlx",
      "local",
    ]);
    for (const id of [...CLOUD_IDS, ...LOCAL_IDS]) {
      const handler = handlers.getHandler(id);
      expect(handler, id).toBeTruthy();
      expect(handlers.handlerContractErrors(handler)).toEqual([]);
    }
    expect(registered.length).toBe(CLOUD_IDS.length + LOCAL_IDS.length);
  });

  it("parses official list payloads and builds a request without a key", () => {
    const gemini = handlers.getHandler("gemini");
    expect(gemini.discoverModels({ data: [{ id: "models/gemini-2.5-flash" }] })).toEqual([
      "gemini-2.5-flash",
    ]);
    expect(gemini.baseUrl()).toMatch(/^https:\/\//);
    const built = gemini.buildRequest({
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "sk-secretvalue12",
      key: "sk-secretvalue12",
    });
    expect(JSON.stringify(built)).not.toMatch(/sk-secret/);
    expect(built.url).toMatch(/^https:\/\//);
    expect(handlers.getHandler("anthropic").auth.header).toBe("x-api-key");
    expect(JSON.stringify(handlers.getHandler("anthropic").auth)).not.toMatch(/TOKEN/);
    const ollama = handlers.getHandler("ollama");
    expect(ollama.discoverModels({ models: [{ name: "llama3.2:latest" }] })).toEqual([
      "llama3.2:latest",
    ]);
    expect(ollama.launcher.autoStart).toBe(false);
    const parsed = gemini.parseStream('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n');
    expect(parsed.content).toBe("Hi");
  });

  it("classifies through the existing access engine and redacts errors", () => {
    const groq = handlers.getHandler("groq");
    const paid = groq.classifyAccess({ modelId: "openai/gpt-oss-20b" });
    expect(paid.billingMode).toBe("PAID");
    const localRecord = handlers.getHandler("ollama").classifyAccess({ modelId: "llama3.2" });
    expect(localRecord.billingMode).toBe("ZERO_COST");
    const mapped = groq.mapError({
      status: 401,
      message: "invalid api key sk-secretvalue12",
    });
    expect(mapped.category).toBe("invalid_key");
    expect(JSON.stringify(mapped)).not.toMatch(/sk-/);
    for (const handler of handlers.listHandlers()) {
      // The generic OpenAI-compatible provider has no built-in address on purpose: the owner enters one,
      // and the endpoint check (https, or localhost) applies to what he enters.
      if (handler.kind === "cloud" && handler.id === "openai-compatible") {
        expect(handler.baseUrl()).toBe("");
      } else if (handler.kind === "cloud") expect(handler.baseUrl()).toMatch(/^https:\/\//);
      if (handler.kind === "local" && handler.id !== "mlx" && handler.id !== "local") {
        expect(handler.baseUrl()).toMatch(/^http:\/\/127\.0\.0\.1/);
      }
      expect(handler.launcher?.autoStart ?? false).toBe(false);
    }
  });
});

describe("master lane", () => {
  const modes = router.ROUTE_MODES as string[];
  const policies = router.POLICIES as string[];

  it("decides a lane for every mode, policy, privacy, offline flag, and surface", () => {
    for (const mode of modes) {
      for (const policy of policies) {
        for (const privacy of ["standard", "private"] as const) {
          for (const offline of [false, true]) {
            for (const surface of ["chat", "voice"] as const) {
              const options = {
                mode,
                policy,
                offline,
                surface,
                requirements: { privacy },
                paidEnabled: false,
                firewallAllowsPaid: false,
                budgetAllows: true,
              };
              const chat = router.decideLane(POOL, { ...options, surface: "chat" });
              const voice = router.decideLane(POOL, { ...options, surface: "voice" });
              expect(voice.lane).toBe(chat.lane);
              expect(voice.handoff).toEqual(chat.handoff);
              const routed = router.routeRequest(POOL, options);
              const other = router.routeRequest(POOL, {
                ...options,
                surface: surface === "chat" ? "voice" : "chat",
              });
              expect(other.lane).toBe(routed.lane);
              expect(new Set(other.candidates)).toEqual(new Set(routed.candidates));
              expect(routed.candidates.includes(PAID.id)).toBe(false);
              if (privacy === "private" || offline || mode === "local-only") {
                expect(routed.candidates.every((id: string) => id.startsWith("ollama:"))).toBe(
                  true,
                );
              }
              if (mode === "cloud-only" && privacy !== "private" && !offline) {
                expect(routed.candidates.every((id: string) => !id.startsWith("ollama:"))).toBe(
                  true,
                );
              }
              if (mode === "cloud-only" && (privacy === "private" || offline)) {
                expect(routed.candidates).toEqual([]);
              }
              expect(routed.why.startsWith(`${routed.lane}:`)).toBe(true);
            }
          }
        }
      }
    }
  });

  it("puts a capable local model ahead of verified free cloud", () => {
    const routed = router.routeRequest(POOL, { mode: "auto", policy: "free-preferred" });
    expect(routed.lane).toBe("local");
    expect(routed.candidates[0]).toBe(LOCAL.id);
    expect(routed.candidates).toContain(FREE.id);
    expect(routed.candidates).not.toContain(PAID.id);
    expect(routed.handler).toBe("ollama");
  });

  it("starts on verified free cloud when the only local model is not loaded", () => {
    const studio = {
      id: "lmstudio:hidden",
      type: "local",
      providerId: "lmstudio",
      meta: {
        providerId: "lmstudio",
        kind: "local",
        modelName: "hidden",
        loaded: false,
        connected: true,
      },
    };
    const routed = router.routeRequest([studio, FREE, PAID], {
      mode: "auto",
      policy: "free-preferred",
    });
    expect(routed.lane).toBe("cloud-free");
    expect(routed.candidates[0]).toBe(FREE.id);
    expect(routed.candidates).not.toContain(studio.id);
    expect(routed.candidates).not.toContain(PAID.id);
  });

  it("keeps chat and voice on the same lane and the same models", () => {
    const slow = local("ollama:slow", { qualityProfile: { chatScore: 1, speedScore: 0.1 } });
    const fast = local("ollama:fast", { qualityProfile: { chatScore: 0.2, speedScore: 1 } });
    const health = {
      get(id: string) {
        if (id.endsWith("slow")) return { latencyMs: 800, status: "available" };
        if (id.endsWith("fast")) return { latencyMs: 120, status: "available" };
        return null;
      },
    };
    const chat = router.routeRequest([slow, fast, FREE], {
      mode: "auto",
      policy: "free-preferred",
      surface: "chat",
      health,
    });
    const voice = router.routeRequest([slow, fast, FREE], {
      mode: "auto",
      policy: "free-preferred",
      surface: "voice",
      health,
    });
    expect(voice.lane).toBe(chat.lane);
    expect(voice.handoff).toEqual(chat.handoff);
    expect(new Set(voice.candidates)).toEqual(new Set(chat.candidates));
    expect(chat.surfaceHint).toBe("quality-first");
    expect(voice.surfaceHint).toBe("latency-first");
  });
});

describe("cloud allowlist and paid lane", () => {
  it("never calls a cloud model that was not selected", () => {
    const saved = router.normaliseAllowlist({ ids: [FREE_OTHER.id], paidEnabled: false });
    const routed = router.routeRequest([LOCAL, FREE, FREE_OTHER, PAID], {
      mode: "auto",
      policy: "free-preferred",
      allowlist: saved,
    });
    expect(routed.candidates).not.toContain(FREE.id);
    expect(routed.candidates).toContain(FREE_OTHER.id);
    expect(routed.candidates).not.toContain(PAID.id);
    const empty = router.routeRequest(POOL, {
      mode: "auto",
      policy: "free-preferred",
      allowlist: { ids: [], paidEnabled: false },
    });
    expect(empty.candidates).toEqual([LOCAL.id]);
    const legacy = router.routeRequest(POOL, {
      mode: "auto",
      policy: "free-preferred",
      allowlist: null,
    });
    expect(legacy.candidates).toContain(FREE.id);
  });

  it("refuses paid unless the owner, the firewall, and the budget all allow it", () => {
    const gates = { paidEnabled: true, firewallAllowsPaid: true, budgetAllows: true };
    const closed = [
      { ...gates, paidEnabled: false },
      { ...gates, firewallAllowsPaid: false },
      { ...gates, budgetAllows: false },
    ];
    for (const gate of closed) {
      const routed = router.routeRequest(POOL, { mode: "auto", policy: "allow-paid", ...gate });
      expect(routed.candidates).not.toContain(PAID.id);
    }
    const open = router.routeRequest([FREE, PAID], {
      mode: "auto",
      policy: "allow-paid",
      ...gates,
    });
    expect(open.candidates).toContain(FREE.id);
    expect(open.candidates).toContain(PAID.id);
    expect(open.candidates.indexOf(FREE.id)).toBeLessThan(open.candidates.indexOf(PAID.id));
    const capped = router.budgetDecision({ perDayUsd: 1, spentDayUsd: 1 });
    expect(capped.allows).toBe(false);
    expect(router.normaliseAllowlist({ ids: ["sk-secretvalue12", FREE.id] }).ids).toEqual([
      FREE.id,
    ]);
  });
});

describe("single funnel", () => {
  it("sends chat and voice through routeRequest and blocks a direct provider call", () => {
    const main = readFileSync(path.join(ROOT, "electron/main.cjs"), "utf8");
    const funnel = main.slice(
      main.indexOf("async function resolveChatModels"),
      main.indexOf("async function checkNetwork"),
    );
    expect(funnel).toContain("modelRouter.routeRequest(");
    expect(funnel).not.toContain("selectEligible(");
    expect(main).toContain('ipcMain.handle("models:set-allowlist"');
    const walk = (dir: string, out: string[] = []) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name === "node_modules" || name === "dist") continue;
          walk(full, out);
        } else if (/\.(ts|tsx|cjs|js)$/.test(name)) out.push(full);
      }
      return out;
    };
    const allowed = new Set([
      path.join(ROOT, "src/lib/friday/model-catalog.ts"),
      path.join(ROOT, "electron/models.cjs"),
      path.join(ROOT, "electron/protocol-openai-compatible.cjs"),
    ]);
    const offenders: string[] = [];
    for (const file of [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "electron"))]) {
      if (allowed.has(file)) continue;
      const text = readFileSync(file, "utf8");
      if (text.includes("/chat/completions") || text.includes("api.openai.com/v1/chat"))
        offenders.push(path.relative(ROOT, file));
    }
    expect(offenders).toEqual([]);
    const assistant = readFileSync(path.join(ROOT, "src/lib/friday/assistant-mode.ts"), "utf8");
    const chat = readFileSync(path.join(ROOT, "src/components/friday/ChatDock.tsx"), "utf8");
    const brain = readFileSync(path.join(ROOT, "src/lib/friday/brain-engine.ts"), "utf8");
    expect(assistant).toContain('routingSurface: "voice"');
    expect(chat).toContain('routingSurface: "chat"');
    expect(brain).toContain("routingSurface:");
    expect(brain).not.toContain("/chat/completions");
    const spawned: string[] = [];
    for (const file of [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "electron"))]) {
      const text = readFileSync(file, "utf8");
      if (
        /spawn\([\s\S]{0,120}router\.py/.test(text) ||
        /execFile\([\s\S]{0,120}router\.py/.test(text)
      ) {
        spawned.push(path.relative(ROOT, file));
      }
    }
    expect(spawned).toEqual([]);
  });

  it("picks the local model that fits the task, then the next local one, then free cloud", () => {
    const coder = local("ollama:qwen2.5-coder:7b");
    const chatty = local("ollama:llama3.2:3b");
    const coding = router.routeRequest([chatty, coder, FREE, PAID], {
      mode: "auto",
      policy: "free-preferred",
      task: "code",
    });
    expect(coding.lane).toBe("local");
    expect(coding.candidates[0]).toBe(coder.id);
    expect(coding.candidates).toContain(FREE.id);
    expect(coding.candidates).not.toContain(PAID.id);
    const talking = router.routeRequest([chatty, coder, FREE, PAID], {
      mode: "auto",
      policy: "free-preferred",
      task: "chat",
    });
    // The chat model leads, the other local model is the next fallback, and
    // verified free cloud is last. Paid never joins the list.
    expect(talking.candidates).toEqual([chatty.id, coder.id, FREE.id]);
  });
});

describe("the generic OpenAI-compatible provider", () => {
  it("is a connector, not an unsupported entry", async () => {
    const { UNSUPPORTED_CLOUD } = await import("../../src/lib/friday/model-catalog");
    expect(UNSUPPORTED_CLOUD.has("openai-compatible")).toBe(false);
    expect(UNSUPPORTED_CLOUD.has("azure-openai")).toBe(true);
    expect(handlers.getHandler("openai-compatible").id).toBe("openai-compatible");
  });
});
