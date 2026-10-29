import { describe, expect, it } from "vitest";
import { ESSENTIAL_SLUGS, essentialPacks, isEssential } from "@/lib/friday/capability-seed";
import { MARKET_PACKS, capabilityId } from "@/lib/friday/marketplace";

describe("preinstalled capability pack", () => {
  it("references only packs that exist in the canonical catalog", () => {
    const known = new Set(MARKET_PACKS.map((p) => `${p.tree}:${p.slug}`));
    const missing: string[] = [];
    for (const [tree, slugs] of Object.entries(ESSENTIAL_SLUGS)) {
      for (const slug of slugs) if (!known.has(`${tree}:${slug}`)) missing.push(`${tree}:${slug}`);
    }
    expect(missing).toEqual([]);
  });

  it("resolves every essential slug to exactly one pack", () => {
    const total = Object.values(ESSENTIAL_SLUGS).reduce((n, list) => n + list.length, 0);
    expect(essentialPacks()).toHaveLength(total);
    expect(essentialPacks().every(isEssential)).toBe(true);
  });

  it("never auto-installs an exec-risk capability", () => {
    expect(essentialPacks().filter((p) => p.risk === "exec")).toEqual([]);
  });

  it("covers every capability tree with unique ids", () => {
    const trees = new Set(essentialPacks().map((p) => p.tree));
    for (const tree of ["skills", "tools", "agents", "modules", "plugins", "workflows"]) {
      expect(trees.has(tree as never)).toBe(true);
    }
    const ids = essentialPacks().map(capabilityId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps catalog slugs unique per tree", () => {
    const ids = MARKET_PACKS.map((p) => `${p.tree}:${p.slug}`);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
