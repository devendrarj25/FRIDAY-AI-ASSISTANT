/**
 * Uninstall keeps the data by default and erases it only on an explicit request:
 * the ticked box plus a second YES in the wizard, or `/S /DELETEDATA` from a
 * script. These read the installer script and the smoke script as text.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const nsh = readFileSync(path.join(root, "installer/build/installer.nsh"), "utf8");
const smoke = readFileSync(path.join(root, "scripts/windows-installer-smoke.ps1"), "utf8");

describe("silent uninstall data contract", () => {
  const init = nsh.slice(
    nsh.indexOf("!macro customUnInit"),
    nsh.indexOf("!macroend", nsh.indexOf("!macro customUnInit")),
  );

  it("keeps the data first and erases only for /S together with /DELETEDATA", () => {
    expect(init.indexOf('StrCpy $FridayUnMode "keep"')).toBeGreaterThan(-1);
    expect(init.indexOf('StrCpy $FridayUnMode "keep"')).toBeLessThan(
      init.indexOf('StrCpy $FridayUnMode "delete"'),
    );
    const silent = init.indexOf("${If} ${Silent}");
    expect(silent).toBeGreaterThan(-1);
    expect(init.indexOf("Call un.FridayDetectDeleteSwitch")).toBeGreaterThan(silent);
    expect(init.indexOf('StrCpy $FridayUnMode "delete"')).toBeGreaterThan(silent);
  });

  it("scans the command line for exactly /DELETEDATA, in either case", () => {
    expect(nsh).toContain('StrCpy $R1 "$CMDLINE" 11 $R0');
    expect(nsh).toContain('StrCmp $R1 "/DELETEDATA" friday_del_found');
    expect(nsh).toContain('StrCmp $R1 "/deletedata" friday_del_found');
    expect("/DELETEDATA".length).toBe(11);
  });

  it("does not let the wizard page undo a silent decision: the page's Pre function leaves first", () => {
    // NSIS calls a page's Pre function even in a silent uninstall. The page resets the mode to
    // "keep", which turned every scripted /DELETEDATA into a keep-uninstall (seen on a Windows runner).
    const pre = nsh.slice(
      nsh.indexOf("Function un.FridayDataPagePre"),
      nsh.indexOf("FunctionEnd", nsh.indexOf("Function un.FridayDataPagePre")),
    );
    const silentExit = pre.indexOf("${If} ${Silent}");
    expect(silentExit).toBeGreaterThan(-1);
    expect(pre.indexOf("Abort", silentExit)).toBeGreaterThan(silentExit);
    for (const touch of [
      'StrCpy $FridayUnMode "keep"',
      "ReadRegStr $FridayUnRoot",
      "nsDialogs::Create",
    ]) {
      expect(pre.indexOf(touch), touch).toBeGreaterThan(pre.indexOf("Abort", silentExit));
    }
  });

  it("sweeps what the uninstaller cannot delete itself, retrying and reaching long paths", () => {
    const sweep = nsh.split("\n").find((line) => line.includes("Start-Sleep -Seconds 6")) ?? "";
    expect(sweep).toContain("nsExec::Exec");
    expect(sweep).toContain("for ($$n = 0; $$n -lt 45; $$n++)");
    expect(sweep).toContain("rd /s /q");
    expect(sweep).toContain("\\\\?\\");
    expect(sweep).toContain("Remove-Item -LiteralPath $$p -Recurse -Force");
    // The program folder goes first, then the root that held it.
    expect(sweep.indexOf("$INSTDIR")).toBeLessThan(sweep.indexOf("$FridayUnRoot"));
    // Every PowerShell variable is doubled, because a single $ starts an NSIS variable.
    expect(sweep).not.toMatch(/[^$]\$[a-z_]/);
  });

  it("moves the sweeper out of the folder it deletes, so no handle keeps the program folder alive", () => {
    // A real runner left an empty "<root>\\App" behind for minutes: the helper inherited the
    // uninstaller's current directory, which was that folder.
    const at = nsh.indexOf("nsExec::Exec 'cmd.exe /c start");
    const before = nsh.slice(0, at);
    expect(before.trimEnd().endsWith('SetOutPath "$TEMP"')).toBe(true);
    const sweep = nsh.split("\n").find((line) => line.includes("Start-Sleep -Seconds 6")) ?? "";
    expect(sweep.indexOf("Set-Location -LiteralPath $$env:TEMP")).toBeGreaterThan(-1);
    expect(sweep.indexOf("[Environment]::CurrentDirectory = $$env:TEMP")).toBeGreaterThan(-1);
    expect(sweep.indexOf("[Environment]::CurrentDirectory")).toBeLessThan(
      sweep.indexOf("Start-Sleep"),
    );
  });

  it("never erases for the Test product, which shares the production root", () => {
    expect(init).toContain('"${PRODUCT_NAME}" != "FRIDAY Test"');
  });

  it("proves the opposite for the TEST product, whose uninstaller must never erase the shared data", () => {
    // FRIDAY Test Build run 40153379155 expected an erase-all from the TEST
    // uninstaller, which ignores /DELETEDATA by design, and failed.
    const eraseAll = smoke.slice(
      smoke.indexOf("function Invoke-EraseAll"),
      smoke.indexOf("function Get-Note"),
    );
    expect(eraseAll).toContain('$Product -eq "FRIDAY Test"');
    const testBranch = eraseAll.slice(
      eraseAll.indexOf('$Product -eq "FRIDAY Test"'),
      eraseAll.indexOf("Erase-all uninstall left the FRIDAY folder behind"),
    );
    expect(testBranch).toContain('"/S", "/DELETEDATA"');
    expect(testBranch).toContain("must never");
    expect(testBranch).toContain("Assert-DataIntact");
    expect(testBranch).toContain("return");
    expect(testBranch).not.toContain("Erase-all uninstall left");
  });

  it("declares the helper only in the uninstaller pass, so the installer pass has no unused function", () => {
    const at = nsh.indexOf("Function un.FridayDetectDeleteSwitch");
    const before = nsh.slice(0, at);
    expect(before.lastIndexOf("!ifdef BUILD_UNINSTALLER")).toBeGreaterThan(
      before.lastIndexOf("!endif"),
    );
  });

  it("is exercised by the smoke test on a throwaway runner, and skipped on the owner's own PC", () => {
    expect(smoke).toContain('"/S", "/DELETEDATA"');
    expect(smoke).toMatch(/\$env:CI -or \$env:GITHUB_ACTIONS -or \$env:FRIDAY_SMOKE_ERASE -eq "1"/);
    expect(smoke).toContain("SKIP erase-all uninstall on this PC");
    expect(smoke).toContain("Erase-all uninstall left the FRIDAY folder behind");
    // On a failure the log says what was left and whether /DELETEDATA was honoured.
    expect(smoke).toContain("/DELETEDATA was not honoured");
    expect(smoke).toContain("left: $_");
    expect(smoke.indexOf('"/DELETEDATA"')).toBeLessThan(smoke.indexOf("PASS installer -> boot"));
  });
});
