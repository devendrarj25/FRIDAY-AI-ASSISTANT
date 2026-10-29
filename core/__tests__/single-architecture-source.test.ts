import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const root = resolve(__dirname, "../..");
const require_ = createRequire(import.meta.url);
const contract = require_(join(root, "electron/friday-contract.cjs"));
const paths = require_(join(root, "electron/friday-paths.cjs"));
const arrange = require_(join(root, "scripts/arrange-project.cjs"));

/**
 * ONE architecture contract, no invented roots, canonical folders only.
 */
describe("single architecture source", () => {
  it("keeps the checkout layout inside the contract, with the JSON as a generated mirror", () => {
    const mirror = JSON.parse(readFileSync(join(root, "config/project-structure.json"), "utf8"));
    expect(String(mirror.$generated)).toContain("friday-contract.cjs");
    expect(mirror.trees).toEqual(contract.SOURCE_LAYOUT.trees);
    expect(arrange.loadManifest()).toBe(contract.SOURCE_LAYOUT);
    expect(arrange.writeManifestMirror()).toBe(false); // already in sync
  });

  it("never falls back to process.cwd() for persistent data", () => {
    const before = process.env["FRIDAY_ROOT"];
    const beforeWorkspace = process.env["FRIDAY_WORKSPACE_ROOT"];
    delete process.env["FRIDAY_ROOT"];
    delete process.env["FRIDAY_WORKSPACE_ROOT"];
    try {
      expect(contract.rootFromEnv()).toBeNull();
      expect(() => contract.requireRoot()).toThrow(/FRIDAY root/i);
      expect(resolve(contract.resolveScanRoot())).toBe(resolve(contract.CHECKOUT_ROOT));
      const source = readFileSync(join(root, "electron/friday-contract.cjs"), "utf8");
      expect(source).not.toContain("process.cwd()");
    } finally {
      if (before) process.env["FRIDAY_ROOT"] = before;
      if (beforeWorkspace) process.env["FRIDAY_WORKSPACE_ROOT"] = beforeWorkspace;
    }
  });

  it("migrates a legacy folder into its canonical location instead of keeping two stores", () => {
    const home = mkdtempSync(join(tmpdir(), "friday-legacy-"));
    const legacy = contract.legacyAliases("models")[0] || "Models";
    mkdirSync(join(home, legacy), { recursive: true });
    writeFileSync(join(home, legacy, "keep.txt"), "user data");

    paths.setRoot(home);
    const report = paths.ensureStructure(home);
    paths.setRoot(null);

    expect(report.migrated.some((m: { to: string }) => m.to === "models")).toBe(true);
    expect(existsSync(join(home, "models", "keep.txt"))).toBe(true);
    expect(existsSync(join(home, legacy))).toBe(false);
  });
});
