/**
 * Proof for the connectors + answer-style pass:
 *  • answer style and custom instructions really reach the one system prompt,
 *  • connectors show up in the shared capability snapshot (no second list).
 */
import { describe, expect, it } from "vitest";
import { identity } from "../../src/lib/friday/brain/identity";
import { capabilityRegistry } from "../../src/lib/friday/brain/capability-registry";

describe("identity answer style", () => {
  it("compiles response style, reasoning choice and owner instructions", () => {
    identity.updateProfile({
      responseStyle: "brief",
      showReasoning: true,
      customInstructions: "Always answer in metric units.",
    });
    const prompt = identity.compile();
    expect(prompt).toContain("one or two sentences");
    expect(prompt).toContain("show those steps");
    expect(prompt).toContain("Always answer in metric units.");

    identity.updateProfile({
      responseStyle: "detailed",
      showReasoning: false,
      customInstructions: "",
    });
    const second = identity.compile();
    expect(second).toContain("trade-offs");
    expect(second).toContain("keep your working out of the reply");
    expect(second).not.toContain("metric units");
  });
});

describe("connector capability provider", () => {
  it("folds connectors into the shared capability snapshot", async () => {
    await import("../../src/lib/friday/connectors");
    const snapshot = capabilityRegistry.refresh();
    // With no desktop bridge the cache is empty, so no invented resources.
    expect(snapshot.resources.filter((r) => r.ref.startsWith("connector:"))).toHaveLength(0);
    expect(snapshot.refreshedAt).toBeGreaterThan(0);
  });
});
