/**
 * The checkout must stay arranged after every upgrade: no re-introduced
 * duplicates, no missing canonical folders, no compiled junk committed.
 */
import { describe, expect, it } from "vitest";
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

  it("has no duplicated implementations", () => {
    expect(report.duplicates.map((d) => d.path)).toEqual([]);
  });

  it("has no build junk in the checkout", () => {
    expect(report.junk).toEqual([]);
  });
});
