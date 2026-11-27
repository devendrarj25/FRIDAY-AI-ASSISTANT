/**
 * Real budgets for a spoken turn: the vector recall is raced against a short timer and skips the judge, the
 * routers run together under one deadline, web search is bounded, the kernel bridge can time a call out, and the
 * renderer watchdog is surface-aware and longer than the attempts it waits for.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const never = () => new Promise<never>(() => undefined);
const slow = <T>(ms: number, value: T) =>
  new Promise<T>((done) => setTimeout(() => done(value), ms));

vi.mock("../../src/lib/friday/brain/skill-router", async (original) => ({
  ...(await original<typeof import("../../src/lib/friday/brain/skill-router")>()),
  routeSkills: vi.fn(async () => slow(500, [])),
}));
vi.mock("../../src/lib/friday/brain/agent-router", async (original) => ({
  ...(await original<typeof import("../../src/lib/friday/brain/agent-router")>()),
  routeAgents: vi.fn(async () => slow(500, [])),
}));
vi.mock("../../src/lib/friday/brain/tool-router", async (original) => ({
  ...(await original<typeof import("../../src/lib/friday/brain/tool-router")>()),
  routeTools: vi.fn(async () => slow(500, [])),
}));
vi.mock("../../src/lib/friday/brain/module-router", async (original) => ({
  ...(await original<typeof import("../../src/lib/friday/brain/module-router")>()),
  routeModules: vi.fn(async () => slow(500, [])),
}));
vi.mock("../../src/lib/friday/brain/connector-router", async (original) => ({
  ...(await original<typeof import("../../src/lib/friday/brain/connector-router")>()),
  routeConnectors: vi.fn(async () => slow(500, [])),
}));
vi.mock("../../src/lib/friday/brain/workflow-router", async (original) => ({
  ...(await original<typeof import("../../src/lib/friday/brain/workflow-router")>()),
  routeWorkflows: vi.fn(async () => never()),
}));
vi.mock("../../src/lib/friday/browser-engine", async (original) => ({
  ...(await original<typeof import("../../src/lib/friday/browser-engine")>()),
  browserAvailable: () => true,
  webSearch: vi.fn(() => never()),
}));

const { coreBrain, VOICE_VECTOR_DEADLINE_MS, VOICE_ROUTER_DEADLINE_MS, VOICE_WEB_DEADLINE_MS } =
  await import("../../src/lib/friday/brain/core-brain");
const { vectorIndex } = await import("../../src/lib/friday/brain/vector-index");
const { watchdogMs } = await import("../../src/lib/friday/brain-engine");
const { KernelBridge } = await import("../../src/lib/friday/bridge");

afterEach(() => vi.restoreAllMocks());

describe("a spoken turn's recall", () => {
  it("is raced against a short timer, skips the judge, and carries on without the vector hits", async () => {
    const query = vi.spyOn(vectorIndex, "queryHits").mockImplementation(() => never());
    const t0 = Date.now();
    const cognition = await coreBrain.cognize("tum kaisi ho", {
      mode: "auto",
      surface: "voice",
      allowTools: false,
    });
    const wall = Date.now() - t0;
    expect(query).toHaveBeenCalledWith("tum kaisi ho", 8, "none");
    expect(wall).toBeLessThan(VOICE_VECTOR_DEADLINE_MS + 1500);
    expect(cognition.system.length).toBeGreaterThan(100);
  });

  it("keeps the full rerank for typed chat", async () => {
    const query = vi.spyOn(vectorIndex, "queryHits").mockResolvedValue([]);
    await coreBrain.cognize("tum kaisi ho", { mode: "manual", surface: "chat", allowTools: false });
    expect(query).toHaveBeenCalledWith("tum kaisi ho", 8);
  });
});

describe("a spoken turn's routers and web search", () => {
  it("run together under one deadline, even when one router never answers", async () => {
    vi.spyOn(vectorIndex, "queryHits").mockResolvedValue([]);
    const t0 = Date.now();
    await coreBrain.cognize("kal ka kaam batao", { mode: "auto", surface: "voice" });
    const wall = Date.now() - t0;
    // Serial this would be 6 x 500 ms and one hang; together it is the deadline.
    expect(wall).toBeGreaterThanOrEqual(400);
    expect(wall).toBeLessThan(VOICE_ROUTER_DEADLINE_MS + 1200);
  });

  it("bounds a web search that never returns and does not retry it", async () => {
    vi.spyOn(vectorIndex, "queryHits").mockResolvedValue([]);
    const { webSearch } = await import("../../src/lib/friday/browser-engine");
    const spy = vi.mocked(webSearch);
    spy.mockClear();
    const t0 = Date.now();
    const cognition = await coreBrain.cognize("aaj ki latest news kya hai", {
      mode: "auto",
      surface: "voice",
    });
    const wall = Date.now() - t0;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(wall).toBeLessThan(VOICE_WEB_DEADLINE_MS + VOICE_ROUTER_DEADLINE_MS + 1500);
    expect(cognition.tools.some((tool) => tool.tool === "web-search" && !tool.ok)).toBe(true);
  }, 15_000);
});

describe("the renderer watchdog", () => {
  it("is longer than the attempts it waits for and surface-aware", () => {
    expect(watchdogMs("voice", "stream")).toBeLessThan(watchdogMs("chat", "stream"));
    // Three candidates with about 20 s to a first word each.
    expect(watchdogMs("voice", "stream")).toBeGreaterThan(3 * 20_000);
    // The main process gives up on silence at 150 s.
    expect(watchdogMs("chat", "stream")).toBeGreaterThan(150_000);
    expect(watchdogMs("voice", "turn-start")).toBeLessThan(watchdogMs("voice", "stream"));
  });

  it("is armed when a turn starts and again after the request, and withinBudget gets elapsed time", () => {
    const source = readFileSync(resolve(__dirname, "../../src/lib/friday/brain-engine.ts"), "utf8");
    expect(source).toMatch(/armWatchdog\(watchdogMs\(surface, "turn-start"\)\)/);
    expect(source).not.toMatch(/withinBudget\(budget\.ms, surface\)/);
    expect(source).not.toMatch(/withinBudget\(0, surface\)/);
    expect(source).toMatch(/withinBudget\(Date\.now\(\) - turnStartedAt, surface\)/);
  });
});

describe("KernelBridge.call timeout", () => {
  const connected = () => {
    const bridge = new KernelBridge();
    const sent: string[] = [];
    (bridge as unknown as { socket: unknown }).socket = { send: (data: string) => sent.push(data) };
    return { bridge, sent };
  };

  it("rejects a call that has no answer in time and forgets it", async () => {
    vi.useFakeTimers();
    const { bridge } = connected();
    const pending = (bridge as unknown as { pending: Map<number, unknown> }).pending;
    const call = bridge.call("memory.search", { query: "x" }, { timeoutMs: 250 });
    const caught = call.catch((error: Error) => error.message);
    expect(pending.size).toBe(1);
    await vi.advanceTimersByTimeAsync(251);
    expect(await caught).toMatch(/timed out/);
    expect(pending.size).toBe(0);
    vi.useRealTimers();
  });

  it("has no timeout unless asked for one", async () => {
    vi.useFakeTimers();
    const { bridge } = connected();
    const settled = vi.fn();
    bridge.call("memory.search").then(settled, settled);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(settled).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("clears the timer when the answer arrives", async () => {
    vi.useFakeTimers();
    const { bridge } = connected();
    const call = bridge.call("memory.search", {}, { timeoutMs: 250 });
    (bridge as unknown as { pending: Map<number, { resolve: (v: unknown) => void }> }).pending
      .get(1)!
      .resolve({ ok: true });
    await expect(call).resolves.toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
