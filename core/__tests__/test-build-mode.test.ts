/**
 * Portable TEST build contract.
 *
 * A test EXE is a full build of a branch that runs without an installer. It
 * must find the existing FRIDAY_ROOT, reuse the expensive resources already on
 * the machine, isolate every piece of mutable state, and stay completely out of
 * the automatic update flow and out of the release channel (an explicit, confirmed
 * TEST → newer TEST or TEST → Stable install is allowed).
 *
 * Both real situations are covered: a PC that already has FRIDAY resources, and
 * a fresh root with nothing installed yet.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const paths = require("../../electron/friday-paths.cjs");
const storage = require("../../electron/storage-manager.cjs");
const buildChannel = require("../../electron/build-channel.cjs");

const roots: string[] = [];
const makeRoot = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-testexe-"));
  roots.push(dir);
  return dir;
};

afterEach(() => {
  paths.setProfile("production");
  paths.setRoot(null);
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("build channel detection", () => {
  it("defaults to production with no marker and no env", () => {
    const info = buildChannel.detect({ env: {} });
    expect(info.channel).toBe("production");
    expect(info.profile).toBe("production");
    expect(info.allowsUpdates).toBe(true);
    expect(info.allowsAutoUpdates).toBe(true);
    expect(info.allowsRelease).toBe(true);
  });

  it("detects a test build from the environment", () => {
    expect(buildChannel.detect({ env: { FRIDAY_TEST_BUILD: "1" } }).isTest).toBe(true);
    expect(buildChannel.detect({ env: { FRIDAY_BUILD_CHANNEL: "test" } }).isTest).toBe(true);
  });

  it("detects a test build from the packaged marker written by test-build.yml", () => {
    const resourcesPath = makeRoot();
    fs.writeFileSync(
      path.join(resourcesPath, "build-channel.json"),
      JSON.stringify({ channel: "test", ref: "feature/x", commit: "abc1234", runId: "42" }),
    );
    const info = buildChannel.detect({ env: {}, resourcesPath });
    expect(info.isTest).toBe(true);
    expect(info.ref).toBe("feature/x");
    expect(info.commit).toBe("abc1234");
    expect(info.profile).toBe(buildChannel.TEST_PROFILE);
  });

  it("lets a test build update explicitly but never automatically or release", () => {
    const info = buildChannel.detect({ env: { FRIDAY_TEST_BUILD: "1" } });
    // Explicit TEST → newer TEST and TEST → Stable installs are allowed…
    expect(info.allowsUpdates).toBe(true);
    // …but nothing about them is automatic, and a release is never cut here.
    expect(info.allowsAutoUpdates).toBe(false);
    expect(info.allowsRelease).toBe(false);
    const refusal = buildChannel.blocked("Creating a release");
    expect(refusal.ok).toBe(false);
    expect(refusal.testBuild).toBe(true);
  });

  it("keeps the update IPC open to a test build and background polling closed", () => {
    const main = fs.readFileSync(path.join(process.cwd(), "electron", "main.cjs"), "utf8");
    const download = main.slice(main.indexOf('ipcMain.handle("github:download-installer"'));
    // No unconditional test-build refusal on the explicit download path.
    expect(download.slice(0, 400)).not.toContain("BUILD_CHANNEL.isTest");
    // Releases stay blocked, and the background poller still returns early.
    expect(main).toContain(
      'if (BUILD_CHANNEL.isTest) return buildChannel.blocked("Creating a release");',
    );
    const poll = main.slice(main.indexOf("function scheduleGithubChecks()"));
    expect(poll.slice(0, 600)).toContain("if (BUILD_CHANNEL.isTest) return;");
  });
});

describe("test EXE on a PC that already has FRIDAY resources", () => {
  it("reuses models, voices and runtime, isolates config/database/logs", () => {
    const root = makeRoot();
    paths.setProfile("production");
    paths.setRoot(root);
    paths.ensureStructure(root);

    // Production state that must stay untouched.
    const prodModel = path.join(paths.dir("models"), "phi-3", "model.gguf");
    fs.mkdirSync(path.dirname(prodModel), { recursive: true });
    fs.writeFileSync(prodModel, "weights");
    const prodDatabase = paths.dir("database");
    const prodConfig = paths.dir("config");
    const prodLogs = paths.dir("logs");
    fs.mkdirSync(prodConfig, { recursive: true });
    const prodCredentials = path.join(prodConfig, "credentials.json");
    fs.writeFileSync(prodCredentials, '{"token":"production"}');

    // The test EXE boots against the SAME root.
    const info = buildChannel.init({
      app: null,
      paths,
      env: { FRIDAY_TEST_BUILD: "1" },
    });
    expect(info.isTest).toBe(true);
    expect(paths.profile()).toBe("test");

    // Expensive immutable resources: shared, not duplicated.
    expect(paths.dir("models")).toBe(path.dirname(path.dirname(prodModel)));
    expect(storage.inventory(root).resources.models.reusable).toBe(true);
    expect(paths.dir("runtime")).toBe(path.join(root, "runtime"));
    expect(paths.dir("voices")).toBe(path.join(root, "voices"));

    // Mutable state: isolated per profile.
    for (const name of ["config", "database", "logs", "memory", "state", "workspace", "security"]) {
      const testDir = paths.dir(name);
      expect(testDir).toContain(path.join("profiles", "test"));
      expect(testDir.startsWith(path.resolve(root))).toBe(true);
    }
    expect(paths.dir("database")).not.toBe(prodDatabase);
    expect(paths.dir("logs")).not.toBe(prodLogs);

    // Running the test build writes nothing into production state.
    paths.ensureStructure(root);
    fs.writeFileSync(path.join(paths.ensureDir("config"), "credentials.json"), "{}");
    expect(fs.readFileSync(prodCredentials, "utf8")).toBe('{"token":"production"}');
    expect(fs.readFileSync(prodModel, "utf8")).toBe("weights");
  });
});

describe("test EXE readiness folders", () => {
  it("creates memory and backups where the test profile reads them", () => {
    const root = makeRoot();
    buildChannel.init({ app: null, paths, env: { FRIDAY_TEST_BUILD: "1" } });
    paths.setRoot(root);
    paths.ensureStructure(root);
    for (const name of ["config", "database", "memory", "state", "logs", "backups"]) {
      const folder = paths.dir(name);
      expect(fs.existsSync(folder), name).toBe(true);
      expect(folder, name).toContain(path.join("profiles", "test"));
    }
    for (const name of ["models", "cache", "runtime"]) {
      const folder = paths.dir(name);
      expect(fs.existsSync(folder), name).toBe(true);
      expect(folder, name).toBe(path.join(root, name));
    }
    expect(fs.existsSync(path.join(root, "memory"))).toBe(false);
    expect(fs.existsSync(path.join(root, "backups"))).toBe(false);
  });
});

describe("test EXE with missing resources", () => {
  it("creates only its isolated state inside the root and downloads nothing twice", () => {
    const root = makeRoot();
    buildChannel.init({ app: null, paths, env: { FRIDAY_TEST_BUILD: "1" } });
    paths.setRoot(root);
    paths.ensureStructure(root);

    const report = storage.prepare(root, { version: "0.0.0-test" });
    // Nothing exists yet — nothing is reported as reusable, nothing duplicated.
    expect(report.reusable).toEqual([]);
    expect(report.duplicates).toEqual([]);

    // Repair stays inside FRIDAY_ROOT; no sibling/AppData/tmp folder appears.
    const created = paths.dir("config");
    expect(created.startsWith(path.resolve(root))).toBe(true);
    expect(created).toContain(path.join("profiles", "test"));

    // Once a model lands in the shared store, the test build reuses it.
    const shared = path.join(paths.dir("models"), "llama", "model.gguf");
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.writeFileSync(shared, "weights");
    expect(storage.inventory(root).resources.models.reusable).toBe(true);
    expect(storage.resourcePath(root, "models")).toBe(path.join(root, "models"));
  });
});

describe("installer lifecycle smoke contract", () => {
  const smoke = fs.readFileSync(
    path.join(process.cwd(), "scripts", "windows-installer-smoke.ps1"),
    "utf8",
  );

  it("resolves the REAL registered uninstaller instead of guessing its filename", () => {
    // electron-builder names the uninstaller after PRODUCT_FILENAME
    // (= sanitize(win.executableName) when set), so "FRIDAY Test" installs
    // "Uninstall FRIDAY.exe". Guessing "Uninstall $Product.exe" is the bug.
    expect(smoke).not.toContain("Uninstall $Product.exe");
    expect(smoke).toContain("function Resolve-Uninstaller");
    expect(smoke).toContain("UninstallString");
    expect(smoke).toContain("InstallLocation");
    expect(smoke).toContain('Filter "Uninstall *.exe"');
    // Existence is still proven before uninstall is attempted.
    expect(smoke).toContain("Installed uninstaller is missing");
    expect(smoke).toContain("Installed uninstaller is missing before uninstall");
  });

  it("never treats a missing exit code as a successful boot", () => {
    expect(smoke).toContain("did not report an exit code");
    // The handle must be cached or .NET drops ExitCode entirely.
    expect(smoke).toContain("$null = $p.Handle");
    expect(smoke).toContain("$Process.Refresh()");
  });

  it("kills only the process tree it started and preserves FRIDAY data", () => {
    expect(smoke).toContain("function Stop-Tree");
    expect(smoke).toContain("/PID $Process.Id /T /F");
    expect(smoke).toContain("Uninstall removed the FRIDAY data folder.");
    expect(smoke).toContain("FRIDAY_BOOT_SELFTEST_OK");
  });

  it("runs Setup twice and fails if repair duplicates uninstall entries or deletes data", () => {
    const first = smoke.indexOf("$uninstaller = Run-Setup");
    const second = smoke.indexOf("$uninstaller = Run-Setup", first + 1);
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(smoke).toContain("Reinstall / repair removed the FRIDAY data folder.");
    expect(smoke).toContain("Reinstall registered");
    expect(smoke).toContain("uninstall entries for $installDir");
  });

  it("exits the packaged boot self-test even when the page probe never settles", () => {
    const main = fs.readFileSync(path.join(process.cwd(), "electron", "main.cjs"), "utf8");
    const python = fs.readFileSync(path.join(process.cwd(), "electron", "python.cjs"), "utf8");
    expect(main).toContain("--friday-boot-selftest");
    expect(main).toContain("armBootSelfTestWatchdog");
    expect(main).toContain("interface did not mount before the deadline");
    expect(main).toContain("boot self-test checks the window only");
    const registry = main.slice(
      main.indexOf("function readRegistryWorkspace"),
      main.indexOf("function writeRegistryWorkspace"),
    );
    expect(registry).toContain("timeout: 8000");
    const resolver = python.slice(
      python.indexOf("async function resolvePython"),
      python.indexOf("function invalidatePython"),
    );
    expect(resolver.indexOf("FRIDAY_BOOT_SELFTEST")).toBeLessThan(
      resolver.indexOf("materialiseBundledRuntime"),
    );
    // The mount signal is unchanged. A hung executeJavaScript must not be the only clock.
    const probe = main.slice(
      main.indexOf("function scheduleBootSelfTest"),
      main.indexOf("function createWindow"),
    );
    expect(probe).toContain("FRIDAY_BOOT_SELFTEST_OK interface mounted");
    expect(probe).toContain("setTimeout");
    expect(probe).not.toContain("if (!win || win.isDestroyed()) return;");
    const emit = main.slice(
      main.indexOf("function emitBootSelfTestLine"),
      main.indexOf("function emitBootSelfTestLine") + 1800,
    );
    const emitBody = emit.slice(0, emit.indexOf("\nif (process.env.FRIDAY_BOOT_SELFTEST)"));
    expect(emitBody).toContain("writeFileSync");
    expect(emitBody).not.toContain("writeSync");
    expect(emitBody).not.toContain("process.stdout.write");
    expect(main).not.toContain("setBlocking(false)");
    expect(smoke).toContain("Do not redirect stdout or stderr.");
    expect(smoke).toContain("function Stop-InstalledApp");
    const bootFn = smoke.indexOf("function Verify-Boot");
    const stopAt = smoke.indexOf("Stop-InstalledApp", bootFn);
    const exeAt = smoke.indexOf("FRIDAY.exe", bootFn);
    expect(stopAt).toBeGreaterThan(bootFn);
    expect(exeAt).toBeGreaterThan(stopAt);
    const marker = main.indexOf("boot-selftest.txt");
    const lock = main.indexOf("requestSingleInstanceLock");
    expect(marker).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(marker);
    const early = main.indexOf('require("./boot-selftest.cjs")');
    const workspace = main.indexOf('require("./workspace.cjs")');
    expect(early).toBeGreaterThan(-1);
    expect(workspace).toBeGreaterThan(early);
    expect(main.slice(early, workspace)).toContain("return;");
    const boot = fs.readFileSync(path.join(process.cwd(), "electron", "boot-selftest.cjs"), "utf8");
    expect(boot.indexOf("renderer.registerScheme()")).toBeLessThan(boot.indexOf("app.whenReady()"));
    expect(boot).toContain('ipcMain.handle("workspace:get"');
    expect(boot).toContain("FRIDAY_BOOT_SELFTEST_OK interface mounted");
    expect(boot).toContain("contextIsolation: true");
    expect(boot).toContain("nodeIntegration: false");
    expect(boot).toContain("sandbox: true");
    expect(boot).toContain("window-all-closed");
    expect(boot).not.toContain("process.stdout.write");
    expect(boot).not.toContain("writeSync");
    expect(boot).not.toContain("setBlocking(false)");
    const verify = fs.readFileSync(path.join(process.cwd(), "scripts", "verify-boot.cjs"), "utf8");
    expect(verify).toContain("FRIDAY_WORKSPACE_ROOT: bootRoot");
    expect(verify).toContain("boot-selftest.txt");
    expect(verify).toContain("--friday-workspace=");
    const lockBlock = main.slice(lock, lock + 700);
    expect(lockBlock).toContain("another FRIDAY already holds this PC");
    expect(lockBlock).toContain("app.exit(1)");
    expect(main).toContain("if (!fridayInstanceLockHeld) return;");
  });
});

describe("test-build workflow publish contract", () => {
  it("rejects an unpackaged publish before packaging or publishing", () => {
    const workflow = fs.readFileSync(
      path.join(process.cwd(), ".github", "workflows", "test-build.yml"),
      "utf8",
    );
    const guard = workflow.indexOf("Reject a publish that cannot produce installable artifacts");
    expect(guard).toBeGreaterThan(0);
    expect(workflow).toContain(
      "if: ${{ inputs.publish && inputs.package == 'unpacked only (fastest)' }}",
    );
    // The guard runs before checkout, packaging and publishing.
    expect(guard).toBeLessThan(
      workflow.indexOf("build-pipeline.cjs --channel test --caller test --from stage-toolchain"),
    );
    expect(guard).toBeLessThan(workflow.indexOf("Fetch complete source"));
    // A published TEST build always ships installer + portable.
    expect(workflow).toContain('targets="nsis,portable"');
    expect(workflow).toContain('if [ "$pub" = "true" ] && [ "$targets" != "dir" ]');
  });
});
