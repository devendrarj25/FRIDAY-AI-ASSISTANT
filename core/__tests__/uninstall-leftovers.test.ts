/**
 * An erase-all uninstall left an empty "<root>\App" on a hosted runner although no FRIDAY process was running. A
 * Python or Node worker whose executable lives outside the program folder (so a path check never saw it) can still
 * stand in that folder. The closer now also stops such workers, by the file in their command line, and never the
 * process that started it. These checks read the scripts; the Windows jobs run them.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(file, "utf8");

describe("closing FRIDAY before an uninstall", () => {
  const closer = read("installer/build/close-friday.ps1");

  it("also selects Python and Node started on a file inside the program folder", () => {
    expect(closer).toContain("$workerNames = @('python', 'pythonw', 'node')");
    expect(closer).toContain(
      "$Process.CommandLine.IndexOf($programPrefix, [StringComparison]::OrdinalIgnoreCase)",
    );
    expect(closer).toContain("(Test-FridayWorker $_)");
  });

  it("never selects the script, Setup or the uninstaller that started it", () => {
    expect(closer).toContain("function Get-AncestorIds");
    expect(closer).toContain("$ancestors.ContainsKey([int]$Process.ProcessId)");
  });

  it("keeps the old rule: the installed executable and everything under the program folder", () => {
    expect(closer).toContain("$fridayExe");
    expect(closer).toContain('StartsWith("$installRoot\\", [StringComparison]::OrdinalIgnoreCase)');
    expect(closer).toContain("'/T'");
  });

  it("is plain ASCII for powershell.exe", () => {
    expect([...Buffer.from(closer)].filter((byte) => byte > 127)).toEqual([]);
    expect(
      [...Buffer.from(read("scripts/windows-installer-smoke.ps1"))].filter((byte) => byte > 127),
    ).toEqual([]);
  });
});

describe("the installer smoke test explains a folder left behind", () => {
  it("names every process that mentions the folder, not only the ones started from it", () => {
    const smoke = read("scripts/windows-installer-smoke.ps1");
    expect(smoke).toContain("mentions the folder:");
    expect(smoke).toContain("by hand: removing");
    expect(smoke).toContain("    process: $($proc.Name) pid");
    expect(smoke).toContain("Erase-all uninstall left the FRIDAY folder behind");
  });
});

describe("the uninstall contract stays", () => {
  it("still sweeps the program folder and the root with a helper that stands in the temp folder", () => {
    const nsh = read("installer/build/installer.nsh");
    expect(nsh).toContain('SetOutPath "$TEMP"');
    expect(nsh).toContain("rd /s /q");
    expect(nsh).toContain('Nothing of FRIDAY survives a "delete" uninstall.');
  });
});
