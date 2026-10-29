import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildCompanionLive,
  companionLiveLine,
  reconcileCompanionCursor,
} from "../../src/lib/friday/companion-live";

describe("companion live snapshot", () => {
  it("omits high-frequency voice fields and summarises coarse facts", () => {
    const live = buildCompanionLive({
      voice: "LISTENING",
      listening: true,
      error: false,
      doctorProblems: 1,
      doctorWarnings: 2,
      doctorScanning: false,
      connectors: [{ id: "slack", name: "Slack", connected: true }],
      cloud: ["openai"],
    });
    expect(live).not.toHaveProperty("interim");
    expect(live).not.toHaveProperty("vad");
    expect(companionLiveLine(live)).toContain("listening");
    expect(companionLiveLine(live)).toContain("1 issue");
    expect(companionLiveLine(live)).toContain("Slack");
    expect(companionLiveLine(live)).toContain("openai");
  });

  it("carries route mode, cost policy and the owner pick list", () => {
    const live = buildCompanionLive({
      voice: "OFF",
      listening: false,
      error: false,
      doctorProblems: 0,
      doctorWarnings: 0,
      doctorScanning: false,
      connectors: [],
      cloud: [],
      routeMode: "local-only",
      policy: "paid-only",
      selected: ["ollama:llama3.1"],
      coolingModelIds: ["ollama:qwen2.5", "ollama:qwen2.5"],
    });
    expect(live.routeMode).toBe("local-only");
    expect(live.policy).toBe("paid-only");
    expect(live.selected).toEqual(["ollama:llama3.1"]);
    expect(live.coolingModelIds).toEqual(["ollama:qwen2.5"]);
    expect(companionLiveLine(live)).toContain("route: local-only");
    expect(companionLiveLine(live)).toContain("cost: paid-only");
    expect(companionLiveLine(live)).toContain("ollama:llama3.1");
  });

  it("says healthy when doctor found nothing", () => {
    const live = buildCompanionLive({
      voice: "OFF",
      listening: false,
      error: false,
      doctorProblems: 0,
      doctorWarnings: 0,
      doctorScanning: false,
      connectors: [],
      cloud: [],
    });
    expect(companionLiveLine(live)).toBe("healthy");
    expect(live.work).toBeUndefined();
    expect(live.desk).toBeUndefined();
  });

  it("appends an optional desk line without inventing one", () => {
    const live = buildCompanionLive({
      voice: "OFF",
      listening: false,
      error: false,
      doctorProblems: 0,
      doctorWarnings: 0,
      doctorScanning: false,
      connectors: [],
      cloud: [],
      desk: "library 3 (1 pin) · project Labour app hands-off",
    });
    expect(companionLiveLine(live)).toContain("library 3 (1 pin)");
    expect(companionLiveLine(live)).toContain("project Labour app hands-off");
  });

  it("carries in-flight work without a clock field", () => {
    const live = buildCompanionLive({
      voice: "OFF",
      listening: false,
      error: false,
      doctorProblems: 0,
      doctorWarnings: 0,
      doctorScanning: false,
      connectors: [],
      cloud: [],
      workGoal: "prepare the billing report",
      workStep: "Execute",
      workStatus: "running",
      workTool: "http.fetch",
    });
    expect(live.work).toEqual({
      goal: "prepare the billing report",
      step: "Execute",
      status: "running",
      tool: "http.fetch",
    });
    expect(companionLiveLine(live)).toContain("Execute");
    expect(JSON.stringify(live)).not.toMatch(/"at":/);
  });

  it("carries a real Tailscale probe and never invents an off-LAN URL", () => {
    const live = buildCompanionLive({
      voice: "OFF",
      listening: false,
      error: false,
      doctorProblems: 0,
      doctorWarnings: 0,
      doctorScanning: false,
      connectors: [],
      cloud: [],
      remote: {
        enabled: true,
        available: false,
        backend: "none",
        url: null,
        detail: "Tailscale is not installed.",
      },
    });
    expect(live.remote?.url).toBeNull();
    expect(live.remote?.enabled).toBe(true);
    expect(companionLiveLine(live)).toContain("off-LAN: not ready");
    expect(companionLiveLine(live)).not.toMatch(/connected/i);
    expect(live.line).toBe(companionLiveLine(live));
    const ready = buildCompanionLive({
      voice: "OFF",
      listening: false,
      error: false,
      doctorProblems: 0,
      doctorWarnings: 0,
      doctorScanning: false,
      connectors: [],
      cloud: [],
      remote: {
        enabled: true,
        available: true,
        backend: "tailscale",
        url: "http://friday.tailnet.ts.net:8080/companion",
        detail: "Reachable only from devices signed into your own Tailscale account.",
      },
    });
    expect(ready.remote?.url).toContain("/companion");
    expect(companionLiveLine(ready)).toContain("off-LAN ready");
    expect(
      buildCompanionLive({
        voice: "OFF",
        listening: false,
        error: false,
        doctorProblems: 0,
        doctorWarnings: 0,
        doctorScanning: false,
        connectors: [],
        cloud: [],
      }).remote,
    ).toBeUndefined();
  });

  it("publishes the subtitle and desktop mode so the phone cannot keep a second copy", () => {
    const live = buildCompanionLive({
      voice: "OFF",
      listening: false,
      error: false,
      doctorProblems: 0,
      doctorWarnings: 0,
      doctorScanning: false,
      connectors: [],
      cloud: [],
      mode: "auto",
    });
    expect(live.mode).toBe("auto");
    expect(live.line).toBe("auto · healthy");
    expect(live.line).toBe(companionLiveLine(live));
  });

  it("blocks a phone write when the cursor gap or the outcome is unknown", () => {
    const gap = buildCompanionLive({
      voice: "OFF",
      listening: false,
      error: false,
      doctorProblems: 0,
      doctorWarnings: 0,
      doctorScanning: false,
      connectors: [],
      cloud: [],
      lastCursor: 4,
      nextCursor: 7,
    });
    expect(gap.sync).toEqual({ phase: "snapshot", mutate: false });
    expect(gap.line).toContain("refreshing");

    const unknown = reconcileCompanionCursor({
      lastCursor: 4,
      nextCursor: 4,
      durableMissed: false,
      outcomeKnown: false,
    });
    expect(unknown.phase).toBe("stale");
    expect(unknown.mutate).toBe(false);

    const current = buildCompanionLive({
      voice: "OFF",
      listening: false,
      error: false,
      doctorProblems: 0,
      doctorWarnings: 0,
      doctorScanning: false,
      connectors: [],
      cloud: [],
      lastCursor: 4,
      nextCursor: 4,
    });
    expect(current.sync).toBeUndefined();
    expect(current.line).toBe("healthy");
  });

  it("publishes live model cooldowns from the authoritative usage registry", () => {
    const shell = readFileSync(
      resolve(process.cwd(), "src/components/friday/AppShell.tsx"),
      "utf8",
    );
    expect(shell).toContain("coolingModelIds: usage.models");
    expect(shell).toContain(".filter((model) => model.coolingDown)");
  });
});
