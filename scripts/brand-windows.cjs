/**
 * Brand the unpacked FRIDAY executable without electron-builder's winCodeSign
 * archive. This runs after packaging and edits the PE resources with the resedit npm package (pure
 * JavaScript, the editor Electron's own packager uses; the rcedit package it replaces is deprecated on npm
 * and shipped a native .exe).
 *
 * `signAndEditExecutable: false` in electron-builder.yml disables the whole
 * "sign and edit resources" phase — and that phase is also where
 * electron-builder renames electron.exe to the product executable. Without the
 * rename the packaged app ships as electron.exe (Windows shows it as
 * "Electron"), the NSIS shortcuts point at a missing FRIDAY.exe and the
 * resource edit below fails with ENOENT. The rename therefore happens here, on every host, so
 * Windows and cross-host builds produce the exact same layout.
 */
const fs = require("node:fs");
const path = require("node:path");
const IDENTITY = require("./identity.cjs");

const LANG_EN_US = 1033;
const CODEPAGE_UNICODE = 1200;
const RT_MANIFEST = 24;

/** "1.2.3.4" -> [1, 2, 3, 4]; anything that is not a four-part number is refused. */
function fourParts(version) {
  const parts = String(version).split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 65535)) {
    throw new Error(`[friday] "${version}" is not a four-part Windows file version`);
  }
  return parts;
}

/** Set requestedExecutionLevel in the embedded manifest, adding the block when the manifest has none. */
function withExecutionLevel(manifestXml, level) {
  const element = `<requestedExecutionLevel level="${level}" uiAccess="false"/>`;
  if (/<requestedExecutionLevel\b[^>]*>/.test(manifestXml)) {
    return manifestXml.replace(
      /<requestedExecutionLevel\b[^>]*?(\/>|>[\s\S]*?<\/requestedExecutionLevel>)/,
      element,
    );
  }
  const trust = `<trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges>${element}</requestedPrivileges></security></trustInfo>`;
  if (/<\/assembly>/.test(manifestXml))
    return manifestXml.replace(/<\/assembly>/, `${trust}</assembly>`);
  throw new Error("[friday] the executable manifest has no <assembly> element to edit");
}

/**
 * Write the icon, the four-part file and product version, the version string table and the normal-user execution
 * level into a Windows executable, in one pass. Pure JavaScript, so it runs the same on every host (and in tests).
 *
 * The previous editor applied the file version after the string table and overwrote FileVersion, so it needed a
 * second pass (PR Validation 33886667259 and the test build 33901573538); here the string table is written last,
 * once, and the numeric versions and the strings cannot disagree.
 *
 * @param {string} file the executable to edit in place
 * @param {{ icon: string, fileVersion: string, versionString: Record<string,string>, executionLevel?: string }} options
 */
async function stampExecutable(
  file,
  { icon, fileVersion, versionString, executionLevel = "asInvoker" },
) {
  const [major, minor, build, revision] = fourParts(fileVersion);
  const ResEdit = await import("resedit");
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(file));
  const resources = ResEdit.NtExecutableResource.from(exe);

  // Version info: keep the language the executable already has; a file with none gets English (United States).
  const existing = ResEdit.Resource.VersionInfo.fromEntries(resources.entries)[0];
  const info = existing || ResEdit.Resource.VersionInfo.createEmpty();
  const lang = existing?.getAllLanguagesForStringValues()[0] || {
    lang: LANG_EN_US,
    codepage: CODEPAGE_UNICODE,
  };
  info.setFileVersion(major, minor, build, revision, lang.lang);
  info.setProductVersion(major, minor, build, revision, lang.lang);
  info.setStringValues(lang, versionString);
  info.outputToResourceEntries(resources.entries);

  // Icon: replace the images of the executable's first icon group, or create group 1 when it has none.
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(icon));
  const group = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries)[0];
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    resources.entries,
    group ? group.id : 1,
    group ? group.lang : lang.lang,
    iconFile.icons.map((item) => item.data),
  );

  // Manifest: a normal-user level. Elevation belongs to the installer or an explicit repair action; stamping
  // the Electron renderer as elevated can break Windows TSF keyboard focus across every editable field.
  const manifest = resources.entries.find((entry) => entry.type === RT_MANIFEST);
  if (!manifest) throw new Error("[friday] the executable has no embedded manifest to edit");
  const xml = Buffer.from(manifest.bin)
    .toString("utf8")
    .replace(/^\uFEFF/, "");
  const edited = Buffer.from(withExecutionLevel(xml, executionLevel), "utf8");
  manifest.bin = edited.buffer.slice(edited.byteOffset, edited.byteOffset + edited.byteLength);

  resources.outputResource(exe);
  const out = Buffer.from(exe.generate());
  const temporary = `${file}.branding`;
  fs.writeFileSync(temporary, out);
  fs.renameSync(temporary, file);
}

async function brandWindows(context) {
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

  // Registered as afterPack and afterSign. afterSign is required because electron-builder 26
  // signAndEditResources runs after afterPack (and signApp still returns true when signExecutable is false),
  // so this is the last write before NSIS/portable copy win-unpacked. Without it, TEST FileVersion becomes
  // "1.0.0-test.1" / FILEVERSION 1.0.0.1 (test build run 33901573538).
  await stampExecutable(executable, { icon, fileVersion, versionString });

  console.log(`[friday] branded ${executable} without winCodeSign`);
}

module.exports = brandWindows;
module.exports.stampExecutable = stampExecutable;
module.exports.withExecutionLevel = withExecutionLevel;
