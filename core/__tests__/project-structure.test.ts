/**
 * The checkout must stay arranged after every upgrade: no re-introduced
 * duplicates, no missing canonical folders, no compiled junk committed.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const arranger = require("../../scripts/arrange-project.cjs") as {
  loadManifest: () => { trees: Record<string, { folders: string[] }> };
  declaredFolders: (m: unknown) => string[];
  inspect: () => { missing: string[]; duplicates: { path: string }[]; junk: string[] };
};

describe("project structure", () => {
  const report = arranger.inspect();

  it("declares every canonical folder exactly once", () => {
    const folders = arranger.declaredFolders(arranger.loadManifest());
    expect(folders.length).toBeGreaterThan(80);
    expect(new Set(folders).size).toBe(folders.length);
  });

  it("has no missing folders", () => {
    expect(report.missing).toEqual([]);
  });

  it("keeps every memory folder in a fresh clone while ignoring what is stored in them", () => {
    // /memory/ used to be ignored whole, so a clone had none of the nine
    // declared folders and the layout check failed on every CI runner.
    const root = path.resolve(__dirname, "..", "..");
    const ignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8").split("\n");
    expect(ignore).not.toContain("/memory/");
    expect(ignore).toEqual(
      expect.arrayContaining(["/memory/**", "!/memory/*/", "!/memory/*/.gitkeep"]),
    );
    const folders = arranger.declaredFolders(arranger.loadManifest());
    const memory = folders.filter((folder) => folder.startsWith("memory/"));
    expect(memory).toHaveLength(9);
    for (const folder of memory) {
      expect(fs.existsSync(path.join(root, folder, ".gitkeep")), folder).toBe(true);
    }
  });

  it("names the repository-root packages the kernel imports so ruff sorts them the same everywhere", () => {
    // ruff treats memory/, modules/ and tools/ as first party only while the
    // folder exists; the setting makes kernel/main.py sort the same on a clone.
    const ruff = fs.readFileSync(path.resolve(__dirname, "..", "..", "ruff.toml"), "utf8");
    expect(ruff).toMatch(/known-first-party\s*=\s*\["memory",\s*"modules",\s*"tools"\]/);
  });

  it("has no duplicated implementations", () => {
    expect(report.duplicates.map((d) => d.path)).toEqual([]);
  });

  it("has no build junk in the checkout", () => {
    expect(report.junk).toEqual([]);
  });
});
