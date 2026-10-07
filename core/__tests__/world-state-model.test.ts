/**
 * World / state model: live facts from existing registries, with per-domain TTL.
 */
import { describe, expect, it } from "vitest";

import {
  factFreshness,
  readWorldState,
  WORLD_TTL_MS,
} from "../../src/lib/friday/brain/world-model";

describe("world state model", () => {
  it("reads owner, models, capabilities, approvals and risks from existing sources", () => {
    const world = readWorldState();
    const owner = world.facts.find((fact) => fact.domain === "owner");
    const models = world.facts.find((fact) => fact.domain === "models");
    const capabilities = world.facts.find((fact) => fact.domain === "capabilities");
    const devices = world.facts.find((fact) => fact.domain === "devices");
    const approvals = world.facts.find((fact) => fact.domain === "approvals");
    const risks = world.facts.find((fact) => fact.domain === "risks");
    expect(owner?.value).toMatch(/FRIDAY/);
    expect(owner?.source).toMatch(/identity/);
    expect(models?.source).toMatch(/model-registry/);
    expect(capabilities?.source).toMatch(/capability-registry/);
    expect(devices?.source).toMatch(/cross-mode-sync/);
    expect(approvals?.source).toMatch(/governance/);
    expect(risks?.source).toMatch(/governance/);
    expect(world.facts.every((row) => row.at > 0 && row.ttlMs > 0)).toBe(true);
  });

  it("reads owner Library as the files domain — not an invented in-view registry", () => {
    const files = readWorldState().facts.find((fact) => fact.domain === "files");
    expect(files?.source).toMatch(/library-engine/);
    expect(files?.value).toMatch(/empty|library item/i);
  });

  it("reads the active owner workspace from the project-workspace engine", () => {
    const workspace = readWorldState().facts.find(
      (fact) => fact.domain === "project" && fact.key === "workspace",
    );
    expect(workspace?.source).toMatch(/project-workspace-engine/);
    expect(workspace?.value).toMatch(/none active|hands-off|\(/);
  });

  it("marks a fact stale once its domain TTL has passed", () => {
    const world = readWorldState();
    const models = world.facts.find((fact) => fact.domain === "models");
    expect(models).toBeTruthy();
    expect(factFreshness(models!, models!.at)).toBe(
      models!.freshness === "unknown" ? "unknown" : "verified",
    );
    expect(factFreshness(models!, models!.at + WORLD_TTL_MS.models + 1)).toBe(
      models!.freshness === "unknown" ? "unknown" : "stale",
    );
  });
});
