/**
 * Phase 4: Models sections keep every current tab, and the screen
 * does not offer to run an installer.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  MODEL_SECTIONS,
  SECTION_TABS,
  firstPage,
  launcherLines,
  sectionCovers,
  selectCloud,
} from "../../src/lib/friday/model-sections";

const require_ = createRequire(import.meta.url);
const library = require_("../../electron/local-library.cjs");

const TABS = [
  "catalog",
  "installed",
  "providers",
  "routing",
  "runtime",
  "benchmarks",
  "connect",
  "activity",
];

describe("model sections", () => {
  it("puts every current Models tab under Local, Cloud, or Routing", () => {
    expect(MODEL_SECTIONS.map((section) => section.label)).toEqual([
      "LOCAL AI",
      "CLOUD AI",
      "ROUTING",
    ]);
    expect(sectionCovers(TABS)).toEqual([]);
    expect(SECTION_TABS.routing).toEqual(["routing"]);
    const page = readFileSync(path.resolve("src/routes/models.tsx"), "utf8");
    expect(page).toContain("MODEL_SECTIONS");
    expect(page).toContain("firstPage");
    expect(page).toContain("Select all free");
    expect(page).toContain("Local answer strategy");
    expect(page).not.toMatch(/disabled=\{true\}/);
  });

  it("never offers to run a launcher from the screen helper", () => {
    const ollama = library.runnerById("ollama");
    const gpt = library.runnerById("gpt4all");
    expect(launcherLines(ollama, false).canRun).toBe(false);
    expect(launcherLines(ollama, false).check).toMatch(/owner click/i);
    expect(launcherLines(ollama, true).check).toMatch(/signature/i);
    expect(launcherLines(gpt, true).check).toMatch(/sha256/i);
    expect(
      launcherLines({ release: null, officialPage: "https://lmstudio.ai/download" }, true).check,
    ).toMatch(/official page/i);
  });

  it("selects free models and refuses paid until the owner confirms", () => {
    const models = [
      { id: "free-a", type: "cloud", access: "free" },
      { id: "paid-a", type: "cloud", access: "paid" },
      { id: "local-a", type: "local", access: "free" },
    ];
    expect(selectCloud(models, "free", false).ids).toEqual(["free-a"]);
    expect(selectCloud(models, "paid", false).refused).toMatch(/confirm/i);
    expect(selectCloud(models, "paid", false).ids).toEqual(["free-a"]);
    expect(selectCloud(models, "both", true).ids).toEqual(["free-a", "paid-a"]);
  });

  it("pages a long model list and leaves the rest behind Show more", () => {
    const rows = Array.from({ length: 100 }, (_, index) => index);
    expect(firstPage(rows, 40).rows).toHaveLength(40);
    expect(firstPage(rows, 40).more).toBe(true);
    expect(firstPage(rows, 100).more).toBe(false);
    expect(firstPage(rows, 0).rows).toEqual([]);
  });
});
