import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const registry = require_(resolve(__dirname, "../../electron/root-registry.cjs"));

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "friday-root-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const item = (over: Record<string, unknown> = {}) => ({
  id: "tools/system/demo",
  tree: "tools",
  segment: "system",
  origin: "workspace",
  name: "Demo",
  version: "1.0.0",
  path: join(root, "tools", "system", "demo"),
  manifestFile: join(root, "tools", "system", "demo", "tool.json"),
  entry: "index.cjs",
  risk: "safe",
  enabled: true,
  configured: true,
  ...over,
});

describe("root registry", () => {
  it("writes root descriptors once and never overwrites owner choices", () => {
    const first = registry.ensureRootDescriptors(root, { version: "1.2.0" });
    expect(first.created).toContain("root.json");
    expect(first.created).toContain("permissions.json");
    const perms = join(root, "permissions.json");
    writeFileSync(perms, JSON.stringify({ paidModels: true }));
    const second = registry.ensureRootDescriptors(root, { version: "1.2.0" });
    expect(second.created).toEqual([]);
    expect(JSON.parse(readFileSync(perms, "utf8")).paidModels).toBe(true);
  });

  it("defaults paid models to OFF", () => {
    registry.ensureRootDescriptors(root, { version: "1.2.0" });
    expect(JSON.parse(readFileSync(join(root, "permissions.json"), "utf8")).paidModels).toBe(false);
  });

  it("does not register a component just because its folder exists", () => {
    const dir = join(root, "tools", "system", "demo");
    mkdirSync(dir, { recursive: true });
    const invalid = registry.validateComponent(item({ configured: false, manifestFile: null }));
    expect(invalid.status).toBe("invalid");
    expect(invalid.reasons).toContain("no readable manifest");

    writeFileSync(join(dir, "tool.json"), JSON.stringify({ name: "Demo", entry: "index.cjs" }));
    const missingEntry = registry.validateComponent(item());
    expect(missingEntry.status).toBe("invalid");
    expect(missingEntry.reasons.join(" ")).toContain("entry not found");

    writeFileSync(join(dir, "index.cjs"), "module.exports = {};\n");
    expect(registry.validateComponent(item()).status).toBe("registered");
  });

  it("rebuilds registry.json with real totals", () => {
    const dir = join(root, "tools", "system", "demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tool.json"), JSON.stringify({ name: "Demo", entry: "index.cjs" }));
    writeFileSync(join(dir, "index.cjs"), "module.exports = {};\n");
    const out = registry.rebuildRegistry(
      root,
      {
        items: [
          item(),
          item({
            id: "tools/system/ghost",
            path: join(root, "nope"),
            manifestFile: null,
            configured: false,
          }),
        ],
      },
      { version: "1.2.0" },
    );
    expect(out.totals).toMatchObject({ components: 2, registered: 1, invalid: 1 });
    const onDisk = JSON.parse(readFileSync(join(root, "registry.json"), "utf8"));
    expect(onDisk.counts.tools.total).toBe(2);
  });

  it("reports missing folders in integrity.json and records the boot", () => {
    mkdirSync(join(root, "config"), { recursive: true });
    const report = registry.writeIntegrity(root, ["config", "memory"], { version: "1.2.0" });
    expect(report.ok).toBe(false);
    expect(report.folders.missing).toContain("memory");
    expect(existsSync(join(root, "integrity.json"))).toBe(true);

    registry.writeBootRecord(root, { version: "1.2.0", ok: true, components: 2, invalid: 0 });
    const second = registry.writeBootRecord(root, { version: "1.2.0", ok: false, invalid: 1 });
    expect(second.history).toHaveLength(2);
    expect(second.last.ok).toBe(false);
  });
});
