/**
 * FRIDAY · owner flow-chart conformance
 *
 * The owner's master chart is a contract, not a picture: every box must
 * resolve to a real, live module in this repository. No mocks are used —
 * `resolveFlow()` calls into the actual engines.
 */
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FLOW_CHART,
  SUPERVISOR_MANAGERS,
  flowGaps,
  flowNodes,
  resolveFlow,
} from "../../src/lib/friday/flow-chart";

const root = resolvePath(__dirname, "../..");

describe("owner flow chart", () => {
  it("covers every layer of the chart, top to bottom", () => {
    const order = FLOW_CHART.map((layer) => layer.order);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(FLOW_CHART.map((l) => l.id)).size).toBe(FLOW_CHART.length);
    for (const id of [
      "owner",
      "entry",
      "experience",
      "supervisor",
      "voice-runtime",
      "thinking",
      "task-runtime",
      "orchestrator",
      "model-router",
      "agents",
      "capability-bus",
      "permission",
      "execution",
      "verification",
      "memory",
      "idle",
      "improvement",
    ]) {
      expect(FLOW_CHART.some((layer) => layer.id === id)).toBe(true);
    }
  });

  it("names all ten supervisor managers exactly once", () => {
    expect(SUPERVISOR_MANAGERS).toHaveLength(10);
    for (const label of [
      "Session manager",
      "Task manager",
      "Conversation manager",
      "Priority manager",
      "Resource manager",
      "Model manager",
      "Agent manager",
      "Background job manager",
      "Interrupt manager",
      "Approval manager",
    ]) {
      expect(SUPERVISOR_MANAGERS.filter((m) => m.label === label)).toHaveLength(1);
    }
  });

  it("points every box at a file that exists in this repository", () => {
    for (const item of flowNodes()) {
      expect(existsSync(resolvePath(root, item.module)), `${item.id} → ${item.module}`).toBe(true);
    }
  });

  it("keeps node ids unique and stable", () => {
    const ids = flowNodes().map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("resolves every box against the live modules — no gaps", () => {
    const checks = resolveFlow();
    expect(checks.length).toBe(flowNodes().length);
    expect(flowGaps()).toEqual([]);
    expect(checks.every((check) => check.ok)).toBe(true);
  });

  it("includes billing and tool-authority on the permission layer", () => {
    const permission = FLOW_CHART.find((layer) => layer.id === "permission");
    expect(permission?.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        "permission.broker",
        "permission.privacy",
        "permission.governance",
        "permission.billing",
        "permission.authority",
      ]),
    );
    expect(flowNodes().find((node) => node.id === "permission.billing")?.module).toBe(
      "kernel/router.py",
    );
    expect(flowNodes().find((node) => node.id === "permission.authority")?.module).toBe(
      "electron/tool-authority.cjs",
    );
  });
});
