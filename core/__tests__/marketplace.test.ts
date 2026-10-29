import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import { MARKET_PACKS, capabilityId, packsForTree } from "../../src/lib/friday/marketplace";

const require_ = createRequire(import.meta.url);
const capabilities = require_("../../electron/capabilities.cjs");

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "friday-market-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("capability marketplace", () => {
  it("ships packs for every capability tree", () => {
    for (const tree of ["skills", "tools", "agents", "modules", "plugins", "workflows"] as const) {
      expect(packsForTree(tree).length).toBeGreaterThan(5);
    }
    expect(new Set(MARKET_PACKS.map(capabilityId)).size).toBe(MARKET_PACKS.length);
  });

  it("installs a skill pack as a real runnable custom skill", () => {
    const pack = packsForTree("skills")[0]!;
    const result = capabilities.installPack({ workspaceRoot: root }, pack);
    expect(result.ok).toBe(true);
    const dir = join(root, "skills", "custom", pack.slug);
    expect(existsSync(join(dir, "skill.json"))).toBe(true);
    expect(existsSync(join(dir, "skill.mjs"))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(dir, "skill.json"), "utf8"));
    expect(manifest.id).toBe(pack.slug);
    // Test-before-enable: a freshly written pack is installed but NOT enabled
    // until it really runs in the sandbox.
    expect(manifest.enabled).toBe(false);
    expect(manifest.verification.status).toBe("pending");
  });

  it("installs a plugin pack with a loadable entry file", () => {
    const pack = packsForTree("plugins")[0]!;
    const result = capabilities.installPack({ workspaceRoot: root }, pack);
    expect(result.ok).toBe(true);
    const dir = join(root, "plugins", "installed", pack.slug);
    const manifest = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8"));
    expect(manifest.entry).toBe("index.cjs");
    expect(manifest.enabled).toBe(false);
    expect(existsSync(join(dir, "index.cjs"))).toBe(true);
  });

  it("shows installed packs in discovery and removes them again", () => {
    const pack = packsForTree("agents")[0]!;
    const installed = capabilities.installPack({ workspaceRoot: root }, pack);
    const index = capabilities.list({ appRoot: null, workspaceRoot: root });
    expect(index.items.some((i: { id: string }) => i.id === installed.id)).toBe(true);

    const removed = capabilities.uninstallPack({ workspaceRoot: root }, installed.id);
    expect(removed.ok).toBe(true);
    expect(existsSync(installed.path)).toBe(false);
  });

  it("refuses to install without a workspace and rejects unknown trees", () => {
    expect(capabilities.installPack({ workspaceRoot: null }, MARKET_PACKS[0]).ok).toBe(false);
    expect(capabilities.installPack({ workspaceRoot: root }, { tree: "nope" }).ok).toBe(false);
    expect(capabilities.uninstallPack({ workspaceRoot: root }, "../escape").ok).toBe(false);
  });
});
