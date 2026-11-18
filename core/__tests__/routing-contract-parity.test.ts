/**
 * The routing contract exists twice on purpose: `src/lib/friday/model-routing-contract.ts` (the renderer's
 * authoritative copy) and `electron/model-router.cjs` (the main process's mirror, which does the routing).
 * A mode added to one and not the other would be silently replaced by a default on the other side, so a request
 * the owner chose would run as something else. The 2026-11-18 audit found the lists equal but pinned by nothing.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  COST_POLICIES,
  QUALITY_TARGETS,
  ROUTE_MODES,
  ROUTE_STRATEGIES,
  ROUTING_TASKS,
  createRoutingContract,
  validateRoutingContract,
} from "../../src/lib/friday/model-routing-contract";

const require = createRequire(import.meta.url);
const router = require("../../electron/model-router.cjs") as Record<string, unknown> & {
  createRoutingContract: (partial?: Record<string, unknown>) => Record<string, unknown>;
};

describe("the renderer contract and the main-process mirror list the same values, in the same order", () => {
  const pairs: [string, readonly string[], string][] = [
    ["route modes", ROUTE_MODES, "ROUTE_MODES"],
    ["cost policies", COST_POLICIES, "COST_MODES"],
    ["quality targets", QUALITY_TARGETS, "QUALITY_TARGETS"],
    ["strategies", ROUTE_STRATEGIES, "ROUTE_STRATEGIES"],
    ["tasks", ROUTING_TASKS, "ROUTING_TASKS"],
  ];
  for (const [label, renderer, exported] of pairs) {
    it(label, () => {
      expect(router[exported], `${exported} is exported by model-router.cjs`).toBeDefined();
      expect([...(router[exported] as string[])]).toEqual([...renderer]);
    });
  }
});

describe("every value the renderer can send survives the main process unchanged", () => {
  it("a mode, quality target, strategy and cost policy round-trip through the mirror's own contract", () => {
    for (const routeMode of ROUTE_MODES) {
      const made = router.createRoutingContract({ routeMode });
      expect(made["routeMode"], routeMode).toBe(routeMode);
    }
    for (const qualityTarget of QUALITY_TARGETS) {
      expect(router.createRoutingContract({ qualityTarget })["qualityTarget"], qualityTarget).toBe(
        qualityTarget,
      );
    }
    for (const strategy of ROUTE_STRATEGIES) {
      expect(router.createRoutingContract({ strategy })["strategy"], strategy).toBe(strategy);
    }
    for (const costPolicy of COST_POLICIES) {
      expect(router.createRoutingContract({ costPolicy })["costPolicy"], costPolicy).toBe(
        costPolicy,
      );
    }
  });

  it("a contract the renderer builds from each mode is valid, and an unknown value falls back to the default", () => {
    for (const routeMode of ROUTE_MODES) {
      expect(validateRoutingContract(createRoutingContract({ routeMode })).ok, routeMode).toBe(
        true,
      );
    }
    expect(router.createRoutingContract({ routeMode: "something-new" })["routeMode"]).toBe("auto");
  });
});
