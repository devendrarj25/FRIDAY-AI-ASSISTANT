/**
 * Local PR Validation substitute: the same product gates as
 * `.github/workflows/pr-validation.yml`, without a hosted runner.
 *
 * This is not a second CI and must never publish a GitHub check or loosen
 * Safe Merge's required `PR Validation` status.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const local = require_("../../scripts/validate-local.cjs") as {
  buildPlan: (opts?: Record<string, unknown>) => Array<{
    id: string;
    command?: string;
    args?: string[];
    skip: string | null;
  }>;
  windowsGatesEnabled: (opts?: Record<string, unknown>) => boolean;
};

describe("validate:local is the no-Actions orchestrator", () => {
  it("is wired as npm run validate:local", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["validate:local"]).toBe("node scripts/validate-local.cjs");
    expect(pkg.scripts["lint"]).toContain("eslint .");
    expect(pkg.scripts["lint"]).toContain("python -m ruff check kernel");
    expect(pkg.scripts["lint"]).toContain("python -m ruff format --check kernel");
    expect(pkg.scripts["lint:py"]).toContain("python -m ruff check kernel");
    expect(fs.existsSync(path.join(ROOT, "ruff.toml"))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, ".prettierrc"))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, "prettier.config.js"))).toBe(false);
  });

  it("covers every product gate PR Validation already runs", () => {
    const src = read("scripts/validate-local.cjs");
    const workflow = read(".github/workflows/pr-validation.yml");
    for (const cmd of [
      "npm test",
      "npm run typecheck",
      "npm run docs:check",
      "npm run verify:version",
      "npm run lint",
      "npm run test:kernel",
      "scripts/verify-deps.cjs",
      "scripts/audit-architecture.cjs --strict",
      "scripts/electron-pack.cjs --win nsis",
      "scripts/verify-build.cjs nsis",
      "windows-installer-smoke.ps1",
    ]) {
      expect(workflow, cmd).toContain(cmd);
    }
    expect(src).toContain('["test"]');
    expect(src).toContain('["run", "typecheck"]');
    expect(src).toContain('["run", "docs:check"]');
    expect(src).toContain('["run", "verify:version"]');
    expect(src).toContain('["run", "lint"]');
    expect(src).toContain('["run", "test:kernel"]');
    expect(src).toContain('["run", "build:desktop"]');
    expect(src).toContain("verify-deps.cjs");
    expect(src).toContain("audit-architecture.cjs");
    expect(src).toContain("--strict");
    expect(src).toContain("electron-pack.cjs");
    expect(src).toContain("nsis");
    expect(src).toContain("verify-build.cjs");
    expect(src).toContain("windows-installer-smoke.ps1");
    expect(src).toContain("heal");
    expect(src).toContain("--check");
    expect(src).toContain("ensure-electron.cjs");
    expect(src).toContain("arrange-project.cjs");
    expect(workflow).toContain("scripts/release-engine.cjs heal --check");
    expect(workflow).toContain("npm run build:desktop");
    expect(workflow).toContain("scripts/ensure-electron.cjs --quiet");
  });

  it("never dispatches Actions or publishes a PR Validation status", () => {
    const src = read("scripts/validate-local.cjs");
    expect(src).not.toMatch(/\bgh\s+(api|workflow|run)\b/);
    expect(src).not.toContain("GITHUB_OUTPUT");
    expect(src).not.toContain("git push");
    expect(src).not.toContain("context='PR Validation'");
    const plan = local.buildPlan({ platform: "linux", pack: true, version: "1.0.0.2" });
    expect(plan.every((step) => path.basename(String(step.command || "")) !== "gh")).toBe(true);
  });

  it("does not replace Safe Merge's required GitHub check", () => {
    expect(read(".github/workflows/safe-merge.yml")).toContain("--required 'PR Validation'");
    expect(read(".github/workflows/pr-validation.yml")).toContain("pull_request:");
    expect(read(".github/workflows/pr-validation.yml")).toContain("workflow_dispatch:");
  });

  it("skips Windows pack on Linux and runs it when --pack or win32", () => {
    expect(local.windowsGatesEnabled({ platform: "linux", pack: false })).toBe(false);
    expect(local.windowsGatesEnabled({ platform: "win32", pack: false })).toBe(true);
    expect(local.windowsGatesEnabled({ platform: "linux", pack: true })).toBe(true);
    const linux = local.buildPlan({ platform: "linux", pack: false, version: "1.0.0.2" });
    const skipped = linux.filter((step) => step.skip);
    expect(skipped.map((step) => step.id).sort()).toEqual(["nsis", "smoke", "verify-build"]);
    expect(skipped.every((step) => /windows-latest|Windows/i.test(String(step.skip)))).toBe(true);
    const win = local.buildPlan({ platform: "win32", pack: false, version: "1.0.0.2" });
    expect(win.filter((step) => step.skip)).toEqual([]);
    const smoke = win.find((step) => step.id === "smoke");
    expect(smoke?.args?.join(" ")).toContain("windows-installer-smoke.ps1");
  });

  it("--plan prints gates and does not run npm test", () => {
    const result = spawnSync(process.execPath, ["scripts/validate-local.cjs", "--plan"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("local validation plan");
    expect(result.stdout).toContain("typecheck");
    expect(result.stdout).toContain("npm test");
    if (process.platform === "win32") {
      expect(result.stdout).toContain("Windows NSIS");
      expect(result.stdout).not.toMatch(/skip\s+Windows NSIS/);
    } else {
      expect(result.stdout).toMatch(/skip[\s\S]*Windows NSIS/);
    }
    expect(result.stdout).not.toMatch(/\d+ passed/);
  });
});
