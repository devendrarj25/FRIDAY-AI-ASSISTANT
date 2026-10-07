import path from "node:path";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { installerAsset, mapReleaseAsset } = require(
  path.resolve(process.cwd(), "electron/github-sync.cjs"),
) as {
  installerAsset: (assets: { name: string; url: string }[]) => { name: string; url: string } | null;
  mapReleaseAsset: (asset: Record<string, unknown>) => {
    name: string;
    url: string;
    apiUrl: string | null;
    id: number | null;
    bytes: number;
  };
};

describe("github release installer", () => {
  it("prefers the NSIS setup over the portable build", () => {
    const picked = installerAsset([
      { name: "FRIDAY-Portable-1.2.0.exe", url: "p" },
      { name: "FRIDAY-Setup-1.2.0.exe", url: "s" },
      { name: "source.zip", url: "z" },
    ]);
    expect(picked?.url).toBe("s");
  });

  it("falls back to the portable executable when no setup is published", () => {
    expect(installerAsset([{ name: "FRIDAY-Portable-1.2.0.exe", url: "p" }])?.url).toBe("p");
  });

  it("returns nothing when a release publishes no Windows executable", () => {
    expect(installerAsset([{ name: "notes.md", url: "n" }])).toBeNull();
  });

  it("carries the GitHub API asset URL through installer selection", () => {
    const mapped = mapReleaseAsset({
      id: 7,
      name: "FRIDAY-Setup-1.2.0.exe",
      url: "https://api.github.com/repos/devendrarj25/FRIDAY-AI-ASSISTANT/releases/assets/7",
      browser_download_url:
        "https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT/releases/download/v1.2.0/FRIDAY-Setup-1.2.0.exe",
      size: 50,
    });
    const picked = installerAsset([{ name: "FRIDAY-Portable-1.2.0.exe", url: "p" }, mapped]);
    expect(picked?.url).toBe(mapped.url);
    expect((picked as { apiUrl?: string }).apiUrl).toBe(mapped.apiUrl);
    expect((picked as { id?: number }).id).toBe(7);
  });
});

describe("github update vs a live kernel", () => {
  const main = readFileSync(path.resolve(process.cwd(), "electron/main.cjs"), "utf8");

  it("stops the kernel before backing up or rolling back protected folders", () => {
    const install = main.slice(
      main.indexOf('ipcMain.handle("github:install-update"'),
      main.indexOf('ipcMain.handle("github:update-state"'),
    );
    expect(install.indexOf("await stopKernel()")).toBeGreaterThan(-1);
    expect(install.indexOf("await stopKernel()")).toBeLessThan(install.indexOf("backupState"));

    const rollback = main.slice(
      main.indexOf('ipcMain.handle("github:rollback"'),
      main.indexOf('ipcMain.handle("github:source-status"'),
    );
    expect(rollback.indexOf("await stopKernel()")).toBeGreaterThan(-1);
    expect(rollback.indexOf("await stopKernel()")).toBeLessThan(
      rollback.indexOf("updateSafety.rollback"),
    );
    expect(rollback).toContain("resumeKernel");
  });
});
