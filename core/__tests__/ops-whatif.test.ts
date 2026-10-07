/**
 * Ops what-if: historical routing and stored dependency edges — not a forecast.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { modelRegistry } from "../../src/lib/friday/brain/model-registry";
import { brainKnowledge } from "../../src/lib/friday/brain/knowledge-base";
import {
  whatIfDependencyChange,
  whatIfFromPrompt,
  whatIfRoute,
} from "../../src/lib/friday/brain/ops-whatif";

describe("ops what-if", () => {
  beforeEach(() => {
    brainKnowledge.resetForTests();
  });

  it("compares recorded model runs instead of inventing a forecast", () => {
    modelRegistry.recordRun({ modelId: "whatif-a", ok: true, ms: 400 });
    modelRegistry.recordRun({ modelId: "whatif-a", ok: true, ms: 500 });
    modelRegistry.recordRun({ modelId: "whatif-b", ok: false, ms: 900, error: "timeout" });
    const result = whatIfRoute("whatif-a", "whatif-b");
    expect(result.historical).toBe(true);
    expect(result.outcome).toMatch(/whatif-a: 2\/2 ok/);
    expect(result.outcome).toMatch(/whatif-b: 0\/1 ok/);
    expect(result.outcome).toMatch(/timeout/);
    expect(whatIfRoute("missing-x", "missing-y").inconclusive).toBe(true);
  });

  it("lists stored dependents and stays honest when none exist", () => {
    brainKnowledge.assertBelief({
      subject: "Component",
      predicate: "depends-on",
      object: "libfoo",
      source: "codebase",
      shape: "relation",
    });
    const hit = whatIfDependencyChange("libfoo");
    expect(hit.inconclusive).toBe(false);
    expect(hit.outcome).toMatch(/Component depends-on libfoo/);
    expect(whatIfDependencyChange("unknown-lib").inconclusive).toBe(true);
  });

  it("parses ops what-if prompts and ignores user-world prediction", () => {
    modelRegistry.recordRun({ modelId: "prov-a", ok: true, ms: 100 });
    modelRegistry.recordRun({ modelId: "prov-b", ok: true, ms: 200 });
    const parsed = whatIfFromPrompt("if I route to prov-b instead of prov-a");
    expect(parsed?.kind).toBe("route");
    expect(whatIfFromPrompt("what if the stock price doubles tomorrow")).toBeNull();
  });
});
