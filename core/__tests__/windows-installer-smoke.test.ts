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
      "[friday] PASS installer -> boot -> reinstall -> silent update -> boot -> uninstall; data preserved",
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

  it("runs the silent in-place update FRIDAY itself uses, over an install, again while the app runs, and over the published release", () => {
    // Same switches as electron/update-safety.cjs installerLaunch.
    const safety = fs.readFileSync(path.join(root, "electron/update-safety.cjs"), "utf8");
    expect(safety).toContain('["/S", "--updated", "--force-run"]');
    const switches = '"/S", "--updated", "--force-run"';
    const all = [
      ...smoke.matchAll(new RegExp(switches.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")),
    ];
    // previous release -> this build, the update over a reinstall, and the update while FRIDAY runs
    expect(all.length).toBeGreaterThanOrEqual(3);
    const repair = smoke.indexOf("In-place repair");
    const afterRepair = smoke.slice(repair, smoke.indexOf("$uninstallHits = 0"));
    expect(afterRepair).toContain(switches);
    expect(afterRepair).toContain("silent update while FRIDAY is running");
    // Data and program survive; the app is closed again; the result still boots.
    expect(afterRepair).toContain("The silent update removed the FRIDAY data folder.");
    expect(afterRepair).toContain("The silent update left no FRIDAY.exe");
    expect(afterRepair).toContain("Assert-DataIntact");
    expect(afterRepair).toContain("Stop-InstalledApp");
    expect(afterRepair).toContain("Verify-Boot");
  });

  it("updates FROM the previously published installer and checks a file in every data folder", () => {
    expect(smoke).toContain("$env:FRIDAY_PREVIOUS_INSTALLER");
    expect(smoke).toContain("Updating the previously published FRIDAY");
    // The earlier release failing to install is not this build's fault; updating it is.
    expect(smoke).toContain("the update test is skipped");
    expect(smoke).toContain("update from the previously published release");
    for (const folder of [
      "memory\\permanent",
      "conversations\\history",
      "brain-data\\knowledge",
      "database",
      "models\\local",
      "voices",
      "downloads",
      "workflows\\saved",
      "agents\\custom",
      "skills\\custom",
      "plugins\\installed",
      "modules\\custom",
    ]) {
      expect(smoke, folder).toContain(`"${folder}"`);
    }
    for (const when of [
      "The first install",
      "Reinstall / repair",
      "The silent update",
      "The keep-uninstall",
    ]) {
      expect(smoke, when).toContain(`Assert-DataIntact "${when}`);
    }
  });

  it("writes every outcome of the update test to the job summary, so a skip is never silent", () => {
    expect(smoke).toContain("function Write-Summary");
    expect(smoke).toContain("GITHUB_STEP_SUMMARY");
    for (const outcome of [
      "Update test: PASSED",
      "Update test: SKIPPED, the previously published installer did not install",
      "Update test: SKIPPED, no earlier FRIDAY was installed",
      "Update test: SKIPPED, no previously published installer was provided",
    ]) {
      expect(smoke, outcome).toContain(outcome);
    }
    expect(smoke).toContain("::warning title=Update test::");
  });

  it("is fed the published installer by the update job of PR Validation, which also fetches it", () => {
    const pr = fs.readFileSync(path.join(root, ".github/workflows/pr-validation.yml"), "utf8");
    const job = pr.slice(pr.indexOf("\n  update-windows:\n"), pr.indexOf("\n  validate:\n"));
    expect(job).toContain(
      "gh release download --repo '${{ github.repository }}' --pattern 'FRIDAY-Setup-*.exe'",
    );
    expect(job).toContain("FRIDAY_PREVIOUS_INSTALLER: ${{ steps.previous.outputs.path }}");
    expect(job).toContain("FRIDAY_SMOKE_SCENARIO: update");
    // The lifecycle job never runs the update scenario, and the update job never the lifecycle.
    expect(pr).toContain("FRIDAY_SMOKE_SCENARIO: lifecycle");
    expect(smoke).toContain('if ($scenario -eq "lifecycle")');
    expect(smoke).toContain('if ($scenario -eq "update")');
    expect(smoke).toContain("FRIDAY_SMOKE_SCENARIO must be all, lifecycle or update");
  });

  it("splits the lifecycle so the two jobs take about the same time", () => {
    // The erase-all uninstall runs after the update test, not in the lifecycle job.
    expect(smoke).toContain("function Invoke-EraseAll");
    expect(smoke).toContain("erase-all uninstall: runs in the update job (scenario lifecycle)");
    const update = smoke.slice(smoke.indexOf('if ($scenario -eq "update") {'));
    expect(update.indexOf("PASS update scenario")).toBeGreaterThan(-1);
    expect(update.indexOf("Invoke-EraseAll")).toBeGreaterThan(
      update.indexOf("PASS update scenario"),
    );
  });

  it("keeps the CI parameters the pipeline already passes", () => {
    const pipeline = fs.readFileSync(path.join(root, "scripts/build-pipeline.cjs"), "utf8");
    expect(pipeline).toContain('"-Installer"');
    expect(pipeline).toContain('"-Product"');
    expect(pipeline).toContain('"-ReleaseDir"');
    expect(pipeline).toContain("windows-installer-smoke.ps1");
  });
});
