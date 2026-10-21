/**
 * Canonical catalogue, protocol adapters, and one module per provider.
 * Fixtures below are a documented shape from the 2026-10-21 official pages.
 * They are not a live provider response.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pinKnowledgeClock } from "./helpers/knowledge-clock";

const require_ = createRequire(import.meta.url);
pinKnowledgeClock();

const store = require_("../../electron/model-catalogue-store.cjs");
const protocols = require_("../../electron/protocol-registry.cjs");
const geminiProtocol = require_("../../electron/protocol-gemini-generate.cjs");
const handlers = require_("../../electron/provider-handler.cjs");
const registry = require_("../../electron/provider-registry.cjs");
const modelsApi = require_("../../electron/models.cjs");
const router = require_("../../electron/model-router.cjs");
const net = require_("../../electron/net-fetch.cjs");
const hubs = {
  cloud: require_("../../electron/provider-hub-cloud.cjs"),
  local: require_("../../electron/provider-hub-local.cjs"),
};
const coverage = require_("../../electron/provider-coverage.cjs");
const hfLocal = require_("../../electron/huggingface-local.cjs");
const { CLOUD_IDS, LOCAL_IDS } = require_("../../electron/handlers/index.cjs");

const root = path.resolve(__dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

afterEach(() => {
  net.setEgressPolicy(null);
});

describe("canonical catalogue", () => {
  it("keeps the previous file when the next body is empty or incomplete", () => {
    const previous = store.envelope(
      "groq",
      [{ providerId: "groq", nativeId: "llama" }],
      10,
      [],
      [],
    );
    const committed = store.commitRecords(
      store.commitRecords(null, previous).doc,
      store.envelope("groq", [], 11, [], []),
    );
    expect(committed.keptPrevious).toBe(true);
    expect(committed.doc.records).toHaveLength(1);
    const broken = store.commitRecords(
      committed.doc,
      store.envelope("groq", [{ providerId: "groq" }], 12, [], []),
    );
    expect(broken.keptPrevious).toBe(true);
    expect(broken.doc.records[0].nativeId).toBe("llama");
  });

  it("round-trips an atomic file and ignores a bad checksum", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-catalogue-"));
    const row = store.canonicalFromRoutable({
      id: "groq:llama",
      providerId: "groq",
      providerModelId: "llama",
      label: "Llama",
      access: "paid",
      api_key: "sk-secretvalue12",
      meta: { providerId: "groq", modelName: "llama", kind: "cloud", context: 8192 },
    });
    const next = store.envelope(
      "groq",
      [row],
      1_700_000_000_000,
      [{ id: "groq:llama", api_key: "sk-secretvalue12" }],
      [],
    );
    const committed = store.commitRecords(null, next);
    expect(committed.ok).toBe(true);
    const file = store.fileFor(dir, "groq");
    store.atomicWrite(file, committed.doc);
    const readBack = store.readEnvelope(file);
    expect(readBack.ok).toBe(true);
    expect(JSON.stringify(readBack.doc)).not.toMatch(/sk-secretvalue12/);
    const tampered = JSON.parse(fs.readFileSync(file, "utf8"));
    tampered.records[0].displayName = "changed";
    fs.writeFileSync(file, JSON.stringify(tampered));
    const bad = store.readEnvelope(file);
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe("checksum");
    const doctor = store.doctorCheck(dir, 1_700_000_000_000);
    expect(doctor.status).toBe("Warning");
    expect(doctor.detail).toContain("checksum");
  });

  it("plans a 24 hour refresh and never sends a prompt", () => {
    const day = 24 * 60 * 60 * 1000;
    expect(store.FRESH_MS).toBe(day);
    const fresh = store.planCatalogueRefresh({ trigger: "startup", ageMs: day - 1, jitterMs: 10 });
    expect(fresh.refresh).toBe(false);
    expect(fresh.sendsPrompt).toBe(false);
    const stale = store.planCatalogueRefresh({ trigger: "interval", ageMs: day, jitterMs: 90_000 });
    expect(stale.refresh).toBe(true);
    expect(stale.delayMs).toBeLessThan(60_000);
    const privacy = store.planCatalogueRefresh({
      trigger: "startup",
      ageMs: day * 3,
      privacy: true,
    });
    expect(privacy.refresh).toBe(false);
    expect(privacy.mark).toBe("stale");
    const manual = store.planCatalogueRefresh({ trigger: "manual", ageMs: 0 });
    expect(manual.refresh).toBe(true);
    expect(manual.delayMs).toBe(0);
    const missing = store.planCatalogueRefresh({
      trigger: "startup",
      ageMs: Number.POSITIVE_INFINITY,
      jitterMs: 5,
    });
    expect(missing.refresh).toBe(true);
    expect(store.freshness(1_000, 1_000 + day - 1, { privacy: true })).toBe("stale");
    expect(store.freshness(1_000, 1_000 + 1_000, {})).toBe("fresh");
    expect(store.retryDelay({ "retry-after": "2" }, 4, 0)).toBe(2_000);
    expect(store.retryDelay({}, 3, 0)).toBe(4_000);
    expect(store.conditionalHeaders({ etag: "abc" })["If-None-Match"]).toBe("abc");
  });

  it("records added, removed, price, and access changes", () => {
    const before = [
      store.canonicalFromRoutable({
        providerId: "openai",
        providerModelId: "gpt",
        label: "GPT",
        access: "paid",
        pricing: { inputPerMTok: 1, outputPerMTok: 2 },
        meta: { providerId: "openai", modelName: "gpt", context: 8 },
      }),
    ];
    const after = [
      store.canonicalFromRoutable({
        providerId: "openai",
        providerModelId: "gpt",
        label: "GPT",
        access: "unknown",
        pricing: { inputPerMTok: 3, outputPerMTok: 2 },
        meta: { providerId: "openai", modelName: "gpt", context: 16 },
      }),
      store.canonicalFromRoutable({
        providerId: "openai",
        providerModelId: "new",
        label: "New",
        meta: { providerId: "openai", modelName: "new" },
      }),
    ];
    const diff = store.diffCatalogues(before, after);
    expect(diff.added).toEqual(["openai/new"]);
    expect(diff.price).toEqual(["openai/gpt"]);
    expect(diff.limit).toEqual(["openai/gpt"]);
    expect(diff.access).toEqual(["openai/gpt"]);
    expect(store.changeLines(diff).join(" ")).toContain("added openai/new");
    expect(store.remapRemoved(["openai/old"], { old: "new" })[0]).toEqual({
      from: "openai/old",
      to: "new",
    });
  });
});

describe("protocol adapters and provider modules", () => {
  const registered = registry.ensureHandlers();

  it("keeps one module for every registered provider", () => {
    expect(registered.length).toBe(CLOUD_IDS.length + LOCAL_IDS.length);
    for (const id of [...CLOUD_IDS, ...LOCAL_IDS]) {
      const handler = handlers.getHandler(id);
      expect(handler.module, id).toBeTruthy();
      expect(handler.module.statusMatrix.liveVerified).toBe("no");
      expect(["documented", "unknown", "verified", "partial"]).toContain(
        handler.module.provenance.confidence,
      );
      expect(handlers.handlerContractErrors(handler)).toEqual([]);
    }
    const cloud = hubs.cloud.list().map((row: { id: string }) => row.id);
    const local = hubs.local.list().map((row: { id: string }) => row.id);
    expect(cloud).toEqual([...CLOUD_IDS]);
    expect(local).toEqual([...LOCAL_IDS, "huggingface-local"]);
  });

  it("parses a documented Gemini page pair without moving the chat URL", () => {
    const first = geminiProtocol.page({
      models: [
        { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
      ],
      nextPageToken: "page-2",
    });
    const second = geminiProtocol.page({ models: [{ name: "models/gemini-2.5-pro" }] });
    expect(first.models.map((row: { nativeId: string }) => row.nativeId)).toEqual([
      "gemini-2.5-flash",
    ]);
    expect(first.nextPageToken).toBe("page-2");
    expect(second.nextPageToken).toBeNull();
    expect(first.models[0].supportedActions).toEqual(["generateContent"]);
    const built = handlers
      .getHandler("gemini")
      .buildRequest({ model: "gemini-2.5-flash", messages: [] });
    expect(built.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
    expect(
      modelsApi.openaiChatUrl(modelsApi.CLOUD.gemini.chat, modelsApi.CLOUD.gemini.chatPath),
    ).toBe(built.url);
  });

  it("treats an OpenRouter :free id without a zero price as unknown and can deny data collection", () => {
    const handler = handlers.getHandler("openrouter");
    const bare = handler.classifyAccess({ modelId: "google/gemma-4-26b-a4b-it:free" });
    expect(bare.billingMode).toBe("UNKNOWN");
    const priced = handler.module.normaliseModel({
      id: "google/gemma-4-26b-a4b-it:free",
      name: "Gemma",
      context_length: 8192,
      pricing: { prompt: "0", completion: "0" },
    });
    expect(priced.pricing.inputPerMTok).toBe(0);
    expect(priced.limits.context).toBe(8192);
    const built = handler.buildRequest({
      model: "openrouter/free",
      messages: [{ role: "user", content: "hi" }],
      privacy: true,
      maxPrice: 0,
      apiKey: "sk-secretvalue12",
    });
    expect(built.body.provider.data_collection).toBe("deny");
    expect(built.body.provider.allow_fallbacks).toBe(false);
    expect(built.body.provider.max_price.prompt).toBe(0);
    expect(JSON.stringify(built)).not.toMatch(/sk-/);
    expect(handler.gate().mayTrain).toBe(true);
  });

  it("keeps an unknown OpenAI id off automatic routing", () => {
    const handler = handlers.getHandler("openai");
    const record = handler.classifyAccess({ modelId: "gpt-not-in-the-official-table" });
    expect(handler.module.autoRoute(record)).toBe(false);
    const row = handler.module.normaliseModel({
      id: "gpt-4.1",
      object: "model",
      owned_by: "system",
      created: 1,
    });
    expect(row.owner).toBe("system");
    expect(row.limits || null).toBeNull();
  });

  it("normalises Groq, NVIDIA, and Hugging Face rows from the documented list shape", () => {
    const groq = handlers.getHandler("groq").module.normaliseModel({
      id: "whisper-large-v3",
      owned_by: "openai",
      active: true,
      context_window: 448,
    });
    expect(groq.endpointKinds).toEqual(["audio-transcription"]);
    expect(groq.limits.context).toBe(448);
    expect(groq.replacement).toBeNull();
    const retired = handlers.getHandler("groq").module.normaliseModel({ id: "old", active: false });
    expect(retired.lifecycle).toBe("retired");
    const nvidia = handlers.getHandler("nvidia");
    expect(nvidia.module.provenance.sourceUrl).toBe("https://build.nvidia.com/llms.txt");
    expect(nvidia.module.normaliseModel({ id: "meta/llama" }).capabilities).toEqual({});
    expect(nvidia.gate().mayTrain).toBe(false);
    const hf = handlers.getHandler("huggingface");
    const normalised = hf.module.normaliseModel({
      id: "org/model",
      providers: [
        {
          status: "live",
          context_length: 4096,
          pricing: { input: 0, output: 0 },
          supports_tools: true,
        },
      ],
    });
    expect(normalised.pricing.inputPerMTok).toBe(0);
    expect(normalised.capabilities.tools.value).toBe(true);
    expect(hf.module.routeWithinProvider({ model: "org/model" }).model).toBe("org/model");
    expect(hf.module.routeWithinProvider({ model: "org/model", priceCeiling: 0 }).model).toBe(
      "org/model:cheapest",
    );
    expect(hf.module.routeWithinProvider({ model: "org/model", throughput: "fastest" }).model).toBe(
      "org/model:fastest",
    );
    expect(hf.module.routeWithinProvider({ model: "org/model", pin: "groq" }).model).toBe(
      "org/model:groq",
    );
  });

  it("keeps Ollama on the native chat path and LM Studio on the compatible path", () => {
    const ollama = handlers.getHandler("ollama").buildRequest({ model: "llama3.2", messages: [] });
    expect(ollama.url).toBe("http://127.0.0.1:11434/api/chat");
    expect(ollama.wire).toBe("ollama");
    const studio = handlers.getHandler("lmstudio").buildRequest({ model: "local", messages: [] });
    expect(studio.url).toBe("http://127.0.0.1:1234/v1/chat/completions");
    expect(handlers.getHandler("lmstudio").module.native.load).toBe("/api/v1/models/load");
    const parsed = protocols.parseStream("ollama", '{"message":{"content":"Hi"},"done":true}\n');
    expect(parsed.content).toBe("Hi");
  });

  it("does not add providers whose pages were not re-read", () => {
    const ids = coverage.notAdded().map((row: { id: string }) => row.id);
    expect(ids).toContain("github-models");
    expect(ids).toContain("cloudflare-workers-ai");
    expect(ids).toContain("ollama-cloud");
    for (const id of ids) expect(modelsApi.CLOUD[id]).toBeUndefined();
  });
});

describe("side routers and egress", () => {
  const cloud = (providerId: string, modelId: string, access: string) => ({
    id: `${providerId}:${modelId}`,
    type: "cloud" as const,
    contextK: 32,
    providerId,
    providerModelId: modelId,
    access,
    meta: { providerId, kind: "cloud", modelName: modelId, connected: true },
  });
  const local = {
    id: "ollama:llama3.2",
    type: "local" as const,
    contextK: 8,
    providerId: "ollama",
    access: "free",
    meta: {
      providerId: "ollama",
      kind: "local",
      modelName: "llama3.2",
      connected: true,
      resident: true,
    },
  };

  it("shares the decision trace between chat and voice", () => {
    const pool = [
      local,
      cloud("gemini", "gemini-2.5-flash", "free"),
      cloud("groq", "openai/gpt-oss-20b", "paid"),
    ];
    const chat = router.routeRequest(pool, {
      mode: "auto",
      policy: "free-preferred",
      surface: "chat",
    });
    const voice = router.routeRequest(pool, {
      mode: "auto",
      policy: "free-preferred",
      surface: "voice",
    });
    expect(chat.lane).toBe(voice.lane);
    expect(chat.decisionTrace.choice).toBe(voice.decisionTrace.choice);
    expect(chat.decisionTrace.lane).toBe(voice.decisionTrace.lane);
    expect(chat.decisionTrace.catalogueId).toContain("ollama/");
    expect(chat.candidates.includes("groq:openai/gpt-oss-20b")).toBe(false);
    expect(chat.surfaceHint).not.toBe(voice.surfaceHint);
  });

  it("blocks a non-loopback fetch while privacy egress is on", async () => {
    net.setEgressPolicy(() => ({ localOnly: true }));
    expect(net.egressDecision("https://example.com/v1/models").allow).toBe(false);
    expect(net.egressDecision("http://127.0.0.1:11434/api/tags").allow).toBe(true);
    await expect(net.fetchCompat("https://example.com/v1/models")).rejects.toMatchObject({
      code: "LOCAL_ONLY",
    });
  });
});

describe("hugging face local planner", () => {
  it("moves through pause and resume without running a file", () => {
    expect(hfLocal.nextState("discovered", "start")).toBe("downloading");
    expect(hfLocal.nextState("downloading", "pause")).toBe("paused");
    expect(hfLocal.nextState("paused", "resume")).toBe("downloading");
    expect(hfLocal.nextState("downloading", "complete")).toBe("installed");
    expect(hfLocal.nextState("installed", "load")).toBe("loaded");
    const plan = hfLocal.planInstall(
      {
        repo: "org/small",
        gated: false,
        files: ["small-Q4_K_M.gguf", "small-Q8_0.gguf"],
        label: "documented shape",
      },
      { runner: "ollama" },
    );
    expect(plan.ok).toBe(true);
    expect(plan.file).toBe("small-Q4_K_M.gguf");
    expect(plan.source.url).toBe("https://huggingface.co/org/small/resolve/main/small-Q4_K_M.gguf");
    expect(hfLocal.planInstall({ repo: "org/gated", gated: true, files: ["a.gguf"] }).ok).toBe(
      false,
    );
    expect(hfLocal.statusMatrix().liveVerified).toBe("no");
  });
});

describe("wiring", () => {
  it("keeps provider id branches out of the shared binders", () => {
    expect(read("electron/handlers/cloud-bind.cjs")).not.toMatch(/id === "/);
    expect(read("electron/handlers/local-bind.cjs")).not.toMatch(/id === "/);
    const main = read("electron/main.cjs");
    const refresh = main.slice(
      main.indexOf("function startModelRegistryRefresh"),
      main.indexOf("async function probeRoutableModels"),
    );
    expect(refresh).toContain("tickCooldowns");
    expect(refresh).not.toContain("refreshRoutable");
    expect(refresh).not.toContain("probeRoutableModels");
    expect(main).toContain('id: "catalogue-refresh"');
    expect(main).toContain('ipcMain.handle("models:catalogue-status"');
  });
});
