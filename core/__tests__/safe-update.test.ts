/**
 * FRIDAY · safe update guard
 *
 * Proves the rules the release/update system depends on:
 *   • a checksum mismatch or a non-newer version can never be installed
 *   • the protected FRIDAY data is copied aside before an install
 *   • a launch on the expected version marks it stable
 *   • a launch on the wrong version reports failure and can be rolled back
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { appliedMigrations, runMigrations } from "../../installer/migration";

const require = createRequire(import.meta.url);
const safety = require(path.resolve(process.cwd(), "electron/update-safety.cjs"));

let root = "";

const makeInstaller = (dir: string) => {
  const file = path.join(dir, "FRIDAY-Setup-2.0.0.exe");
  fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024, 7));
  return { file, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-update-"));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "settings.json"), '{"voice":"swara"}');
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("update verification", () => {
  it("rejects an artifact whose checksum does not match the release", () => {
    const { file } = makeInstaller(root);
    const result = safety.verifyArtifact({ file, expected: "deadbeef" });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/checksum/i);
  });

  it("accepts the published artifact and reports it verified", () => {
    const { file, sha256 } = makeInstaller(root);
    const result = safety.verifyArtifact({
      file,
      expected: sha256,
      version: "2.0.0",
      currentVersion: "1.9.0",
    });
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);
  });

  it("checks the update manifest sha512 before the installer smoke calls a build healthy", () => {
    const smoke = fs.readFileSync(
      path.resolve(process.cwd(), "scripts/windows-installer-smoke.ps1"),
      "utf8",
    );
    expect(smoke).toContain("sha512:");
    expect(smoke).toContain("update manifest");
    expect(smoke).toContain("Verify-UpdateManifest");
  });

  it("never installs a version that is not newer than the running one", () => {
    const { file, sha256 } = makeInstaller(root);
    const result = safety.verifyArtifact({
      file,
      expected: sha256,
      version: "1.0.0",
      currentVersion: "1.2.0",
    });
    expect(result.ok).toBe(false);
  });
});

describe("backup, health check and rollback", () => {
  it("copies protected data aside before an install", () => {
    const backup = safety.backupState({ root, version: "2.0.0" });
    expect(backup.ok).toBe(true);
    expect(backup.copied).toContain("config");
    expect(fs.existsSync(path.join(backup.backup, "config", "settings.json"))).toBe(true);
  });

  it("marks the new version stable when it starts up", () => {
    const backup = safety.backupState({ root, version: "2.0.0" });
    safety.beginInstall({ root, version: "2.0.0", currentVersion: "1.9.0", backup: backup.backup });
    const health = safety.healthCheck({ root, version: "2.0.0" });
    expect(health.ok).toBe(true);
    expect(health.state).toBe("updated");
    expect(safety.stable(root)?.version).toBe("2.0.0");
  });

  it("can cancel a pending installer handoff without touching the backup", () => {
    const backup = safety.backupState({ root, version: "2.0.0" });
    safety.beginInstall({ root, version: "2.0.0", currentVersion: "1.9.0", backup: backup.backup });
    expect(safety.pendingUpdate(root)?.state).toBe("installing");
    expect(safety.cancelInstall({ root }).ok).toBe(true);
    expect(safety.pendingUpdate(root)).toBeNull();
    expect(fs.existsSync(path.join(backup.backup, "config", "settings.json"))).toBe(true);
  });

  it("reports failure and restores the backup when the update did not come up", () => {
    const backup = safety.backupState({ root, version: "2.0.0" });
    safety.beginInstall({ root, version: "2.0.0", currentVersion: "1.9.0", backup: backup.backup });
    // The installer ran but the old build is still what launched.
    const health = safety.healthCheck({ root, version: "1.9.0" });
    expect(health.ok).toBe(false);
    expect(health.state).toBe("failed");

    fs.rmSync(path.join(root, "config", "settings.json"), { force: true });
    const rolled = safety.rollback({ root, backup: health.backup });
    expect(rolled.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, "config", "settings.json"), "utf8")).toContain("swara");
  });

  it("restores the sqlite folder from the backup (kernel must be stopped by the caller first)", () => {
    fs.mkdirSync(path.join(root, "database"), { recursive: true });
    fs.writeFileSync(path.join(root, "database", "friday.sqlite3"), "v1-bytes");
    const backup = safety.backupState({ root, version: "2.0.0" });
    safety.beginInstall({ root, version: "2.0.0", currentVersion: "1.9.0", backup: backup.backup });
    fs.writeFileSync(path.join(root, "database", "friday.sqlite3"), "v2-bytes");
    const rolled = safety.rollback({ root, backup: backup.backup });
    expect(rolled.ok).toBe(true);
    expect(rolled.restored).toContain("database");
    expect(fs.readFileSync(path.join(root, "database", "friday.sqlite3"), "utf8")).toBe("v1-bytes");
  });

  it("leaves no staging folder behind after a rollback", () => {
    const backup = safety.backupState({ root, version: "2.0.0" });
    safety.beginInstall({ root, version: "2.0.0", currentVersion: "1.9.0", backup: backup.backup });
    expect(safety.rollback({ root, backup: backup.backup }).ok).toBe(true);
    expect(fs.readdirSync(root).filter((name) => name.endsWith(".restoring"))).toEqual([]);
  });

  it("keeps the current folder whole when the restore copy fails halfway", () => {
    const backup = safety.backupState({ root, version: "2.0.0" });
    safety.beginInstall({ root, version: "2.0.0", currentVersion: "1.9.0", backup: backup.backup });
    fs.writeFileSync(path.join(root, "config", "settings.json"), '{"voice":"newer"}');
    const spy = vi.spyOn(fs, "cpSync").mockImplementation(() => {
      throw new Error("ENOSPC: no space left on device");
    });
    try {
      const rolled = safety.rollback({ root, backup: backup.backup });
      expect(rolled.ok).toBe(false);
      expect(String(rolled.error)).toMatch(/Rollback failed.*ENOSPC/);
    } finally {
      spy.mockRestore();
    }
    // The folder that was running is untouched, and nothing half-restored is left beside it.
    expect(fs.readFileSync(path.join(root, "config", "settings.json"), "utf8")).toContain("newer");
    expect(fs.readdirSync(root).filter((name) => name.endsWith(".restoring"))).toEqual([]);
    // The pending record stays, so the owner can try the rollback again.
    expect(safety.pendingUpdate(root)?.state).toBe("installing");
  });

  it("never copies models into the per-update backup and never lists them as deletable", () => {
    expect(safety.PROTECTED).not.toContain("models");
    expect(safety.MUST_PRESERVE).toContain("models");
    expect(safety.MUST_PRESERVE).toContain("voices");
    expect(safety.MUST_PRESERVE).toEqual(expect.arrayContaining(safety.PROTECTED));
  });
});

describe("installer pruning keeps the rollback target", () => {
  const dir = () => path.join(root, "updates", "installers");
  const seed = (names: string[]) => {
    fs.mkdirSync(dir(), { recursive: true });
    // names[0] is the newest; every file gets its own, strictly older timestamp.
    names.forEach((name, index) => {
      const file = path.join(dir(), name);
      fs.writeFileSync(file, "x");
      const when = new Date(Date.UTC(2026, 0, 30 - index));
      fs.utimesSync(file, when, when);
    });
  };
  const left = () => fs.readdirSync(dir()).sort();

  it("keeps the installer named by stable.json even when it is older than the newest two", () => {
    seed([
      "FRIDAY-Setup-1.2.5.9.exe",
      "FRIDAY-Setup-1.2.5.8.exe",
      "FRIDAY-Setup-1.2.5.7.exe",
      "FRIDAY-Setup-1.2.5.6.exe",
    ]);
    safety.markStable({
      root,
      version: "1.2.5.6",
      installer: path.join(dir(), "FRIDAY-Setup-1.2.5.6.exe"),
    });
    const out = safety.pruneInstallers({ root, keep: 2 });
    expect(out.removed).toEqual(["FRIDAY-Setup-1.2.5.7.exe"]);
    expect(left()).toEqual([
      "FRIDAY-Setup-1.2.5.6.exe",
      "FRIDAY-Setup-1.2.5.8.exe",
      "FRIDAY-Setup-1.2.5.9.exe",
    ]);
  });

  it("finds the stable installer when stable.json holds a Windows path or a bare name", () => {
    seed(["a-3.exe", "a-2.exe", "a-1.exe", "a-0.exe"]);
    safety.markStable({
      root,
      version: "0",
      installer: "D:\\FRIDAY\\updates\\installers\\a-0.exe",
    });
    safety.pruneInstallers({ root, keep: 2 });
    expect(left()).toContain("a-0.exe");
    safety.markStable({ root, version: "1", installer: "a-1.exe" });
    seed(["a-3.exe", "a-2.exe", "a-1.exe", "a-0.exe"]);
    safety.pruneInstallers({ root, keep: 2 });
    expect(left()).toEqual(["a-1.exe", "a-2.exe", "a-3.exe"]);
  });

  it("keeps the previous installer a pending update will roll back to, and its blockmap", () => {
    seed(["n-3.exe", "n-2.exe", "n-1.exe", "n-0.exe"]);
    fs.writeFileSync(path.join(dir(), "n-0.exe.blockmap"), "map");
    safety.markStable({ root, version: "n-0", installer: "n-0.exe" });
    safety.beginInstall({ root, version: "n-3", currentVersion: "n-0", installer: "n-3.exe" });
    // Only the pending record names the rollback target now.
    fs.rmSync(path.join(root, "updates", "stable.json"));
    safety.pruneInstallers({ root, keep: 2 });
    expect(left()).toEqual(["n-0.exe", "n-0.exe.blockmap", "n-2.exe", "n-3.exe"]);
  });

  it("still keeps the newest two and removes the rest when there is no stable record", () => {
    seed(["z-3.exe", "z-2.exe", "z-1.exe", "z-0.exe"]);
    const out = safety.pruneInstallers({ root, keep: 2 });
    expect(out.removed.sort()).toEqual(["z-0.exe", "z-1.exe"]);
    expect(left()).toEqual(["z-2.exe", "z-3.exe"]);
  });

  it("never lets a stable record point outside the installers folder", () => {
    seed(["q-2.exe", "q-1.exe", "q-0.exe"]);
    const outside = path.join(root, "keep-me.exe");
    fs.writeFileSync(outside, "x");
    safety.markStable({ root, version: "0", installer: "../../keep-me.exe" });
    safety.pruneInstallers({ root, keep: 2 });
    expect(left()).toEqual(["q-1.exe", "q-2.exe"]);
    expect(fs.existsSync(outside)).toBe(true);
  });
});

describe("migration ledger records the app version", () => {
  it("stamps each newly applied migration with the version that applied it", () => {
    const applied = runMigrations(root, "1.2.5.8");
    expect(applied.length).toBeGreaterThan(0);
    for (const record of applied) expect(record.appVersion).toBe("1.2.5.8");
    expect(appliedMigrations(root)).toEqual(applied);
  });

  it("is idempotent: a later run never re-applies or re-stamps a recorded migration", () => {
    const first = runMigrations(root, "1.2.5.8");
    const second = runMigrations(root, "1.2.5.9");
    expect(second).toEqual(first);
  });

  it("keeps an old ledger row without appVersion as it is and still reads it", () => {
    fs.mkdirSync(path.join(root, "database"), { recursive: true });
    const old = [{ id: "0001-config-capabilities", appliedAt: 5 }];
    fs.writeFileSync(path.join(root, "database", "migrations.json"), JSON.stringify(old));
    expect(runMigrations(root, "1.2.5.8")).toEqual(old);
  });

  it("omits the field when no version is given", () => {
    const applied = runMigrations(root);
    for (const record of applied) expect(record).not.toHaveProperty("appVersion");
  });
});
