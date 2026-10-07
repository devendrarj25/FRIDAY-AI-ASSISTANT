/**
 * Locked section: UI organization, EXE install/update/uninstall, and
 * project independence. These files must stay inside the default `npm test`
 * run (`vitest run` with no path filter). They are not an opt-in suite.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** Exact set that must be re-run after any edit of the locked files. */
export const LOCKED_STABLE_TESTS = [
  "core/__tests__/project-independence.test.ts",
  "core/__tests__/ui-live-honesty.test.ts",
  "core/__tests__/navigation-registry.test.ts",
  "core/__tests__/safe-update.test.ts",
  "core/__tests__/github-release-installer.test.ts",
  "core/__tests__/clean-install-contract.test.ts",
] as const;

describe("stable section is in the default npm test run", () => {
  it("npm test is an unfiltered vitest run of the whole suite", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: { test: string } };
    expect(pkg.scripts.test).toMatch(/^vitest run\b/);
    expect(pkg.scripts.test).not.toMatch(/--exclude\b/);
    expect(pkg.scripts.test).not.toMatch(/--project\b/);
    expect(pkg.scripts.test).not.toMatch(/--changed\b/);
    expect(pkg.scripts.test).not.toMatch(/--shard\b/);
    // A path after `vitest run` would turn this into a subset, not the default suite.
    expect(pkg.scripts.test.replace(/--testTimeout=\d+/, "").trim()).toBe("vitest run");
  });

  it("locked files exist under core/__tests__ and vite configs do not exclude them", () => {
    for (const rel of LOCKED_STABLE_TESTS) {
      expect(fs.existsSync(path.join(ROOT, rel)), rel).toBe(true);
    }
    for (const cfg of ["vite.config.ts", "vite.electron.config.ts"]) {
      expect(read(cfg)).not.toMatch(/\btest\s*:/);
    }
  });

  it("PR Validation, Test EXE Build and Release all invoke npm test", () => {
    for (const file of [
      ".github/workflows/pr-validation.yml",
      ".github/workflows/test-build.yml",
      ".github/workflows/release.yml",
    ]) {
      expect(read(file)).toMatch(/run:\s*npm test\b/);
    }
  });
});
