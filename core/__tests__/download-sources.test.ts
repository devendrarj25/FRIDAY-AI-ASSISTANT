/**
 * The download sources the CMD build and the Install Manager rely on stay consistent.
 * No network: this pins the facts that went wrong before (a winget ID that does not exist, a release pin that was
 * deleted upstream, a winget exit code that was read as success, a pin kept in two places that drifted apart).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

describe("download sources", () => {
  const toolchain = require("../../electron/toolchain.cjs");
  const alt = require("../../electron/alt-package-managers.cjs");
  const tools: Array<Record<string, any>> = toolchain.TOOLS ?? toolchain.tools ?? [];

  it("does not name winget packages that winget-pkgs does not have", () => {
    const wingetIds = tools.map((t) => String(t["winget"] || "")).filter(Boolean);
    expect(wingetIds).not.toContain("Gradle.Gradle");
    expect(wingetIds).not.toContain("Apache.Maven");
  });

  it("keeps Gradle and Maven installable through Chocolatey and Scoop", () => {
    for (const name of ["Gradle", "Maven"]) {
      const tool = tools.find((t) => t["id"] === name);
      expect(tool, name).toBeTruthy();
      const managers = alt.managersFor(name);
      expect(managers.length, name).toBeGreaterThan(0);
    }
  });

  it("uses one KoboldCpp pin in the toolchain and in the runner list", () => {
    const runners = JSON.parse(read("config/local-runners.json"));
    const list = JSON.stringify(runners);
    const m = list.match(/koboldcpp\/releases\/download\/(v[\d.]+)\/koboldcpp\.exe/);
    expect(m).toBeTruthy();
    const source = read("electron/toolchain.cjs");
    expect(source).toContain(`koboldcpp/releases/download/${m![1]}/koboldcpp.exe`);
    expect(source).not.toContain("download/v1.123/");
    const sha = list.match(
      /"sha256":\s*"([0-9a-f]{64})"[^}]*\}[^]*?koboldcpp|koboldcpp[^]*?"sha256":\s*"([0-9a-f]{64})"/,
    );
    expect(sha).toBeTruthy();
  });

  it("does not read winget's 'no package found' code as success in the Windows setup", () => {
    const ps1 = read("scripts/setup-windows.ps1");
    const fn = ps1.slice(
      ps1.indexOf("function Install-WingetPackage"),
      ps1.indexOf("# ----", ps1.indexOf("function Install-WingetPackage")),
    );
    expect(fn).toMatch(/-eq -1978335212[\s\S]*throw/);
    expect(fn).not.toMatch(/-ne -1978335212/);
    expect(ps1).toContain("Git-*-64-bit.exe");
  });
});
