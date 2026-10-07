/**
 * FRIDAY · update offer contract
 *
 * The two rules an installed FRIDAY must never break:
 *   * a REBUILD of the version already installed is NOT an update,
 *   * the NEXT version on the same channel IS an update.
 *
 * The decision lives in electron/github-sync.cjs and uses the release engine's
 * full build ordering, so both are asserted here: the ordering itself, and that
 * the update check really uses it against the installed version.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const ROOT = process.cwd();
const { compareBuilds } = require_(path.resolve(ROOT, "scripts/release-engine.cjs")) as {
  compareBuilds: (a: string, b: string) => number;
};
const SYNC = fs.readFileSync(path.join(ROOT, "electron/github-sync.cjs"), "utf8");

/** The exact rule github-sync applies: newer than the installed build. */
const isUpdate = (published: string, installed: string) => compareBuilds(published, installed) > 0;

describe("update offers", () => {
  it("never offers a rebuild of the installed version", () => {
    expect(isUpdate("v1.3.2", "1.3.2")).toBe(false);
    expect(isUpdate("v1.3.2-test.1", "1.3.2-test.1")).toBe(false);
  });

  it("offers the next version on the same channel", () => {
    expect(isUpdate("v1.3.3", "1.3.2")).toBe(true);
    expect(isUpdate("v1.3.2-test.2", "1.3.2-test.1")).toBe(true);
    expect(isUpdate("v1.0.0.1", "1.0.0.0")).toBe(true);
    expect(isUpdate("v1.0.1.0", "1.0.0.1")).toBe(true);
    expect(isUpdate("v1.1.0.0", "1.0.1.0")).toBe(true);
    expect(isUpdate("v2.0.0.0", "1.1.0.0")).toBe(true);
    expect(isUpdate("v1.0.0.10", "1.0.0.9")).toBe(true);
  });

  it("never offers a same-version rebuild as an application update", () => {
    expect(isUpdate("v1.0.0.0", "1.0.0.0")).toBe(false);
    expect(isUpdate("v1.0.0.1", "1.0.0.1")).toBe(false);
    expect(isUpdate("v2.0.0.0", "2.0.0.0")).toBe(false);
  });

  it("never downgrades", () => {
    expect(isUpdate("v1.3.1", "1.3.2")).toBe(false);
    expect(isUpdate("v1.3.2-test.1", "1.3.2")).toBe(false);
    expect(isUpdate("v1.1.0.0", "2.0.0.0")).toBe(false);
  });

  it("compares against the installed version with the shared ordering", () => {
    expect(SYNC).toContain("compareBuilds");
    expect(SYNC).toContain("cfg.currentVersion");
    expect(SYNC).toMatch(/const newer = current \? compared > 0/);
  });

  it("keeps the two channels apart in the offer itself", () => {
    expect(SYNC).toContain("updateChannel");
    expect(SYNC).toContain("requiresExplicitInstall");
  });
});
