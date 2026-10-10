/**
 * FRIDAY · cross-platform build / update / repository consistency.
 *
 * Static guards for four contracts that must never drift:
 *  1. every GitHub workflow exists in the repository source (ZIP parity),
 *  2. a packaged FRIDAY can never apply a raw source ZIP, and its UI hides
 *     the source "Download & apply" action,
 *  3. the local Windows build enforces the same package.json engines as CI,
 *  4. repository-control stays manual, non-destructive and main-safe.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (rel: string) => fs.readFileSync(path.resolve(root, rel), "utf8");

const WORKFLOWS = [
  "pr-validation.yml",
  "test-build.yml",
  "release.yml",
  "branch-cleanup.yml",
  "main-safety-recovery.yml",
  "repository-control.yml",
  "safe-merge.yml",
  "maintenance.yml",
  "health-weekly.yml",
  "auto-recover.yml",
  "security.yml",
];

describe("source parity", () => {
  it("ships every GitHub workflow in the repository source", () => {
    for (const file of WORKFLOWS) {
      const full = path.resolve(root, ".github/workflows", file);
      expect(fs.existsSync(full), `${file} must exist in source`).toBe(true);
      expect(read(`.github/workflows/${file}`).trim().length).toBeGreaterThan(0);
    }
  });

  it("has no workflow files beyond the known ones", () => {
    const present = fs
      .readdirSync(path.resolve(root, ".github/workflows"))
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
    expect(present.sort()).toEqual([...WORKFLOWS].sort());
  });
});

describe("packaged update path", () => {
  const main = read("electron/main.cjs");

  it("blocks raw source ZIP updates for a packaged app", () => {
    const handler = main.slice(
      main.indexOf('ipcMain.handle("github:pull"'),
      main.indexOf('ipcMain.handle("github:pull"') + 900,
    );
    expect(handler).toContain("if (app.isPackaged)");
    expect(handler).toContain("sourceUpdateBlocked");
  });

  it("tells the renderer whether this build is packaged", () => {
    expect(main).toContain("packaged: app.isPackaged");
  });

  it("hides the source Download & apply action in a packaged app", () => {
    const ui = read("src/components/friday/settings/GithubUpdates.tsx");
    expect(ui).toContain("check?.packaged ? null : (");
    expect(ui).toContain("Download & apply");
  });
});

describe("local Windows build toolchain", () => {
  const cmd = read("scripts/build-windows.cmd");
  const recipe = read("scripts/build-pipeline.cjs");
  const pkg = JSON.parse(read("package.json")) as { engines: Record<string, string> };

  it("checks engines before npm ci", () => {
    expect(cmd).toContain("build-pipeline.cjs");
    expect(recipe.indexOf("check-engines.cjs")).toBeGreaterThan(-1);
    expect(recipe.indexOf("check-engines.cjs")).toBeLessThan(
      recipe.indexOf("npm ci --no-audit --no-fund"),
    );
  });

  it("uses the package.json engine requirements, not a hardcoded older one", async () => {
    expect(pkg.engines["node"]).toBe(">=22.19.0");
    expect(pkg.engines["npm"]).toBe(">=10.9.0");
    expect(cmd).not.toContain("Node.js 20+");
    expect(recipe).not.toContain("Node.js 20+");
    const gate = (await import("../../scripts/check-engines.cjs" as string)) as {
      compare: (a: string, b: string) => number;
      minimum: (r: string) => string;
    };
    expect(gate.minimum(">=22.19.0")).toBe("22.19.0");
    expect(gate.compare("22.18.0", "22.19.0")).toBe(-1);
    expect(gate.compare("22.19.0", "22.19.0")).toBe(0);
    expect(gate.compare("23.1.0", "22.19.0")).toBe(1);
  });
});

describe("no workflow ever rewrites history", () => {
  it("force-pushes nowhere, including the release branch", () => {
    for (const file of WORKFLOWS) {
      const wf = read(`.github/workflows/${file}`);
      expect(wf, file).not.toContain("--force-with-lease");
      expect(wf, file).not.toMatch(/git\s+push[^\n]*(--force|\s-f\b)/);
      expect(wf, file).not.toContain("filter-branch");
    }
  });

  it("creates the release branch with a plain push", () => {
    const wf = read(".github/workflows/release.yml");
    expect(wf).toContain('git push origin "HEAD:$branch"');
  });
});

describe("repository control safety", () => {
  const wf = read(".github/workflows/repository-control.yml");

  it("is manual only", () => {
    expect(wf).toContain("workflow_dispatch:");
    expect(wf).not.toMatch(/^\s{2}(push|pull_request|schedule):/m);
  });

  it("never force-pushes, resets or rewrites history", () => {
    expect(wf).not.toContain("--force");
    expect(wf).not.toContain("push -f");
    expect(wf).not.toContain("git reset --hard");
    expect(wf).not.toContain("filter-branch");
  });

  it("requires confirmation for every destructive action", () => {
    for (const word of ["MERGE", "REVERT", "RESTORE", "DELETE"])
      expect(wf).toContain(`[ "$CONFIRM" = "${word}" ]`);
  });

  it("protects main, development and recovery branches from deletion", () => {
    expect(wf).toContain("main|master|develop|development|release");
    expect(wf).toContain("recovery/*");
  });

  it("only merges a non-main, non-recovery branch into main", () => {
    expect(wf).toContain('[ "$base" = "main" ]');
    expect(wf).toContain('[ "$head" != "main" ]');
    expect(wf).toContain("recovery branches are independent backups and are never merged");
  });

  it("requires PR Validation on the head commit through the shared check contract", () => {
    expect(wf).toContain("scripts/check-contract.cjs");
    expect(wf).toContain('--required "PR Validation"');
    expect(wf).toContain("headRefOid");
    expect(wf).not.toContain('.state // ""');
  });

  it("restores historical content without rewriting history", () => {
    expect(wf).toContain("git read-tree --reset -u");
  });
});
