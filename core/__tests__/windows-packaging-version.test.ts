/**
 * Four-part public identity must survive packaging.
 *
 * electron-builder reads the npm encoding (1.0.0). Artifact names, latest.yml,
 * Windows FILEVERSION and checksums must use public 1.0.0.0. This is the
 * contract that failed on windows-latest after the 1.0.0.0 reset:
 * `latest.yml does not declare 1.0.0.0`.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "../..");
const engine = require("../../scripts/release-engine.cjs") as {
  readCanonicalIdentity: (opts?: { root?: string }) => {
    releaseVersion: string;
    npmVersion: string;
    windowsFileVersion: string;
    fourPart: boolean;
  };
  fileVersionStringMatches: (seen: string, expected: string) => boolean;
  syncLatestYml: (
    identity: { releaseVersion: string; npmVersion: string },
    opts: { root: string },
  ) => boolean;
  packFlags: (identity: { releaseVersion: string; channel?: string }) => {
    setupArtifact: string;
    portableArtifact: string;
    extraArgs: string[];
  };
};

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("Windows packaging uses the public four-part identity", () => {
  it("names setup/portable artifacts with the public version, not the npm encoding", () => {
    const identity = engine.readCanonicalIdentity({ root: ROOT });
    expect(identity.fourPart).toBe(true);
    expect(identity.releaseVersion).not.toBe(identity.npmVersion);
    expect(identity.windowsFileVersion).toBe(identity.releaseVersion.replace(/-.*$/, ""));
    const flags = engine.packFlags(identity);
    expect(flags.setupArtifact).toBe(`FRIDAY-Setup-${identity.releaseVersion}.exe`);
    expect(flags.portableArtifact).toBe(`FRIDAY-Portable-${identity.releaseVersion}.exe`);
    expect(flags.setupArtifact).not.toBe(`FRIDAY-Setup-${identity.npmVersion}.exe`);
    expect(flags.extraArgs).toContain(`-c.buildVersion=${identity.windowsFileVersion}`);
    expect(flags.extraArgs).toContain(
      `-c.extraMetadata.shortVersion=${identity.windowsFileVersion}`,
    );
    expect(flags.extraArgs).toContain(
      `-c.extraMetadata.shortVersionWindows=${identity.windowsFileVersion}`,
    );

    const yml = read("electron-builder.yml");
    expect(yml).toMatch(/^afterPack:\s*scripts\/brand-windows\.cjs$/m);
    expect(yml).toMatch(/^afterSign:\s*scripts\/brand-windows\.cjs$/m);

    const cmd = read("scripts/build-windows.cmd");
    const recipe = read("scripts/build-pipeline.cjs");
    expect(cmd).toContain("build-pipeline.cjs");
    expect(recipe).toContain("scripts/electron-pack.cjs");
    expect(recipe).toContain("scripts/verify-build.cjs");
    expect(cmd).not.toContain("npx electron-builder");
    expect(recipe).not.toContain("npx electron-builder");
    expect(recipe).not.toContain("1.0.0.0");
    expect(recipe).toContain("canonical friday-version.json is the single truth");

    const builderCli = read("builder/cli.mjs");
    expect(builderCli).toContain("scripts/electron-pack.cjs");
    expect(builderCli).not.toContain("npx electron-builder");
  });

  it("re-brands after electron-builder 26 resource overwrite when signing is off", () => {
    // Test EXE Build 33901573538: afterPack branding was overwritten by
    // signAndEditResources (npm FileVersion 1.0.0-test.1 / FILEVERSION 1.0.0.1).
    // electron-builder 26 still edits resources when signExecutable is false,
    // still returns true from signApp, and therefore still emits afterSign.
    // signAndEditExecutable: false is the switch that skips editing — and that
    // previously shipped electron.exe, so it must stay enabled.
    const win = read("node_modules/app-builder-lib/out/winPackager.js");
    const platform = read("node_modules/app-builder-lib/out/platformPackager.js");
    expect(win).toContain("async signAndEditResources(");
    expect(win).toContain("fileVersion: appInfo.shortVersion || appInfo.buildVersion");
    expect(win).toContain("this.platformSpecificBuildOptions.signAndEditExecutable === false");
    expect(win).toContain("this.platformSpecificBuildOptions.signExecutable === false");
    expect(win).toContain(
      "if (!isAsar || this.platformSpecificBuildOptions.signExecutable === false)",
    );
    expect(platform).toContain("const didSign = await this.signApp(packContext, isAsar);");
    expect(platform).toContain("await this.info.emitAfterSign(packContext);");
    expect(platform).toContain('skipping "afterSign" hook as no signing occurred');

    const yml = read("electron-builder.yml");
    expect(yml).toMatch(/^afterPack:\s*scripts\/brand-windows\.cjs$/m);
    expect(yml).toMatch(/^afterSign:\s*scripts\/brand-windows\.cjs$/m);
    expect(yml).toMatch(/^\s*signExecutable:\s*false/m);
    expect(yml).not.toMatch(/^\s*signAndEditExecutable:/m);

    const brand = read("scripts/brand-windows.cjs");
    expect(brand).toContain("afterPack and afterSign");
  });

  it("rewrites electron-builder latest.yml from the npm encoding to the public identity", () => {
    const identity = engine.readCanonicalIdentity({ root: ROOT });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-latest-"));
    fs.mkdirSync(path.join(dir, "release"));
    fs.writeFileSync(
      path.join(dir, "release", "latest.yml"),
      [
        `version: ${identity.npmVersion}`,
        "files:",
        `  - url: FRIDAY-Setup-${identity.npmVersion}.exe`,
        "    sha512: abc",
        `path: FRIDAY-Setup-${identity.npmVersion}.exe`,
        "sha512: abc",
        "",
      ].join("\n"),
    );
    expect(engine.syncLatestYml(identity, { root: dir })).toBe(true);
    const body = fs.readFileSync(path.join(dir, "release", "latest.yml"), "utf8");
    expect(body).toMatch(
      new RegExp(`^version:\\s*${identity.releaseVersion.replace(/\./g, "\\.")}$`, "m"),
    );
    expect(body).toContain(`FRIDAY-Setup-${identity.releaseVersion}.exe`);
    expect(body).not.toContain(`FRIDAY-Setup-${identity.npmVersion}.exe`);
    expect(engine.syncLatestYml(identity, { root: dir })).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("packs, checksums and brands from the public identity", () => {
    const pack = read("scripts/electron-pack.cjs");
    expect(pack).toContain("readCanonicalIdentity");
    expect(pack).toContain("identity.fourPart");
    expect(pack).toContain("refusing to package a three-part identity");
    expect(pack).toContain("syncLatestYml");
    expect(pack.indexOf("syncLatestYml")).toBeGreaterThan(pack.indexOf("spawnSync"));

    const yml = read("electron-builder.yml");
    expect(yml).toMatch(/from:\s*config\b/);
    expect(yml).toMatch(/to:\s*config\b/);
    expect(yml).toContain("FRIDAY-Setup-<releaseVersion>.exe");
    expect(yml).not.toContain("FRIDAY-Setup-1.0.0.0.exe");

    const identity = engine.readCanonicalIdentity({ root: ROOT });
    const nsh = read("installer/build/friday-version.nsh");
    expect(nsh).toContain(`FRIDAY_DISPLAY_VERSION "${identity.releaseVersion}"`);
    expect(nsh).toContain(`FRIDAY_NPM_VERSION "${identity.npmVersion}"`);

    const manifest = read("scripts/release-manifest.cjs");
    expect(manifest).toContain("syncLatestYml");
    expect(manifest.indexOf("syncLatestYml")).toBeLessThan(manifest.indexOf("sha256(a.file)"));

    const brand = read("scripts/brand-windows.cjs");
    const stamp = read("scripts/identity.cjs");
    expect(stamp).toContain("FileVersion: fileVersion");
    expect(stamp).toContain("ProductVersion: productVersion");
    expect(brand).toContain("windowsResourceStamp");
    expect(brand).toContain("fileVersion,");
    expect(brand).toContain("productVersion,");
    expect(brand).toContain("windowsFileVersion");
    expect(brand).toContain("TEST_PRODUCT");
    expect(brand).toContain('"product-version": fileVersion');
    expect(brand).not.toContain('"product-version": productVersion');
    // rcedit --set-file-version overwrites the FileVersion string; a second
    // version-string-only pass keeps ProductName/ProductVersion. Windows
    // FileVersionInfo.FileVersion still reports "1.0.0" when FilePrivatePart
    // is 0 (PR Validation 33888385242). verify-build accepts that form when
    // the binary FILEVERSION is the public identity.
    expect(brand).toContain("imported.rcedit");
    expect(brand.split("await rcedit(").length - 1).toBe(2);
    const secondPass = brand.split("await rcedit(")[2] || "";
    expect(secondPass).toContain("version-string");
    expect(secondPass).not.toContain("file-version");

    const verify = read("scripts/verify-build.cjs");
    expect(verify).toContain("windowsFileVersion");
    expect(verify).toContain("fileVersionStringMatches");
    expect(verify).toContain("FileMajorPart");
    expect(verify).toContain("latest.yml does not declare ${publicVersion}");
  });

  it("treats Windows FileVersion 1.0.0 as public 1.0.0.0, not as a foreign version", () => {
    expect(engine.fileVersionStringMatches("1.0.0.0", "1.0.0.0")).toBe(true);
    expect(engine.fileVersionStringMatches("1.0.0", "1.0.0.0")).toBe(true);
    expect(engine.fileVersionStringMatches("1.0.0", "1.0.0.1")).toBe(false);
    expect(engine.fileVersionStringMatches("1.0.1", "1.0.0.0")).toBe(false);
    expect(engine.fileVersionStringMatches("1.0.0-test.1", "1.0.0.0")).toBe(false);
    expect(engine.fileVersionStringMatches("", "1.0.0.0")).toBe(false);
  });
});
