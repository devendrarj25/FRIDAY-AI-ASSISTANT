/**
 * Composer capabilities: real sources, removable chips, suggestions and the
 * directive that is actually sent to the model.
 */
import { describe, expect, it } from "vitest";
import {
  buildCapabilityGroups,
  capabilityDirective,
  capabilityId,
  flatten,
  suggestCapabilities,
} from "../../src/lib/friday/capabilities";

const scan = {
  root: "C:/FRIDAY",
  exists: true,
  valid: true,
  present: [],
  missing: [],
  scannedAt: Date.now(),
  skills: [{ id: "repo-audit", name: "Repo Audit", version: "1.0.0" }],
  plugins: [{ id: "notion", name: "Notion Sync", version: null }],
  agents: [{ id: "coder", name: "Code Writer", version: null }],
  workflows: [{ id: "nightly", name: "Nightly Build", version: null }],
  tools: [],
  modules: [],
} as never;

describe("composer capabilities", () => {
  it("builds groups from real workspace state", () => {
    const groups = buildCapabilityGroups(null, scan);
    const skills = groups.find((g) => g.kind === "skills");
    expect(skills?.items.map((i) => i.name)).toContain("Repo Audit");
    expect(skills?.items.every((i) => i.live)).toBe(true);
  });

  it("never produces duplicate capability ids", () => {
    const all = flatten(buildCapabilityGroups(null, scan));
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
  });

  it("suggests related capabilities while typing and skips attached ones", () => {
    const groups = buildCapabilityGroups(null, scan);
    const first = suggestCapabilities("search the web for the latest release", groups, []);
    expect(first.length).toBeGreaterThan(0);
    const attached = first.map((c) => c.id);
    const second = suggestCapabilities("search the web for the latest release", groups, attached);
    expect(second.some((c) => attached.includes(c.id))).toBe(false);
  });

  it("turns attachments into a real directive and pinned model ids", () => {
    const groups = buildCapabilityGroups(null, scan);
    const all = flatten(groups);
    const tool = all.find((c) => c.id === capabilityId("tools", "Web Search"))!;
    const model = all.find((c) => c.kind === "models")!;
    const { extra, modelIds } = capabilityDirective([tool, model]);
    expect(extra).toContain("Web Search");
    expect(modelIds).toEqual([model.ref]);
  });

  it("returns nothing when nothing is attached", () => {
    expect(capabilityDirective([])).toEqual({ extra: "", modelIds: [] });
  });

  it("does not advertise fake connector names when none are loaded", () => {
    const groups = buildCapabilityGroups(null, scan);
    const connectors = groups.find((g) => g.kind === "connectors");
    expect(connectors).toBeUndefined();
  });
});
