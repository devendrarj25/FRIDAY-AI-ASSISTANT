/**
 * Gemini, Groq, OpenRouter and NVIDIA connected end to end against a fake
 * network: key accepted, models listed, each model classified from the
 * provider's own evidence, only chat models offered, and the router restricted
 * to one provider or one model when asked. No real key and no real request.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pinKnowledgeClock } from "./helpers/knowledge-clock";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const models = require_(path.join(root, "electron/models.cjs"));
const router = require_(path.join(root, "electron/model-router.cjs"));
const undici = require_("undici");

pinKnowledgeClock();

type Call = { method: string; url: string; auth: string | null; body: string | null };
const json = (body: unknown, status = 200) => ({
  ok: status < 400,
  status,
  headers: new Headers({ "content-type": "application/json" }),
  text: async () => JSON.stringify(body),
  json: async () => body,
});

let calls: Call[] = [];
let reject: Record<string, number> = {};
const realFetch = undici.fetch;
let dir = "";

const fake = async (
  url: unknown,
  init: { headers?: Record<string, string>; method?: string; body?: unknown } = {},
) => {
  const u = String(url);
  const headers = init.headers ?? {};
  calls.push({
    method: String(init.method ?? "GET"),
    url: u,
    auth: headers["Authorization"] ?? headers["authorization"] ?? null,
    body: typeof init.body === "string" ? init.body : null,
  });
  const host = new URL(u).hostname;
  if (reject[host]) return json({ error: { message: "Invalid API key" } }, reject[host]);
  if (u.startsWith("https://generativelanguage.googleapis.com/v1beta/openai/models"))
    return json({ data: [{ id: "models/gemini-2.5-flash" }, { id: "models/text-embedding-004" }] });
  if (u.startsWith("https://api.groq.com/openai/v1/models"))
    return json({
      data: [
        { id: "llama-3.3-70b-versatile", active: true },
        { id: "whisper-large-v3", active: true },
      ],
    });
  if (u === "https://openrouter.ai/api/v1/key") return json({ data: { label: "k" } });
  if (u.startsWith("https://openrouter.ai/api/v1/models"))
    return json({
      data: [
        { id: "meta-llama/llama-3.3-70b-instruct:free", pricing: { prompt: "0", completion: "0" } },
        { id: "openai/gpt-4o", pricing: { prompt: "0.0000025", completion: "0.00001" } },
        {
          id: "some/zero-with-request",
          pricing: { prompt: "0", completion: "0", request: "0.01" },
        },
      ],
    });
  if (u.startsWith("https://integrate.api.nvidia.com/v1/models"))
    return json({ data: [{ id: "meta/llama-3.1-8b-instruct" }] });
  if (u.startsWith("https://integrate.api.nvidia.com/v1/chat/completions"))
    return json({ choices: [{ message: { content: "ok" } }] });
  return json({ error: { message: "unreachable in this test" } }, 503);
};

beforeAll(() => {
  undici.fetch = fake;
  dir = mkdtempSync(path.join(tmpdir(), "friday-four-"));
  for (const id of ["gemini", "groq", "openrouter", "nvidia"])
    models.writeKey(dir, id, `key-${id}`);
});
afterAll(() => {
  undici.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

const find = (rows: { id: string }[], id: string) => rows.find((row) => row.id === id);

describe("connect, list and classify", () => {
  it("connects all four with the header each provider documents", async () => {
    calls = [];
    const inventory = await models.inventory({ userData: dir, workspace: dir });
    for (const id of ["gemini", "groq", "openrouter", "nvidia"]) {
      const provider = inventory.providers.find((p: { id: string }) => p.id === id);
      expect(provider.online, `${id}: ${provider.error}`).toBe(true);
      expect(provider.models.length, id).toBeGreaterThan(0);
    }
    const lists = calls.filter(
      (c) => /\/models/.test(c.url) && c.method === "GET" && !c.url.includes("127.0.0.1"),
    );
    expect(lists.length).toBeGreaterThanOrEqual(4);
    for (const call of lists) expect(call.auth, call.url).toMatch(/^Bearer key-/);
    // OpenRouter's key is proved on its own key endpoint, NVIDIA's with one chat token.
    expect(calls.some((c) => c.url === "https://openrouter.ai/api/v1/key")).toBe(true);
    const chat = calls.find((c) => c.url.endsWith("/v1/chat/completions"));
    expect(chat?.method).toBe("POST");
    expect(JSON.parse(chat!.body!).max_tokens).toBeLessThanOrEqual(8);
    // Gemini lists from the OpenAI-compatible base and strips `models/`.
    const gemini = inventory.providers.find((p: { id: string }) => p.id === "gemini");
    expect(gemini.models.map((m: { id: string }) => m.id)).toContain("gemini-2.5-flash");
  });

  it("classifies from each provider's own evidence and offers chat models only", async () => {
    const { models: routable } = await models.routable({ userData: dir, workspace: dir });
    const free = router.usableModels(routable, {
      policy: "free-preferred",
      health: new router.ProviderHealthManager(),
      now: Date.now(),
      task: "chat",
    });
    const state = (id: string) => {
      const row = find(
        free.rows.map((r: { model: { id: string } }) => ({ id: r.model.id, row: r })),
        id,
      ) as unknown as { row: { visibility: string; reason: string | null; model: unknown } };
      return { access: router.classifyAccess(row.row.model), ...row.row };
    };
    expect(state("gemini:gemini-2.5-flash")).toMatchObject({ access: "free", visibility: "show" });
    expect(state("nvidia:meta/llama-3.1-8b-instruct")).toMatchObject({
      access: "free",
      visibility: "show",
    });
    expect(state("openrouter:meta-llama/llama-3.3-70b-instruct:free")).toMatchObject({
      access: "free",
      visibility: "show",
    });
    expect(state("openrouter:openrouter/free")).toMatchObject({
      access: "free",
      visibility: "show",
    });
    // Priced, even with a zero token price, is paid and stays out until paid access is on.
    expect(state("openrouter:openai/gpt-4o")).toMatchObject({ access: "paid", reason: "paid-off" });
    expect(state("openrouter:some/zero-with-request")).toMatchObject({ access: "paid" });
    // Groq publishes no free list: unknown cost stays hidden until the owner says free.
    expect(state("groq:llama-3.3-70b-versatile")).toMatchObject({
      access: "unknown",
      visibility: "hide",
    });
    // A model's kind is named before its price, and "turn paid on" is not offered for it.
    expect(state("gemini:text-embedding-004").reason).toBe("flagged embedding-only");
    expect(state("groq:whisper-large-v3").reason).toBe("flagged speech-only");
    expect(free.hint).toContain("3 more models hidden");
  });

  it("with paid access on, unknown and paid chat models appear and non-chat ones still do not", async () => {
    const { models: routable } = await models.routable({ userData: dir, workspace: dir });
    const view = router.usableModels(routable, {
      policy: "allow-paid",
      health: new router.ProviderHealthManager(),
      now: Date.now(),
      task: "chat",
    });
    const shown = view.rows
      .filter((r: { visibility: string }) => r.visibility === "show")
      .map((r: { model: { id: string } }) => r.model.id);
    expect(shown).toContain("groq:llama-3.3-70b-versatile");
    expect(shown).toContain("openrouter:openai/gpt-4o");
    expect(shown).not.toContain("groq:whisper-large-v3");
    expect(shown).not.toContain("gemini:text-embedding-004");
  });
});

describe("a rejected key is said plainly", () => {
  it("reports the provider's own reason and offers nothing from it", async () => {
    reject = { "api.groq.com": 401 };
    models.invalidateProviderCache?.("groq");
    const result = await models.testProvider("groq", { userData: dir });
    expect(result.online).toBe(false);
    expect(String(result.error)).toMatch(/401|rejected|Invalid API key/i);
    reject = {};
    models.invalidateProviderCache?.("groq");
  });
});

describe("asking for one provider or one model", () => {
  it("keeps the route inside the named provider, and inside the named model when pinned", async () => {
    const { models: routable } = await models.routable({ userData: dir, workspace: dir });
    const base = {
      task: "chat",
      policy: "allow-paid",
      paidEnabled: true,
      firewallAllowsPaid: true,
      mode: "auto",
      health: new router.ProviderHealthManager(),
      now: Date.now(),
      limit: 6,
    };
    const groq = router.routeRequest(routable, { ...base, selectedProviderIds: ["groq"] });
    expect(groq.models.length).toBeGreaterThan(0);
    for (const m of groq.models) expect(m.providerId ?? m.meta?.providerId).toBe("groq");
    const gemini = router.routeRequest(routable, { ...base, selectedProviderIds: ["gemini"] });
    expect(gemini.models.map((m: { id: string }) => m.id)).toEqual(["gemini:gemini-2.5-flash"]);
    const pinned = router.routeRequest(routable, {
      ...base,
      mode: "manual",
      preferred: ["nvidia:meta/llama-3.1-8b-instruct"],
    });
    expect(pinned.models[0].id).toBe("nvidia:meta/llama-3.1-8b-instruct");
  });

  it("a named provider with unproven cost needs paid access, and says so when it has none", async () => {
    const { models: routable } = await models.routable({ userData: dir, workspace: dir });
    const common = {
      task: "chat",
      mode: "auto",
      health: new router.ProviderHealthManager(),
      now: Date.now(),
      selectedProviderIds: ["groq"],
    };
    const off = router.routeRequest(routable, { ...common, policy: "free-preferred" });
    expect(off.models).toEqual([]);
    const why = router.explainUnavailable({
      mode: "auto",
      policy: "free-preferred",
      providers: ["groq"],
      unlocked: false,
    });
    expect(why).toMatch(/asked for groq only/i);
    expect(why).toMatch(/paid access/i);
    const on = router.routeRequest(routable, {
      ...common,
      policy: "allow-paid",
      paidEnabled: true,
      firewallAllowsPaid: true,
    });
    expect(on.models.map((m: { id: string }) => m.id)).toEqual(["groq:llama-3.3-70b-versatile"]);
  });

  it("a named paid model is still refused while paid access is off", async () => {
    const { models: routable } = await models.routable({ userData: dir, workspace: dir });
    const refused = router.routeRequest(routable, {
      task: "chat",
      policy: "free-preferred",
      mode: "manual",
      preferred: ["openrouter:openai/gpt-4o"],
      health: new router.ProviderHealthManager(),
      now: Date.now(),
    });
    expect(refused.models.map((m: { id: string }) => m.id)).not.toContain(
      "openrouter:openai/gpt-4o",
    );
  });
});
