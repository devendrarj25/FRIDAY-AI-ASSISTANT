/**
 * FRIDAY · packaged update channel
 *
 * An installed (packaged) FRIDAY is only ever replaced by a verified release
 * installer. Raw GitHub source ZIPs stay a developer channel (Import & Build)
 * and can never update the installed application.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const MAIN = fs.readFileSync(path.resolve(process.cwd(), "electron/main.cjs"), "utf8");
const DOCS = ["README.md", "INSTALL.md", "docs/FRIDAY_STORAGE_CONTRACT.md"];
const engine = require("../../scripts/release-engine.cjs") as {
  readCanonicalIdentity: (opts?: { root?: string }) => { releaseVersion: string };
};
const VERSION = engine.readCanonicalIdentity({ root: process.cwd() }).releaseVersion;

describe("packaged app source-update guard", () => {
  const handler = MAIN.slice(MAIN.indexOf('ipcMain.handle("github:pull"'));

  it("refuses a source ZIP update when the app is packaged", () => {
    expect(handler.slice(0, 900)).toContain("app.isPackaged");
    expect(handler.slice(0, 900)).toContain("sourceUpdateBlocked");
  });

  it("has no packaged-app bypass for a developer import", () => {
    expect(handler.slice(0, 900)).toContain("if (app.isPackaged)");
    expect(handler.slice(0, 900)).not.toContain("developerImport");
  });

  it("checks releases only for a packaged build", () => {
    expect(MAIN).toContain('app.isPackaged ? { channel: "release" } : {}');
  });

  it("compares application updates by public identity, not npm string equality", () => {
    const updater = fs.readFileSync(path.resolve(process.cwd(), "electron/updater.cjs"), "utf8");
    expect(updater).toContain("compareBuilds(found.available, currentVersion)");
    expect(updater).not.toContain("found.available === currentVersion");
  });
});

describe("documentation version", () => {
  it("documents the version that actually ships", () => {
    // A TEST build stamps package.json as 1.3.3-test.N; the documented,
    // official version is the base line it tests.
    const base = VERSION.split("-")[0];
    for (const file of DOCS) {
      const text = fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
      expect(text, `${file} should name v${base}`).toContain(base);
    }
  });
});
