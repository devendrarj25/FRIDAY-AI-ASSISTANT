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
    // The program folder is the first of the folders the script releases, and a path under any of them counts.
    expect(closer).toContain("$roots = @($installRoot)");
    expect(closer).toContain('StartsWith("$root\\", [StringComparison]::OrdinalIgnoreCase)');
    expect(closer).toContain("Test-UnderRoots $_.ExecutablePath");
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

describe("what the speech probe starts must not outlive or hold the program folder", () => {
  it("asks which recognisers are installed instead of creating the shared Windows recogniser", () => {
    const stt = read("kernel/stt.py");
    const probe = stt.slice(
      stt.indexOf("WINDOWS_SPEECH_PROBE = ("),
      stt.indexOf("_windows_speech: bool"),
    );
    expect(probe).toContain("SpeechRecognitionEngine]::InstalledRecognizers()");
    expect(probe).not.toContain("New-Object System.Speech.Recognition.SpeechRecognizer");
  });

  it("starts the speech worker and its helpers outside the program folder", () => {
    const stt = read("electron/stt.cjs");
    // the one-shot runs name the temp folder; the long-lived worker starts through the module, which defaults to it
    expect(stt).toContain("cwd: os.tmpdir(),");
    expect(stt).toContain('require("./voice-worker.cjs")');
    expect(stt).not.toMatch(/createVoiceWorker\(\{[\s\S]{0,900}?\bcwd:/);
    expect(read("electron/voice-worker.cjs")).toContain("cwd: opts.cwd || os.tmpdir(),");
  });
});

describe("the registry values are removed before their key is tried, for both products", () => {
  const nsh = read("installer/build/installer.nsh").replace(/\r\n/g, "\n");
  const body = nsh.slice(
    nsh.indexOf("!macro customUnInstall"),
    nsh.indexOf("!macroend", nsh.indexOf("!macro customUnInstall")),
  );

  it("FRIDAY: every value goes before DeleteRegKey /ifempty, so a real uninstall leaves no empty key", () => {
    const keep = body.slice(body.indexOf("Keeping the FRIDAY data folder and its pointer"));
    const ifempty = keep.indexOf('DeleteRegKey /ifempty HKCU "Software\\FRIDAY"');
    expect(ifempty).toBeGreaterThan(-1);
    for (const value of [
      "InstallPath",
      "PythonSetupPending",
      "LastInstallMode",
      "InstallSourceDir",
      "DataMoveNote",
      "DataMoveFrom",
    ]) {
      const at = keep.indexOf(`DeleteRegValue HKCU "Software\\FRIDAY" "${value}"`);
      expect(at, value).toBeGreaterThan(-1);
      expect(at, value).toBeLessThan(ifempty);
    }
    // The pointer to the data is the one value a keep-uninstall never removes.
    expect(keep.slice(0, keep.indexOf("; Application-only leftovers"))).not.toContain(
      '"WorkspacePath"',
    );
    // An update's uninstaller keeps the folder Setup came from.
    const source = keep.indexOf('"InstallSourceDir"');
    expect(keep.lastIndexOf("${IfNot} ${isUpdated}", source)).toBeGreaterThan(
      keep.indexOf("Keeping"),
    );
  });

  it("FRIDAY Test: its own key only, the source folder removed first, an update keeps the source folder", () => {
    const from = body.indexOf('${If} "${PRODUCT_NAME}" == "FRIDAY Test"');
    const last = 'DeleteRegKey HKCU "Software\\FRIDAY Test"';
    const test = body.slice(from, body.indexOf(last, from) + last.length);
    expect(test).toContain("Software\\FRIDAY Test");
    expect(test).not.toMatch(/HKCU "Software\\FRIDAY" /);
    const source = test.indexOf('DeleteRegValue HKCU "Software\\FRIDAY Test" "InstallSourceDir"');
    expect(source).toBeGreaterThan(-1);
    expect(source).toBeLessThan(test.indexOf('DeleteRegKey HKCU "Software\\FRIDAY Test"'));
    // The update branch removes the other values one by one and only an empty key, so the source folder survives.
    const updated = test.slice(test.indexOf("${If} ${isUpdated}"), source);
    expect(updated).toContain('DeleteRegKey /ifempty HKCU "Software\\FRIDAY Test"');
    expect(updated).not.toContain('"InstallSourceDir"');
    for (const value of ["InstallPath", "PythonSetupPending", "LastInstallMode"])
      expect(updated.indexOf(`"${value}"`), value).toBeGreaterThan(-1);
  });
});
