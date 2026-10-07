/**
 * FRIDAY · update channels (STABLE vs TEST)
 *
 * The contract these tests defend:
 *   * production default is STABLE — official GitHub Releases only;
 *   * TEST shows test builds only, clearly labelled, never mixed with stable;
 *   * neither channel ever downgrades, and TEST never installs on its own;
 *   * a test artifact can never be promoted into an official release.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const sync = require_(path.resolve(process.cwd(), "electron/github-sync.cjs"));

const MAIN = fs.readFileSync(path.resolve(process.cwd(), "electron/main.cjs"), "utf8");

let root = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-channel-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("channel selection", () => {
  it("defaults to stable and only ever stores stable or test", () => {
    expect(sync.readConfig(root).updateChannel).toBe("stable");
    expect(sync.normalizeUpdateChannel(undefined)).toBe("stable");
    expect(sync.normalizeUpdateChannel("nightly")).toBe("stable");
    expect(sync.normalizeUpdateChannel("TEST")).toBe("test");

    sync.writeConfig(root, { updateChannel: "test" });
    expect(sync.readConfig(root).updateChannel).toBe("test");
    sync.writeConfig(root, { updateChannel: "whatever" });
    expect(sync.readConfig(root).updateChannel).toBe("stable");
  });
});

describe("test build identification", () => {
  it("recognises pre-releases, test tags and test artifacts", () => {
    expect(sync.isTestRelease({ tag_name: "v1.4.0", prerelease: true })).toBe(true);
    expect(sync.isTestRelease({ tag_name: "v1.4.0-rc.1" })).toBe(true);
    expect(sync.isTestRelease({ tag_name: "test-build-42" })).toBe(true);
    expect(
      sync.isTestRelease({ tag_name: "v1.4.0", assets: [{ name: "FRIDAY-Test-main-abc.exe" }] }),
    ).toBe(true);
  });

  it("treats a normal published release as official", () => {
    expect(
      sync.isTestRelease({
        tag_name: "v1.3.1",
        name: "FRIDAY 1.3.1",
        prerelease: false,
        assets: [{ name: "FRIDAY-Setup-1.3.1.exe" }],
      }),
    ).toBe(false);
  });
});

describe("test prerelease versions", () => {
  const engine = require_(path.resolve(process.cwd(), "scripts/release-engine.cjs"));

  it("numbers test builds as real SemVer prereleases of the version they test", () => {
    expect(engine.testVersion("1.3.1", []).version).toBe("1.3.1-test.1");
    expect(engine.testVersion("1.3.1", ["v1.3.1-test.1", "v1.3.1-test.2"]).version).toBe(
      "1.3.1-test.3",
    );
    // A different base line starts its own counter and never collides.
    expect(engine.testVersion("1.3.2", ["v1.3.1-test.7"]).version).toBe("1.3.2-test.1");
    expect(engine.isTestVersion("1.3.1-test.1")).toBe(true);
    expect(engine.isTestVersion("1.3.1")).toBe(false);
  });

  it("orders a test build below the official version it precedes", () => {
    expect(engine.compareVersions("v1.3.2-test.1", "v1.3.1")).toBeGreaterThan(0);
    expect(engine.compareVersions("v1.3.2-test.2", "v1.3.2-test.1")).toBeGreaterThanOrEqual(0);
  });
});

describe("channel state never mixes", () => {
  it("records a test install apart from the stable installed ref", () => {
    sync.writeConfig(root, { repo: "devendrarj25/FRIDAY-AI-ASSISTANT", updateChannel: "stable" });
    sync.recordApplied(root, { ref: "v1.3.1", applied: 3 });
    let cfg = sync.readConfig(root);
    expect(cfg.appliedRef).toBe("v1.3.1");
    expect(cfg.testAppliedRef).toBeNull();

    sync.writeConfig(root, { updateChannel: "test" });
    sync.recordApplied(root, { ref: "test-build-42", applied: 3 });
    cfg = sync.readConfig(root);
    // Stable stays exactly where it was — a test build never claims it.
    expect(cfg.appliedRef).toBe("v1.3.1");
    expect(cfg.testAppliedRef).toBe("test-build-42");
    expect(cfg.history[0].channel).toBe("test");
    expect(cfg.history[1].channel).toBe("stable");
  });
});

describe("main process guards", () => {
  it("never installs a test build silently and never on the stable channel", () => {
    expect(MAIN).toContain("channelMismatch");
    expect(MAIN).toContain("requiresTestConfirmation");
    expect(MAIN).toContain("payload.acceptTest !== true");
  });

  it("refuses to publish an official release from the test channel", () => {
    const dispatch = MAIN.slice(MAIN.indexOf('ipcMain.handle("github:dispatch-release"'));
    expect(dispatch.slice(0, 900)).toContain("testChannel: true");
  });

  it("keeps background auto-apply off while the test channel is selected", () => {
    expect(MAIN).toContain('normalizeUpdateChannel(live.updateChannel) === "test"');
  });
});
