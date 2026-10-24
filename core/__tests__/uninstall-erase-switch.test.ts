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

  it("never erases for the Test product, which shares the production root", () => {
    expect(init).toContain('"${PRODUCT_NAME}" != "FRIDAY Test"');
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
    expect(smoke.indexOf('"/DELETEDATA"')).toBeLessThan(smoke.indexOf("PASS installer -> boot"));
  });
});
