/**
 * The folder setup and `build:win` run in is the FRIDAY folder, so the FRIDAY folder can be a Git checkout of the
 * source. "Delete all FRIDAY data" used to remove the whole folder, which would have deleted the owner's code, Git
 * history and build output with it. The uninstaller now detects a source checkout and removes only FRIDAY's own data.
 * Text-level checks on the NSIS script and its PowerShell helper (no NSIS or PowerShell runs here), plus the lists the
 * helper carries, pinned to the contract they copy.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const nsh = read("installer/build/installer.nsh");
const ps1 = read("installer/build/remove-source-root-data.ps1");
const contract = require_("../../electron/friday-contract.cjs") as {
  OWNERSHIP: { data: string[]; program: string[] };
};

const WHOLE_FOLDER = ["RMDir", "/r", '"$FridayUnRoot"'].join(" ");

function listIn(name: string): string[] {
  const match = new RegExp(`\\$${name} = @\\(([^)]*)\\)`).exec(ps1);
  expect(match, name).toBeTruthy();
  return [...match![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe("uninstall never deletes a source checkout used as the FRIDAY folder unless the owner asks for it", () => {
  it("whole-folder removal is reachable only when the folder is not a source checkout, or the owner chose complete removal", () => {
    const remove = nsh.indexOf(WHOLE_FOLDER);
    expect(remove).toBeGreaterThan(-1);
    expect(nsh.indexOf(WHOLE_FOLDER, remove + 1)).toBe(-1);
    const before = nsh.slice(nsh.lastIndexOf("Call un.FridayDetectSource", remove), remove);
    expect(before).toContain('${If} $FridayUnSource == "1"');
    // A checkout is kept unless the owner's own choice (set only after the second confirmation) says otherwise.
    expect(before).toContain('${AndIf} $FridayUnWipeSource != "1"');
    expect(before).toContain("remove-source-root-data.ps1");
    expect(before).toContain("${Else}");
  });

  it("only the confirmed page choice can wipe a checkout; a silent uninstall and an unset value never do", () => {
    const wipeSets = nsh.match(/StrCpy \$FridayUnWipeSource "1"/g) ?? [];
    expect(wipeSets).toHaveLength(1);
    const leave = nsh.slice(
      nsh.indexOf("Function un.FridayDataPageLeave"),
      nsh.indexOf("FunctionEnd", nsh.indexOf("Function un.FridayDataPageLeave")),
    );
    // The only place that sets it sits behind the "Delete the whole folder?" question, after the Abort of a No.
    expect(leave.indexOf('StrCpy $FridayUnWipeSource "1"')).toBeGreaterThan(leave.indexOf("Abort"));
    expect(leave).toContain("IDYES friday_confirm_wipe");
    expect(leave).toContain("friday_confirm_wipe:");
    // Every other start is "0": the silent path (customUnInit), the page's Pre and Leave.
    const init = nsh.slice(
      nsh.indexOf("!macro customUnInit"),
      nsh.indexOf("!macroend", nsh.indexOf("!macro customUnInit")),
    );
    expect(init).toContain('StrCpy $FridayUnWipeSource "0"');
    expect(leave).toContain('StrCpy $FridayUnWipeSource "0"');
    // The checkbox that keeps the code is offered only for a checkout and starts unticked.
    expect(nsh).toContain("...but keep my source code, Git history and build output in it");
    expect(nsh).toMatch(/\$\{NSD_SetState\} \$FridayUnKeepSource \$\{BST_UNCHECKED\}/);
  });

  it("the detached sweeper that runs after the uninstaller exits also spares a source checkout", () => {
    const sweeper = nsh
      .split("\n")
      .filter((line) => line.includes("nsExec::Exec 'cmd.exe /c start"));
    expect(sweeper).toHaveLength(1);
    const at = nsh.indexOf(sweeper[0]!);
    const before = nsh.slice(nsh.lastIndexOf("Call un.FridayDetectSource", at), at);
    // In a source checkout the root entry is emptied first; the sweeper skips an empty entry (Where-Object { $$_ }).
    expect(before).toContain('${If} $FridayUnSource == "1"');
    expect(before).toContain('${AndIf} $FridayUnWipeSource != "1"');
    expect(before).toContain('StrCpy $FridayUnRoot ""');
    expect(sweeper[0]).toContain("Where-Object { $$_ }");
  });

  it("recognises a checkout by its .git folder or its build script", () => {
    const start = nsh.indexOf("Function un.FridayDetectSource");
    const fn = nsh.slice(start, nsh.indexOf("FunctionEnd", start));
    expect(fn).toContain('"$FridayUnRoot\\.git"');
    expect(fn).toContain('"$FridayUnRoot\\scripts\\build-windows.cmd"');
  });

  it("says so on the uninstall page and in both confirmations", () => {
    // Keep the code: the data-only question.
    expect(nsh).toContain("Your source code and Git history in that folder are not touched.");
    // Complete removal: the question names the code, the history and the build output, and tells what to close.
    expect(nsh).toContain("AND the source code, Git history and build output in that folder.");
    expect(nsh).toContain("Close any command window or editor that is open inside it first.");
    expect(nsh).toContain("Delete the whole folder?");
  });

  it("runs the helper from the program's installer resources, and the helper refuses anything else", () => {
    expect(nsh).toContain("$INSTDIR\\resources\\installer\\build\\remove-source-root-data.ps1");
    expect(ps1).toMatch(/\.git/);
    expect(ps1).toMatch(/scripts\\build-windows\.cmd/);
    expect(ps1).toMatch(/\$full\.Length -le 3 -or -not \$isSource\) \{ exit 2 \}/);
  });

  it("removes exactly the data folders of the ownership contract, and never a program folder", () => {
    const all = listIn("dataFolders");
    const folders = all.filter((name) => name !== ".friday-dev");
    expect([...folders].sort()).toEqual([...contract.OWNERSHIP.data].sort());
    for (const program of contract.OWNERSHIP.program) {
      expect(all, program).not.toContain(program);
    }
    for (const never of [
      "src",
      "kernel",
      "electron",
      "scripts",
      "docs",
      "node_modules",
      ".git",
      "release",
      "installer",
    ]) {
      expect(all, never).not.toContain(never);
    }
  });

  it("removes the owner's config state files that git and the installer already treat as private", () => {
    const state = listIn("configState");
    const ignore = read(".gitignore");
    for (const file of state) expect(ignore, file).toContain(`/config/${file}`);
    const builder = read("electron-builder.yml");
    for (const file of state) expect(builder, file).toContain(`"!${file}"`);
  });

  it("leaves the tracked .gitkeep files so the checkout keeps the layout it commits", () => {
    expect(ps1).toContain("'.gitkeep'");
    expect(ps1).toMatch(/-Include \$weightPatterns/);
  });

  it("is plain ASCII with CRLF line ends, like the other installer helpers", () => {
    expect(/[^\x00-\x7F]/.test(ps1)).toBe(false);
    expect(ps1.replace(/\r\n/g, "").includes("\n")).toBe(false);
  });
});

describe("the installed runtime reuses the FRIDAY folder's Python environment", () => {
  const repair = read("installer/build/repair-runtime.ps1");

  it("repairs, reuses and builds <root>\\runtime\\.venv, so an update finds it and does not download it again", () => {
    expect(repair).toContain("(Split-Path -Leaf $InstallDir) -ieq 'App'");
    expect(repair).toContain("Join-Path (Split-Path -Parent $InstallDir) 'runtime'");
    const reuse = repair.indexOf("$rootVenv");
    expect(reuse).toBeGreaterThan(-1);
    // The choice is made before the health check and before anything is built.
    expect(reuse).toBeLessThan(repair.indexOf("function Test-Runtime"));
    expect(reuse).toBeLessThan(repair.indexOf("& $basePython -m venv $venvDir"));
    // It no longer depends on setup having made the environment first: the program folder is replaced by every update.
    const choice = repair.slice(
      repair.indexOf("if ((Split-Path -Leaf $InstallDir)"),
      repair.indexOf("function Finish("),
    );
    expect(choice).not.toContain("Test-Path");
    expect(choice).toContain("$venvDir = $rootVenv");
  });

  it("keeps the program folder's environment as the fallback and stays plain ASCII with CRLF", () => {
    expect(repair).toContain("$runtimeDir = Join-Path $InstallDir 'runtime'");
    expect(/[^\x00-\x7F]/.test(repair)).toBe(false);
    expect(repair.replace(/\r\n/g, "").includes("\n")).toBe(false);
  });
});

describe("the installer and uninstaller never treat a whole drive as the FRIDAY folder", () => {
  it("Setup refuses a drive root on the folder page and for /D=, and keeps one spelling of the folder", () => {
    const leave = nsh.slice(
      nsh.indexOf("Function FridayRootPageLeave"),
      nsh.indexOf("FunctionEnd", nsh.indexOf("Function FridayRootPageLeave")),
    );
    expect(leave).toContain("${If} $1 < 4");
    expect(leave).toContain("not a whole drive");
    // A trailing backslash is dropped (only above a drive root), before the checks that follow.
    expect(leave.indexOf('StrCpy $FridayRoot "$FridayRoot" -1')).toBeGreaterThan(-1);
    expect(leave.indexOf('StrCpy $FridayRoot "$FridayRoot" -1')).toBeLessThan(
      leave.indexOf("!insertmacro FridayRejectProtected"),
    );
    const init = nsh.slice(
      nsh.indexOf("!macro customInit"),
      nsh.indexOf("!macroend", nsh.indexOf("!macro customInit")),
    );
    expect(init).toContain("${If} $1 < 4");
    expect(init.indexOf("${If} $1 < 4")).toBeLessThan(
      init.indexOf('StrCpy $INSTDIR "$FridayRoot\\App"'),
    );
  });

  it("the uninstaller empties the root of a drive-root pointer before anything is stopped or deleted", () => {
    const body = nsh.slice(
      nsh.indexOf("!macro customUnInstall"),
      nsh.indexOf("!macroend", nsh.indexOf("!macro customUnInstall")),
    );
    const guard = body.indexOf('StrLen $0 "$FridayUnRoot"');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf("close-friday.ps1"));
    expect(guard).toBeLessThan(body.indexOf(WHOLE_FOLDER));
    expect(body.slice(guard, guard + 400)).toContain('StrCpy $FridayUnRoot ""');
  });
});

describe("the installed-runtime helpers", () => {
  const python = read("installer/build/install-python.ps1");
  const repair = read("installer/build/repair-runtime.ps1");

  it("runs a downloaded Python installer only when the Python Software Foundation signed it", () => {
    expect(python).toContain("Get-AuthenticodeSignature -LiteralPath $file");
    expect(python).toContain("Python Software Foundation");
    const check = python.indexOf("if (-not (Test-PythonInstallerSignature $file))");
    expect(check).toBeGreaterThan(-1);
    // The check sits between the download and the silent run, and a refused file is deleted.
    expect(check).toBeLessThan(python.indexOf("Start-Process -FilePath $file"));
    expect(check).toBeGreaterThan(python.indexOf("$downloaded = $true"));
    expect(python.slice(check, check + 400)).toContain("Remove-Item -LiteralPath $file");
  });

  it("rebuilds the environment only when its check fails twice", () => {
    expect(repair).toContain("function Test-RuntimeTwice");
    expect(repair).toMatch(/if \(Test-RuntimeTwice\) \{\r?\n {2}Install-VoiceCore/);
  });
});
