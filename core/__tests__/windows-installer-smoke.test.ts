/**
 * Pins the local installer-smoke path. GitHub sets RUNNER_TEMP. A PC does not.
 * PowerShell 7.6 Join-Path rejects a null Path, which is the pack failure
 * "Cannot bind argument to parameter 'Path' because it is null."
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..", "..");
const smoke = fs.readFileSync(path.join(root, "scripts/windows-installer-smoke.ps1"), "utf8");

describe("windows installer smoke", () => {
  it("stays 7-bit ASCII so Windows PowerShell 5.1 can parse it", () => {
    const high = [
      ...fs.readFileSync(path.join(root, "scripts/windows-installer-smoke.ps1")),
    ].filter((byte) => byte > 127);
    expect(high).toEqual([]);
  });

  it("defaults the Setup EXE from the repo and never joins a null RUNNER_TEMP", () => {
    expect(smoke).toContain("Set-StrictMode -Version Latest");
    expect(smoke).toContain('[string]$Installer = ""');
    expect(smoke).toContain('[string]$Product = "FRIDAY"');
    expect(smoke).toContain('[string]$ReleaseDir = ""');
    expect(smoke).toContain("config\\friday-version.json");
    expect(smoke).toContain("FRIDAY-Setup-");
    expect(smoke).toContain("release\\FRIDAY-Setup-<public version>.exe");
    expect(smoke).toContain("$env:RUNNER_TEMP");
    expect(smoke).toContain("[IO.Path]::GetTempPath()");
    expect(smoke).not.toContain("Join-Path $env:RUNNER_TEMP");
    expect(smoke).toContain("installer smoke found no Setup EXE. Expected");
    expect(smoke).toContain("installer smoke has no temp directory");
    expect(smoke).toContain('ArgumentList @("/S"');
    expect(smoke).toContain("Remove-Item -LiteralPath $sandbox");
    expect(smoke).toContain("[friday] FAIL installer smoke:");
    expect(smoke).toContain(
      "[friday] PASS installer -> boot -> reinstall -> boot -> uninstall; data preserved",
    );
    expect(smoke).toContain("--friday-boot-selftest");
    expect(smoke).toContain("--friday-workspace=$rootDir");
    expect(smoke).toContain("$env:FRIDAY_WORKSPACE_ROOT = $rootDir");
    expect(smoke).toContain("(main.log missing at $mainLog)");
    expect(smoke).toContain("logs\\boot-selftest.txt");
    expect(smoke).toContain("(boot-selftest.txt missing at $markerPath)");
    expect(smoke).toContain("Remove-Item -LiteralPath $markerPath -Force");
    const passAt = smoke.indexOf("[friday] PASS installer");
    const failExit = smoke.indexOf("if ($null -ne $smokeError) { exit 1 }");
    expect(passAt).toBeGreaterThan(-1);
    expect(failExit).toBeGreaterThan(passAt);
  });

  it("keeps the CI parameters the pipeline already passes", () => {
    const pipeline = fs.readFileSync(path.join(root, "scripts/build-pipeline.cjs"), "utf8");
    expect(pipeline).toContain('"-Installer"');
    expect(pipeline).toContain('"-Product"');
    expect(pipeline).toContain('"-ReleaseDir"');
    expect(pipeline).toContain("windows-installer-smoke.ps1");
  });
});
