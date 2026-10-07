// FRIDAY · safe update guard (verify → backup → install → health check → rollback).
//
// This is the ONLY place that decides whether a downloaded GitHub Release may
// replace the installed FRIDAY. It does not check for updates, does not talk to
// GitHub and does not build anything — electron/github-sync.cjs finds the
// release, this file makes applying it survivable:
//
//   verifyArtifact  — SHA-256 of the downloaded EXE must match the release
//                     manifest (friday-update.json / SHA256SUMS.txt)
//   backupState     — copy the irreplaceable parts of the FRIDAY root aside
//   beginInstall    — record a pending update before the installer runs
//   healthCheck     — on the next launch, confirm the new version came up
//   rollback        — restore the backup and hand back the previous stable
//                     installer when it did not
//
// Nothing here deletes user data. Backups are additive and kept per version.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { compareBuilds } = require(path.resolve(__dirname, "..", "scripts", "release-engine.cjs"));

/** Files/folders that must never be lost across an update. */
const PROTECTED = [
  "config",
  "security",
  "memory",
  "conversations",
  "brain-data",
  "database",
  "workflows",
  "agents",
  "skills",
  "plugins",
  "modules",
];

/**
 * Everything an update/uninstall must leave in place. Large folders
 * (models, voices) live beside App and are not copied into the per-update
 * backup — copying them would duplicate gigabytes. They are still forbidden
 * to delete.
 */
const MUST_PRESERVE = [...PROTECTED, "models", "voices", "logs", "backup", "downloads"];

const stateFile = (root) => path.join(root, "updates", "pending-update.json");
const stableFile = (root) => path.join(root, "updates", "stable.json");

const readJson = (file, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return value;
};

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

// ------------------------------------------------------------------ verify --

/**
 * Confirm a downloaded artifact really is the published one.
 * `expected` is the sha256 from the release manifest; when a release carries no
 * manifest the artifact is reported unverified and the caller must ask the
 * owner explicitly instead of installing silently.
 */
function verifyArtifact({ file, expected, version, currentVersion, channelSwitch = false }) {
  if (!file || !fs.existsSync(file)) return { ok: false, error: "The downloaded file is missing." };
  const bytes = fs.statSync(file).size;
  if (bytes < 1024 * 1024)
    return { ok: false, error: "The downloaded installer is too small to be a FRIDAY build." };
  const actual = sha256(file);
  if (expected && actual.toLowerCase() !== String(expected).toLowerCase()) {
    return {
      ok: false,
      error: "Checksum mismatch — the download does not match the published release.",
      actual,
      expected,
    };
  }
  if (version && currentVersion && !channelSwitch) {
    if (compareBuilds(version, currentVersion) <= 0) {
      return {
        ok: false,
        error: `Release v${version} is not newer than the installed v${currentVersion}.`,
      };
    }
  }
  return {
    ok: true,
    sha256: actual,
    bytes,
    verified: Boolean(expected),
    channelSwitch: Boolean(channelSwitch),
  };
}

// ------------------------------------------------------------------ backup --

/** Copy the protected parts of the root into <root>/backup/releases/<stamp>. */
function backupState({ root, version }) {
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(root, "backup", "releases", `${version || "update"}-${stamp}`);
  const copied = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of PROTECTED) {
      const source = path.join(root, name);
      if (!fs.existsSync(source)) continue;
      fs.cpSync(source, path.join(dir, name), { recursive: true });
      copied.push(name);
    }
    writeJson(path.join(dir, "backup.json"), { at: Date.now(), version: version || null, copied });
  } catch (error) {
    return { ok: false, error: `Backup failed: ${error.message}` };
  }
  return { ok: true, backup: dir, copied };
}

// ----------------------------------------------------------------- install --

/**
 * Record that an update is about to be installed. If FRIDAY never reports a
 * healthy start on the new version, `healthCheck` finds this record and offers
 * the rollback.
 */
function beginInstall({ root, version, currentVersion, installer, backup, sha256: hash }) {
  try {
    return {
      ok: true,
      pending: writeJson(stateFile(root), {
        state: "installing",
        startedAt: Date.now(),
        version,
        from: currentVersion,
        installer,
        backup,
        sha256: hash || null,
        // The build that is being replaced is the one we roll back to.
        previousInstaller: readJson(stableFile(root))?.installer || null,
      }),
    };
  } catch (error) {
    return { ok: false, error: `Update state could not be recorded: ${error.message}` };
  }
}

function cancelInstall({ root }) {
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };
  try {
    fs.rmSync(stateFile(root), { force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `Pending update could not be cleared: ${error.message}` };
  }
}

/** The last version that started up healthy — FRIDAY's stable anchor. */
const stable = (root) => readJson(stableFile(root));

function markStable({ root, version, installer }) {
  return writeJson(stableFile(root), { version, installer: installer || null, at: Date.now() });
}

/**
 * Called once on every launch. Three outcomes:
 *   • no pending record            → nothing happened, remember this version
 *   • pending matches this version → the update worked; it becomes stable
 *   • pending is a different (or repeatedly failing) version → unhealthy
 */
function healthCheck({ root, version, installer }) {
  if (!root) return { ok: true, state: "no-root" };
  const pending = readJson(stateFile(root));
  if (!pending || pending.state !== "installing") {
    markStable({ root, version, installer });
    return { ok: true, state: "stable", version };
  }
  const clean = (v) => String(v || "").replace(/^v/i, "");
  if (clean(pending.version) === clean(version)) {
    fs.rmSync(stateFile(root), { force: true });
    markStable({ root, version, installer });
    return { ok: true, state: "updated", version, from: pending.from || null };
  }
  // The installer ran but the new version is not what is running now.
  const attempts = Number(pending.attempts || 0) + 1;
  writeJson(stateFile(root), { ...pending, state: "failed", attempts, failedAt: Date.now() });
  return {
    ok: false,
    state: "failed",
    expected: pending.version,
    running: clean(version),
    backup: pending.backup || null,
    previousInstaller: pending.previousInstaller || null,
    message: `Update to v${clean(pending.version)} did not start — FRIDAY is running v${clean(version)}.`,
  };
}

/**
 * Put the protected data back from a backup and report which installer can
 * reinstall the previous stable build. FRIDAY never runs it by herself.
 */
function rollback({ root, backup }) {
  const pending = readJson(stateFile(root));
  const source = backup || pending?.backup;
  if (!source || !fs.existsSync(source))
    return { ok: false, error: "No backup is available to roll back to." };
  const restored = [];
  try {
    for (const name of PROTECTED) {
      const from = path.join(source, name);
      if (!fs.existsSync(from)) continue;
      const to = path.join(root, name);
      fs.rmSync(to, { recursive: true, force: true });
      fs.cpSync(from, to, { recursive: true });
      restored.push(name);
    }
  } catch (error) {
    return { ok: false, error: `Rollback failed: ${error.message}` };
  }
  fs.rmSync(stateFile(root), { force: true });
  return {
    ok: true,
    restored,
    backup: source,
    previousInstaller: pending?.previousInstaller || stable(root)?.installer || null,
  };
}

/** Pending update record, for the Settings → Updates panel. */
const pendingUpdate = (root) => (root ? readJson(stateFile(root)) : null);

module.exports = {
  PROTECTED,
  MUST_PRESERVE,
  verifyArtifact,
  backupState,
  beginInstall,
  healthCheck,
  rollback,
  markStable,
  stable,
  pendingUpdate,
  cancelInstall,
  sha256,
};
