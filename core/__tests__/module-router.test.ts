import { describe, expect, it } from "vitest";
import {
  candidateModules,
  chooseModules,
  resetModuleIndex,
  scoreModule,
} from "../../src/lib/friday/brain/module-router";
import type { ModulePackManifest } from "../../src/lib/friday/brain/module-forge";

const pack = (
  id: string,
  name: string,
  description: string,
  extra: Partial<ModulePackManifest> = {},
): ModulePackManifest => ({
  id,
  name,
  description,
  category: "developer",
  permissions: ["fs.read"],
  risk: "safe",
  inputs: ["folder"],
  enabled: true,
  ...extra,
});

describe("module router", () => {
  it("indexes by token and does not score the whole catalog on a miss", () => {
    resetModuleIndex();
    const catalog = [
      pack("modules/system/folder-inventory", "Folder inventory", "Shallow inventory of a folder"),
      pack("modules/developer/package-scripts", "Package scripts", "List npm script names"),
      pack("modules/developer/git-status-report", "Git status report", "Summarise git status"),
    ];
    const hits = candidateModules("please folder-inventory this workspace", catalog);
    expect(hits.map((item) => item.id)).toContain("modules/system/folder-inventory");
    expect(candidateModules("good morning friday", catalog)).toEqual([]);
  });

  it("runs named modules in sequence and skips disabled or write modules", () => {
    resetModuleIndex();
    const catalog = [
      pack("modules/system/folder-inventory", "Folder inventory", "Shallow inventory of a folder"),
      pack("modules/developer/package-scripts", "Package scripts", "List npm script names"),
      pack("modules/developer/project-scaffold", "Project scaffold", "Write a project tree", {
        risk: "write",
      }),
      pack("modules/developer/sqlite-inspect", "Sqlite inspect", "Read-only sqlite inspector", {
        enabled: false,
      }),
    ];
    const chained = chooseModules("Folder inventory then Package scripts", catalog);
    expect(chained.map((item) => item.name)).toEqual(["Folder inventory", "Package scripts"]);
    expect(scoreModule("write a project scaffold please", catalog[2]!)).toBeGreaterThan(0);
    expect(chooseModules("Project scaffold", catalog)).toEqual([]);
  });

  it("skips named modules that cannot run or failed health", () => {
    resetModuleIndex();
    const catalog = [
      pack("modules/broken/no-entry", "Broken pack", "Has no main.py", { runnable: false }),
      pack("modules/broken/unhealthy", "Unhealthy pack", "Failed health", { healthy: false }),
      pack("modules/system/folder-inventory", "Folder inventory", "Shallow inventory of a folder"),
    ];
    expect(chooseModules("Broken pack", catalog)).toEqual([]);
    expect(chooseModules("Unhealthy pack", catalog)).toEqual([]);
    expect(chooseModules("Folder inventory", catalog).map((item) => item.id)).toEqual([
      "modules/system/folder-inventory",
    ]);
  });
});
