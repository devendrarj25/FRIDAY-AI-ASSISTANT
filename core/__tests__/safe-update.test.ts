/**
 * FRIDAY · safe update guard
 *
 * Proves the rules the release/update system depends on:
 *   • a checksum mismatch or a non-newer version can never be installed
 *   • the protected FRIDAY data is copied aside before an install
 *   • a launch on the expected version marks it stable
 *   • a launch on the wrong version reports failure and can be rolled back
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

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

  it("never copies models into the per-update backup and never lists them as deletable", () => {
    expect(safety.PROTECTED).not.toContain("models");
    expect(safety.MUST_PRESERVE).toContain("models");
    expect(safety.MUST_PRESERVE).toContain("voices");
    expect(safety.MUST_PRESERVE).toEqual(expect.arrayContaining(safety.PROTECTED));
  });
});
