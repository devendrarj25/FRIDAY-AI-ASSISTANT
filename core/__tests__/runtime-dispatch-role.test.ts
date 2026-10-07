/**
 * Chat runtime routes through dispatchRole first and only fans
 * modelRegistry.available() when that path has no candidates.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { prepareTurn, refineTurnWithDispatchRole } from "../../src/lib/friday/runtime";
import { coreBrain } from "../../src/lib/friday/brain/core-brain";

describe("chat runtime uses dispatchRole", () => {
  it("does not append every available model until the smart path is empty", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/lib/friday/runtime.ts"), "utf8");
    expect(source).toContain("dispatchRole");
    expect(source).toContain("if (!ids.length)");
    expect(source).toMatch(/Safety net only/);
  });

  it("records the dispatchRole path on a real cognize turn", async () => {
    const stages: string[] = [];
    const cognition = await coreBrain.cognize("write a haiku about rain", {
      mode: "manual",
      allowTools: false,
      onStage: (nodeId, detail) => stages.push(`${nodeId}::${detail}`),
    });
    expect(cognition.routing).toMatch(/dispatchRole/);
    expect(stages.some((line) => /dispatchRole/.test(line))).toBe(true);
  });

  it("keeps prepareTurn's empty-pool note when dispatchRole has no seed", async () => {
    const prepared = prepareTurn("hello there", { mode: "auto", multiModel: false });
    const refined = await refineTurnWithDispatchRole("hello there", prepared);
    expect(refined.routing).toMatch(/dispatchRole/);
    expect(refined.modelIds).toEqual(prepared.modelIds);
  });
});
