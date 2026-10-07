// Update checks for the app, plugins, modules, workflows, themes and deps.
// Nothing is ever installed without an explicit user answer.
const fs = require("fs");
const path = require("path");
const { compareBuilds } = require(path.resolve(__dirname, "..", "scripts", "release-engine.cjs"));

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

// Manifests may declare { updateUrl } returning { version, notes, download }.
async function checkManifestUpdates(items, kind) {
  const updates = [];
  for (const item of items) {
    const manifest = item.manifestFile ? readJson(item.manifestFile) : null;
    const url = manifest?.updateUrl;
    if (!url) continue;
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) continue;
      const remote = await res.json();
      if (remote?.version && remote.version !== item.version) {
        updates.push({
          kind,
          id: item.id,
          name: item.name,
          current: item.version,
          available: remote.version,
          notes: remote.notes || "",
          download: remote.download || null,
        });
      }
    } catch {
      /* offline or unreachable feed — silently skipped */
    }
  }
  return updates;
}

/**
 * The application itself has exactly ONE update path: verified GitHub releases
 * (electron/github-sync.cjs · checkUpdate → downloadInstaller → install-update),
 * which knows the TEST and OFFICIAL channels, the release manifest checksums
 * and the owner approval + restart flow. This module never re-implements it and
 * never reads a second private JSON feed; main.cjs injects `appUpdate`, an async
 * resolver backed by that same real flow, so the Updates panel keeps listing the
 * application alongside plugins, modules, workflows and themes.
 */
async function checkAppUpdate(currentVersion, appUpdate) {
  if (typeof appUpdate !== "function") return null;
  try {
    const found = await appUpdate(currentVersion);
    if (!found?.available) return null;
    // Public four-part identity (1.0.0.0) equals the npm encoding (1.0.0).
    // String equality would offer a fake update across that pair, or miss a
    // real 1.0.0.1. github-sync already uses compareBuilds; this guard must too.
    if (compareBuilds(found.available, currentVersion) <= 0) return null;
    return {
      kind: "application",
      id: "friday",
      name: "FRIDAY",
      current: currentVersion,
      available: found.available,
      channel: found.channel || "stable",
      testBuild: Boolean(found.testBuild),
      notes: found.notes || "",
      // Application installs are handled by the release channel, not by the
      // generic download/extract path below.
      download: null,
      managedByReleaseChannel: true,
    };
  } catch {
    return null;
  }
}

/** Collect every pending update. The renderer decides what happens next. */
async function checkAllUpdates({ version, scan, appUpdate }) {
  const results = [];
  const app = await checkAppUpdate(version, appUpdate);
  if (app) results.push(app);
  results.push(
    ...(await checkManifestUpdates(scan?.plugins || [], "plugin")),
    ...(await checkManifestUpdates(scan?.modules || [], "module")),
    ...(await checkManifestUpdates(scan?.workflows || [], "workflow")),
  );
  const themesDir = scan?.root ? path.join(scan.root, "Themes") : null;
  if (themesDir && fs.existsSync(themesDir)) {
    const themes = fs
      .readdirSync(themesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({
        id: e.name,
        name: e.name,
        version: readJson(path.join(themesDir, e.name, "theme.json"))?.version || null,
        manifestFile: path.join(themesDir, e.name, "theme.json"),
      }));
    results.push(...(await checkManifestUpdates(themes, "theme")));
  }
  return { checkedAt: Date.now(), updates: results };
}

// --------------------------------------------------------------- applying ---
// Applying is deliberately conservative: download to <root>/updates, verify the
// bytes arrived, copy the current artifact to <root>/backups, swap, and record
// enough information for a one-click rollback.

const { execFile } = require("child_process");

const run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 120000 }, (err, stdout, stderr) =>
      resolve({ ok: !err, output: String(stdout || stderr || "") }),
    );
  });

function folderFor(root, kind, id) {
  const folders = {
    plugin: "plugins",
    module: "modules",
    workflow: "workflows",
    theme: "themes",
    agent: "agents",
    skill: "skills",
  };
  const folder = folders[kind];
  return folder ? path.join(root, folder, id) : null;
}

async function download(url, target) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error("Download was empty");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buffer);
  return { file: target, bytes: buffer.length };
}

async function extract(archive, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  if (process.platform === "win32") {
    const result = await run("powershell", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${targetDir}' -Force`,
    ]);
    if (result.ok) return true;
  }
  const tar = await run("tar", ["-xf", archive, "-C", targetDir]);
  if (tar.ok) return true;
  const unzip = await run("unzip", ["-o", archive, "-d", targetDir]);
  return unzip.ok;
}

/**
 * Apply one update. Returns { ok, backup, restartRequired } so the caller can
 * offer a rollback and, when the shell itself changed, ask for a restart.
 */
async function applyUpdate({ root, update, onProgress = () => {}, installApp = null }) {
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };

  // The application is installed by the verified release channel only, so this
  // path hands over to it instead of downloading a second, unverified artifact.
  if (update?.kind === "application") {
    if (typeof installApp !== "function") {
      return {
        ok: false,
        error:
          "Application updates are installed from Settings → Updates (GitHub release channel).",
      };
    }
    onProgress({ id: update.id || "friday", phase: "Downloading" });
    const handed = await installApp(update);
    return { restartRequired: true, manual: true, ...handed };
  }

  if (!update?.download) {
    return { ok: false, error: "This update does not publish a download URL." };
  }

  const stamp = Date.now();
  const updatesDir = path.join(root, "updates");
  const backupsDir = path.join(root, "backups");
  const ext = path.extname(new URL(update.download).pathname) || ".bin";
  const file = path.join(updatesDir, `${update.kind}-${update.id}-${update.available}${ext}`);

  onProgress({ id: update.id, phase: "Downloading" });
  let downloaded;
  try {
    downloaded = await download(update.download, file);
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }

  const target = folderFor(root, update.kind, update.id);
  if (!target) return { ok: false, error: `Unsupported update type "${update.kind}".` };

  let backup = null;
  if (fs.existsSync(target)) {
    onProgress({ id: update.id, phase: "Backing up" });
    backup = path.join(backupsDir, `${update.kind}-${update.id}-${stamp}`);
    fs.mkdirSync(backupsDir, { recursive: true });
    fs.cpSync(target, backup, { recursive: true });
  }

  onProgress({ id: update.id, phase: "Installing" });
  const staging = path.join(updatesDir, `staging-${update.id}-${stamp}`);
  const extracted = await extract(downloaded.file, staging);
  if (!extracted) {
    fs.rmSync(staging, { recursive: true, force: true });
    return { ok: false, error: "The downloaded package could not be extracted." };
  }

  // A package may wrap its contents in a single top-level folder.
  const entries = fs.readdirSync(staging, { withFileTypes: true });
  const source =
    entries.length === 1 && entries[0].isDirectory()
      ? path.join(staging, entries[0].name)
      : staging;

  try {
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(source, target, { recursive: true });
  } catch (error) {
    if (backup) fs.cpSync(backup, target, { recursive: true });
    return { ok: false, error: `Install failed and was rolled back: ${error.message}` };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }

  return {
    ok: true,
    kind: update.kind,
    id: update.id,
    version: update.available,
    backup,
    target,
    // Only the shell needs a restart; workspace content is hot-reloaded.
    restartRequired: false,
  };
}

/** Put a backup produced by applyUpdate back in place. */
function rollbackUpdate({ backup, target }) {
  if (!backup || !fs.existsSync(backup)) {
    return { ok: false, error: "No backup is available for this update." };
  }
  try {
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(backup, target, { recursive: true });
    return { ok: true, restored: target };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

module.exports = { checkAllUpdates, applyUpdate, rollbackUpdate };
