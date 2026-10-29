import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const project = require(path.join(root, "electron", "project.cjs"));
const diagnostics = require(path.join(root, "electron", "diagnostics.cjs"));

describe("project root resolution", () => {
  it("finds the real project root, never resources/", () => {
    const resolved = project.resolveProjectRoot({
      appPath: root,
      resourcesPath: path.join(root, "resources"),
      exePath: path.join(root, "FRIDAY.exe"),
    });
    expect(resolved).toBe(root);
    expect(resolved.endsWith(`${path.sep}resources`)).toBe(false);
    expect(project.locate("package.json", {})).toBe(path.join(root, "package.json"));
  });

  it("lists resources and the install dir as fallbacks, not as the only root", () => {
    const candidates = project.projectRootCandidates({
      appPath: root,
      resourcesPath: "/opt/friday/resources",
      exePath: "/opt/friday/FRIDAY.exe",
    });
    expect(candidates).toContain("/opt/friday");
    expect(candidates.indexOf(root)).toBeLessThan(candidates.indexOf("/opt/friday"));
  });
});

describe("doctor registry + database reporting", () => {
  it("reports empty component registries as ready, not broken", async () => {
    const report = await diagnostics.runDiagnostics(
      {
        install: root,
        appPath: root,
        userData: fs.mkdtempSync(path.join(os.tmpdir(), "friday-doctor-")),
      },
      { deep: false },
    );
    const registries = report.checks.filter((c: { id: string }) => c.id.startsWith("components-"));
    expect(registries.length).toBeGreaterThan(0);
    for (const entry of registries as { status: string; detail: string }[]) {
      expect(entry.status).toBe("Ready");
      expect(entry.detail).toMatch(/installed — Ready/);
    }

    const manifest = report.checks.find((c: { id: string }) => c.id === "dep-manifest");
    expect(manifest).toBeUndefined(); // package.json was found in the real root

    const db = report.checks.find((c: { id: string }) => c.id === "database") as {
      status: string;
      fixable: boolean;
    };
    expect(db.status).not.toBe("Error");
    expect(db.fixable).toBe(true); // a missing first-run database is repairable, not fatal
  }, 120_000);

  it("creates and verifies the SQLite database on demand", async () => {
    // Scratch state lives in the OS temp dir: the checkout must stay clean even
    // if this test is interrupted, and the structure audit runs in parallel.
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "friday-doctor-db-"));
    try {
      const result = await project.ensureDatabase({ userData, install: root });
      expect(result.ok).toBe(true);
      expect(result.integrity).toBe("ok");
      expect(result.tables).toContain("chats");
      expect(project.isSqliteFile(result.file)).toBe(true);
    } finally {
      // Never leave scratch folders behind: the structure audit treats them as junk.
      fs.rmSync(userData, { recursive: true, force: true });
    }
  }, 60_000);
});
