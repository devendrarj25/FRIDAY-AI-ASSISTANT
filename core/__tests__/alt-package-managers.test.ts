/**
 * The install fallback chain: package manager, vendor feed, Chocolatey, Scoop.
 * Chocolatey and Scoop are used only when already installed and are never
 * installed by FRIDAY. No network and no installs here.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const alt = require_(path.join(root, "electron/alt-package-managers.cjs"));
const toolchain = require_(path.join(root, "electron/toolchain.cjs"));
const manifest = require_(path.join(root, "config/agent-toolkit.json"));

describe("alternate package managers", () => {
  it("name only tools the Install Manager has", () => {
    const ids = new Set(toolchain.TOOLS.map((tool: { id: string }) => tool.id));
    for (const id of Object.keys(alt.ALT)) expect(ids.has(id), id).toBe(true);
  });

  it("cover every tool the build installs, so a missing winget still leaves two more sources", () => {
    for (const entry of manifest.prefetch) {
      // A Windows optional feature is switched on with DISM, not a package manager.
      if (toolchain.toolById(entry.id).optionalFeature) continue;
      expect(alt.managersFor(entry.id).length, entry.id).toBeGreaterThan(0);
    }
  });

  it("build silent, non-interactive commands and never uninstall through them", () => {
    expect(alt.commandFor("choco", "ripgrep", "install")).toEqual([
      "choco",
      ["install", "ripgrep", "-y", "--no-progress", "--limit-output"],
    ]);
    expect(alt.commandFor("choco", "ripgrep", "update")?.[1][0]).toBe("upgrade");
    expect(alt.commandFor("choco", "ripgrep", "repair")?.[1]).toContain("--force");
    expect(alt.commandFor("scoop", "ripgrep", "install")).toEqual([
      "scoop",
      ["install", "ripgrep"],
    ]);
    expect(alt.commandFor("scoop", "ripgrep", "update")).toEqual(["scoop", ["update", "ripgrep"]]);
    expect(alt.commandFor("choco", "ripgrep", "uninstall")).toBeNull();
    expect(alt.commandFor("scoop", "Docker Desktop", "install")).toBeNull();
    expect(alt.commandFor("apt", "ripgrep", "install")).toBeNull();
  });

  it("is the last step of the install chain, after the package manager and the vendor feed", () => {
    const source = readFileSync(path.join(root, "electron/toolchain.cjs"), "utf8");
    expect(source).toContain("[tryPackageManager, tryVendorInstaller, tryAlternateManagers]");
    expect(source).toContain("[tryVendorInstaller, tryPackageManager, tryAlternateManagers]");
    expect(source).toContain("if (!cmd || !(await which(manager))) continue;");
  });

  it("never installs a package manager or pipes a downloaded script into a shell", () => {
    const source = readFileSync(path.join(root, "electron/alt-package-managers.cjs"), "utf8");
    expect(source).not.toMatch(/iex|Invoke-Expression|DownloadString|irm /i);
  });
});
