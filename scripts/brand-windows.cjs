/**
 * Brand the unpacked FRIDAY executable without electron-builder's winCodeSign
 * archive. This runs after packaging and uses the local rcedit npm package.
 *
 * `signAndEditExecutable: false` in electron-builder.yml disables the whole
 * "sign and edit resources" phase — and that phase is also where
 * electron-builder renames electron.exe to the product executable. Without the
 * rename the packaged app ships as electron.exe (Windows shows it as
 * "Electron"), the NSIS shortcuts point at a missing FRIDAY.exe and rcedit
 * below fails with ENOENT. The rename therefore happens here, on every host, so
 * Windows and cross-host builds produce the exact same layout.
 */
const fs = require("node:fs");
const path = require("node:path");
const IDENTITY = require("./identity.cjs");

module.exports = async function brandWindows(context) {
  if (context.electronPlatformName !== "win32") return;

  const executable = path.join(context.appOutDir, "FRIDAY.exe");
  const packaged = path.join(context.appOutDir, "electron.exe");
  if (!fs.existsSync(executable)) {
    if (!fs.existsSync(packaged)) {
      throw new Error(`[friday] packaged executable not found in ${context.appOutDir}`);
    }
    fs.renameSync(packaged, executable);
    console.log("[friday] renamed electron.exe -> FRIDAY.exe");
  } else if (fs.existsSync(packaged)) {
    // A leftover electron.exe from an earlier partial build must never ship.
    fs.rmSync(packaged, { force: true });
  }

  // Resource editing needs Windows. On other hosts the rename above still
  // guarantees a correctly named executable for the installer and shortcuts.
  if (process.platform !== "win32") {
    console.log("[friday] resource branding skipped (requires a Windows host)");
    return;
  }

  const icon = path.resolve(context.packager.projectDir, "installer", "build", "icon.ico");
  // rcedit 5 is ESM and exports a named function. The module namespace itself
  // is not callable, which is what made Windows packaging throw
  // "rcedit is not a function".
  const imported = await import("rcedit");
  const rcedit =
    typeof imported.rcedit === "function"
      ? imported.rcedit
      : typeof imported.default === "function"
        ? imported.default
        : null;
  if (typeof rcedit !== "function") {
    throw new Error("[friday] the rcedit package did not export a function");
  }
  const engine = require("./release-engine.cjs");
  const identity = engine.readCanonicalIdentity({
    root: context.packager.projectDir,
  });
  if (!identity?.releaseVersion) {
    throw new Error("[friday] canonical config/friday-version.json is missing; refusing to brand");
  }
  const fileVersion = identity.windowsFileVersion;
  const productVersion = identity.releaseVersion;
  const test = identity.channel === "test" || engine.isTestVersion(identity.releaseVersion);
  const productName = test ? IDENTITY.TEST_PRODUCT : IDENTITY.PRODUCT;
  const versionString = IDENTITY.windowsResourceStamp({
    productName,
    fileVersion,
    productVersion,
  });

  await rcedit(executable, {
    icon,
    "file-version": fileVersion,
    // VS_FIXEDFILEINFO must be a.b.c.d. A TEST identity like 1.0.0.0-test.1
    // belongs in the ProductVersion string, not in the binary product-version.
    "product-version": fileVersion,
    // Keep the installed app at the same normal-user execution level declared
    // in electron-builder.yml. Elevation belongs to the installer or an
    // explicit repair action; stamping the Electron renderer as elevated can
    // break Windows TSF keyboard focus across every editable field.
    "requested-execution-level": "asInvoker",
    "version-string": versionString,
  });
  // rcedit applies --set-file-version AFTER --set-version-string. On
  // windows-latest that overwrite left FileVersion as npm "1.0.0" while the
  // binary FILEVERSION and ProductVersion were already 1.0.0.0 (PR Validation
  // 33886667259). A second pass writes the string table only (no file-version)
  // so the public four-part FileVersion is what Windows and verify-build read.
  // The full table is sent again so a StringFileInfo rebuild cannot drop
  // ProductName / publisher.
  //
  // Registered as afterPack and afterSign. afterSign is required because
  // electron-builder 26 signAndEditResources runs after afterPack (and
  // signApp still returns true when signExecutable is false), so this is
  // the last write before NSIS/portable copy win-unpacked. Without it, TEST
  // FileVersion becomes "1.0.0-test.1" / FILEVERSION 1.0.0.1
  // (Test EXE Build 33901573538).
  await rcedit(executable, {
    "version-string": versionString,
  });

  console.log(`[friday] branded ${executable} without winCodeSign`);
};
