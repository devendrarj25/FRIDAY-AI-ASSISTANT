/**
 * A spoken turn starts the live web search together with the capability routers and both share one 1.5 s
 * deadline. Fake timers prove the wall time: sequential would be the web deadline plus the router deadline.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const never = () => new Promise<never>(() => undefined);

vi.mock("../../src/lib/friday/brain/skill-router", async (original) => ({
  ...(await original<typeof import("../../src/lib/friday/brain/skill-router")>()),
  routeSkills: vi.fn(() => never()),
}));
vi.mock("../../src/lib/friday/brain/tool-router", async (original) => ({
  ...(await original<typeof import("../../src/lib/friday/brain/tool-router")>()),
  routeTools: vi.fn(() => never()),
}));
vi.mock("../../src/lib/friday/brain/agent-router", async (original) => ({
  ...(await original<typeof import("../../src/lib/friday/brain/agent-router")>()),
  routeAgents: vi.fn(async () => []),
}));
vi.mock("../../src/lib/friday/brain/module-router", async (original) => ({
  ...(await original<typeof import("../../src/lib/friday/brain/module-router")>()),
  routeModules: vi.fn(async () => []),
}));
vi.mock("../../src/lib/friday/brain/connector-router", async (original) => ({
  ...(await original<typeof import("../../src/lib/friday/brain/connector-router")>()),
  routeConnectors: vi.fn(async () => []),
}));
vi.mock("../../src/lib/friday/brain/workflow-router", async (original) => ({
  ...(await original<typeof import("../../src/lib/friday/brain/workflow-router")>()),
  routeWorkflows: vi.fn(async () => []),
}));
vi.mock("../../src/lib/friday/browser-engine", async (original) => ({
  ...(await original<typeof import("../../src/lib/friday/browser-engine")>()),
  browserAvailable: () => true,
  webSearch: vi.fn(() => never()),
}));

const { coreBrain, VOICE_ROUTER_DEADLINE_MS, VOICE_WEB_DEADLINE_MS } =
  await import("../../src/lib/friday/brain/core-brain");
const { vectorIndex } = await import("../../src/lib/friday/brain/vector-index");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a spoken turn's web search runs with the routers", () => {
  it("uses the router deadline for the web", () => {
    expect(VOICE_WEB_DEADLINE_MS).toBe(VOICE_ROUTER_DEADLINE_MS);
  });

  it("finishes within one shared deadline when the web and a router both hang", async () => {
    vi.spyOn(vectorIndex, "queryHits").mockResolvedValue([]);
    vi.useFakeTimers();
    const t0 = Date.now();
    let done = false;
    const turn = coreBrain
      .cognize("aaj ki latest news kya hai", { mode: "auto", surface: "voice" })
      .then((value) => {
        done = true;
        return value;
      });
    await vi.advanceTimersByTimeAsync(VOICE_ROUTER_DEADLINE_MS + 200);
    expect(done).toBe(true);
    const cognition = await turn;
    expect(Date.now() - t0).toBeLessThan(VOICE_ROUTER_DEADLINE_MS + 250);
    expect(cognition.tools.some((tool) => tool.tool === "web-search" && !tool.ok)).toBe(true);
  });
});
