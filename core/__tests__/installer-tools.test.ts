/**
 * The NSIS tools electron-builder downloads while packaging are fetched before the build (setup, Doctor and the
 * build's own first phase run scripts/ensure-electron.cjs), checked by Doctor, and fetched again only when missing.
 * No network: the electron-builder toolset is replaced by a fake that writes into a temp folder.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ensure = require("../../scripts/ensure-electron.cjs");

function fakeToolset(dir: string, failures = 0) {
  let calls = 0;
  const nsis = path.join(dir, "nsis");
  const plugins = path.join(dir, "plugins");
  return {
    calls: () => calls,
    toolset: {
      getMakeNsisPath: async () => {
        calls += 1;
        if (calls <= failures) throw new Error("connect ETIMEDOUT\nsecond line");
        mkdirSync(nsis, { recursive: true });
        writeFileSync(path.join(nsis, "makensis.cmd"), "");
        return { path: path.join(nsis, "makensis.cmd") };
      },
      getNsisPluginsPath: async () => {
        mkdirSync(plugins, { recursive: true });
        return plugins;
      },
    },
  };
}

describe("installer tools before the build", () => {
  it("is not fetched on a platform that cannot build the installer", async () => {
    const env: Record<string, string> = {};
    const ok = await ensure.ensureInstallerTools({
      env,
      platform: "linux",
      loadToolset: () => {
        throw new Error("must not load");
      },
    });
    expect(ok).toBe(true);
    expect(ensure.installerToolsReady(env)).toMatchObject({ wanted: false, ready: true });
  });

  it("fetches once, records it, and does not fetch again while the folders exist", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "friday-itools-"));
    try {
      const env: Record<string, string> = {
        ELECTRON_BUILDER_CACHE: dir,
        FRIDAY_PREFETCH_BUILDER_TOOLS: "1",
      };
      const fake = fakeToolset(dir);
      expect(ensure.installerToolsReady(env).ready).toBe(false);
      expect(await ensure.ensureInstallerTools({ env, loadToolset: () => fake.toolset })).toBe(
        true,
      );
      expect(ensure.installerToolsReady(env).ready).toBe(true);
      expect(await ensure.ensureInstallerTools({ env, loadToolset: () => fake.toolset })).toBe(
        true,
      );
      expect(fake.calls()).toBe(1);
      rmSync(path.join(dir, "plugins"), { recursive: true });
      expect(ensure.installerToolsReady(env)).toMatchObject({
        ready: false,
        reason: "a cached folder is missing",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retries a dropped download, then reports the source when it keeps failing", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "friday-itools-"));
    try {
      const env: Record<string, string> = {
        ELECTRON_BUILDER_CACHE: dir,
        FRIDAY_PREFETCH_BUILDER_TOOLS: "1",
      };
      const flaky = fakeToolset(dir, 2);
      const sleep = async () => {};
      expect(
        await ensure.ensureInstallerTools({ env, loadToolset: () => flaky.toolset, sleep }),
      ).toBe(true);
      expect(flaky.calls()).toBe(3);

      const dir2 = mkdtempSync(path.join(tmpdir(), "friday-itools-"));
      const env2: Record<string, string> = {
        ELECTRON_BUILDER_CACHE: dir2,
        FRIDAY_PREFETCH_BUILDER_TOOLS: "1",
      };
      const broken = fakeToolset(dir2, 99);
      expect(
        await ensure.ensureInstallerTools({ env: env2, loadToolset: () => broken.toolset, sleep }),
      ).toBe(false);
      expect(existsSync(path.join(dir2, ".friday-installer-tools.json"))).toBe(false);
      rmSync(dir2, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is part of setup, Doctor and the build's first phase", () => {
    const fs = require("node:fs");
    const check = fs.readFileSync(
      path.resolve(__dirname, "../../scripts/check-environment.cjs"),
      "utf8",
    );
    expect(check).toContain("Installer tools (NSIS)");
    const pipeline = fs.readFileSync(
      path.resolve(__dirname, "../../scripts/build-pipeline.cjs"),
      "utf8",
    );
    expect(pipeline).toContain("scripts/ensure-electron.cjs");
    const setup = fs.readFileSync(
      path.resolve(__dirname, "../../scripts/setup-windows.ps1"),
      "utf8",
    );
    expect(setup).toContain("ensure-electron.cjs");
  });
});
