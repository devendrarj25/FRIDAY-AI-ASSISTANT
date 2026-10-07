/**
 * Settings → Updates is the read-only GitHub update UI. Write-side
 * (push / PR / dispatch) lives on Friday Hub. These tests lock that split
 * and the real IPC the page calls.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const PANEL = "src/components/friday/settings/GithubUpdates.tsx";
const HUB = "src/routes/hub.tsx";
const RELEASE = "src/components/friday/settings/ReleaseControls.tsx";

describe("Settings → Updates stays read-only toward GitHub", () => {
  const panel = read(PANEL);

  it("calls the real connect, check, apply, rollback and restart bridges", () => {
    expect(panel).toContain("persistSource");
    expect(panel).toContain("githubTest()");
    expect(panel).toContain("githubCheck()");
    expect(panel).toContain("checkForUpdates");
    expect(panel).toContain("applyCheckedUpdate");
    expect(panel).toContain("rollbackPackUpdate");
    expect(panel).toContain('restartApp("update-applied")');
    expect(panel).toContain("githubInstallerBundles");
    expect(panel).toContain("githubDownloadInstaller");
    expect(panel).toContain("githubInstallUpdate");
    expect(panel).toContain("onUpdateProgress");
    expect(panel).toContain("Change token");
    expect(panel).toContain("hasToken");
    expect(panel).toContain("Download full installer");
    expect(panel).toContain("Restart now to finish updating");
    expect(panel).toContain("completeAppInstall");
    expect(panel).toContain("started.staged");
    expect(panel).toContain("started.launched");
    expect(panel).toContain("releaseInstaller(check) && check?.updateAvailable");
    expect(panel).toContain('session.state === "reauth-required"');
  });

  it("never shows a saved token and never mounts Hub write chrome", () => {
    expect(panel).not.toContain("ReleaseControls");
    expect(panel).not.toContain("githubPush");
    expect(panel).not.toContain("githubPushAndSync");
    expect(panel).not.toContain("githubPushSource");
    expect(panel).not.toContain("githubDispatchRelease");
    expect(panel).not.toContain("githubBuildAndRelease");
    expect(panel).not.toContain("githubTestBuild");
    expect(panel).not.toContain("githubAnalyze");
    expect(panel).not.toContain("devOpenPullRequest");
    expect(panel).not.toContain("dev-workflow");
    expect(panel).not.toContain("contents: write");
    expect(panel).not.toContain("canRelease");
  });

  it("keeps the packaged-app source apply gate and channel switch", () => {
    expect(panel).toContain("check?.packaged ? null : (");
    expect(panel).toContain("Download & apply");
    expect(panel).toContain("updateChannel");
    expect(panel).toContain("Include test builds");
    expect(panel).toContain("What's new");
  });
});

describe("Friday Hub keeps write-side release controls", () => {
  it("mounts ReleaseControls next to DevControl and does not check for app updates", () => {
    const hub = read(HUB);
    expect(hub).toContain("ReleaseControls");
    expect(hub).toContain("DevControl");
    expect(hub).not.toContain("githubCheck");
    expect(hub).not.toContain("checkForUpdates");
    expect(hub).not.toContain("checkAllUpdates");
    expect(read(RELEASE)).toContain("githubBuildAndRelease");
  });
});

describe("installer-bundle IPC is read-only", () => {
  it("exposes github:installer-bundles through main and preload", () => {
    expect(read("electron/main.cjs")).toContain('ipcMain.handle("github:installer-bundles"');
    expect(read("electron/preload.cjs")).toContain("github:installer-bundles");
    expect(read("electron/github-release.cjs")).toContain("listInstallerBundles");
    expect(read("electron/github-release.cjs")).toContain("sync.isTestRelease");
    expect(read("electron/github-release.cjs")).toContain("sync.installerAsset");
  });
});

describe("Updates persist and private EXE download identity", () => {
  const main = read("electron/main.cjs");

  it("awaits reconnectGithub after a successful github:set-config", () => {
    const set = main.slice(
      main.indexOf('ipcMain.handle("github:set-config"'),
      main.indexOf('ipcMain.handle("github:test"'),
    );
    expect(set).toContain("await reconnectGithub()");
  });

  it("passes apiUrl and assetId through updates:apply installApp", () => {
    const apply = main.slice(
      main.indexOf('ipcMain.handle("updates:apply"'),
      main.indexOf('ipcMain.handle("updates:rollback"'),
    );
    expect(apply).toContain("apiUrl: asset.apiUrl");
    expect(apply).toContain("assetId: asset.id");
    expect(apply).toContain('updateChannel: wantTest ? "test" : "stable"');
    expect(apply).toContain("if (!check?.ok)");
  });
});
