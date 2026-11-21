/**
 * The Setup EXE's install, reinstall and update, read from the installer script and driven where a test can:
 * the registry pointer to the FRIDAY folder moves only when files are really installed (a cancelled Setup must not
 * move an installed FRIDAY onto an empty folder), the Python environment is built in the FRIDAY folder where an
 * update finds it again, a OneDrive folder is questioned once, and an update's installer is checksummed without
 * holding the window.
 */
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

const safety = require_("../../electron/update-safety.cjs") as {
  sha256Async: (file: string) => Promise<string>;
  verifyArtifact: (o: Record<string, unknown>) => Record<string, unknown>;
  verifyArtifactAsync: (o: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

describe("the installer script", () => {
  const nsh = read("installer/build/installer.nsh");
  const leave = nsh.slice(
    nsh.indexOf("Function FridayRootPageLeave"),
    nsh.indexOf("!macro customInstall"),
  );
  const install = nsh.slice(nsh.indexOf("!macro customInstall"), nsh.indexOf("runtime_done:"));

  it("writes the FRIDAY folder pointer when files are installed, not when the folder page is left", () => {
    expect(leave).not.toContain("WriteRegStr");
    expect(leave).toContain('StrCpy $INSTDIR "$FridayRoot\\App"');
    expect(install).toContain('WriteRegStr HKCU "Software\\FRIDAY" "WorkspacePath" "$FridayRoot"');
  });

  it("asks once before using a OneDrive folder, with No as the default", () => {
    expect(nsh).toContain("!macro FridayWarnSynced Prefix Label");
    expect(nsh).toContain('!insertmacro FridayWarnSynced "$PROFILE\\OneDrive" "OneDrive"');
    const macro = nsh.slice(
      nsh.indexOf("!macro FridayWarnSynced"),
      nsh.indexOf("Function FridayRootPageLeave"),
    );
    expect(macro).toContain("MB_DEFBUTTON2");
    expect(macro).toContain("IDYES +2");
    expect(macro).toContain("Abort");
    // It runs in the interactive page only, after the protected folders are refused.
    expect(leave.indexOf("FridayRejectProtected")).toBeLessThan(leave.indexOf("FridayWarnSynced"));
  });
});

describe("the Python environment an update finds again", () => {
  it("is built in <root>\\runtime\\.venv, which an update and a normal uninstall do not remove", () => {
    const repair = read("installer/build/repair-runtime.ps1");
    expect(repair).toContain("$venvDir = $rootVenv");
    // The program folder's runtime\\ is removed with the program at every update and uninstall.
    expect(read("installer/build/installer.nsh")).toContain('RMDir /r "$INSTDIR\\runtime"');
    const contract = read("docs/FRIDAY_STORAGE_CONTRACT.md");
    expect(contract).toContain("runtime\\.venv");
  });
});

describe("an update's installer is checksummed in chunks", () => {
  const made: string[] = [];
  afterEach(() => {
    while (made.length) fs.rmSync(made.pop()!, { recursive: true, force: true });
  });
  const installer = (bytes = 1_200_000) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-update-"));
    made.push(dir);
    const file = path.join(dir, "FRIDAY-Setup-1.1.5.8.exe");
    fs.writeFileSync(file, crypto.randomBytes(bytes));
    return { file, sha: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
  };

  it("gives the same digest as the synchronous check and accepts the published checksum", async () => {
    const { file, sha } = installer();
    expect(await safety.sha256Async(file)).toBe(sha);
    const out = await safety.verifyArtifactAsync({
      file,
      expected: sha,
      version: "1.1.5.8",
      currentVersion: "1.1.5.7",
    });
    expect(out).toMatchObject({ ok: true, sha256: sha, verified: true });
    expect(
      safety.verifyArtifact({ file, expected: sha, version: "1.1.5.8", currentVersion: "1.1.5.7" }),
    ).toMatchObject({
      ok: true,
      sha256: sha,
    });
  });

  it("refuses a wrong checksum, a file that is too small, a missing file and a version that is not newer", async () => {
    const { file, sha } = installer();
    expect(await safety.verifyArtifactAsync({ file, expected: "0".repeat(64) })).toMatchObject({
      ok: false,
    });
    expect(
      await safety.verifyArtifactAsync({
        file,
        expected: sha,
        version: "1.1.5.7",
        currentVersion: "1.1.5.7",
      }),
    ).toMatchObject({ ok: false });
    expect(await safety.verifyArtifactAsync({ file: `${file}.gone` })).toMatchObject({ ok: false });
    const small = installer(2048);
    expect(
      await safety.verifyArtifactAsync({ file: small.file, expected: small.sha }),
    ).toMatchObject({
      ok: false,
    });
  });

  it("the update handler uses it", () => {
    expect(read("electron/main.cjs")).toContain("await updateSafety.verifyArtifactAsync({");
  });
});
