/**
 * The one place a script may discover the selected FRIDAY folder.
 *
 * Order: explicit env -> installer registry entry -> persisted settings
 * pointer — the same order the app uses (electron/main.cjs
 * resolveWorkspaceRoot), so Setup and the app always pick the same folder.
 * There is deliberately no C:\FRIDAY / %USERPROFILE%\FRIDAY guess: a script
 * that finds nothing uses a development-only folder inside the source
 * checkout and says so.
 *
 * A recorded folder inside a test sandbox (the installer smoke or readiness
 * run under %TEMP%) is never a real FRIDAY home: an interrupted test can leave
 * such a pointer behind, and Setup must not install the runtime there.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");

/** Test sandboxes created by windows-installer-smoke.ps1 and readiness-test.cjs. */
const THROWAWAY_ROOT =
  /[\\/]_?(?:temp|tmp)[\\/](?:friday-installer-smoke-[0-9a-f]{32}|friday-readiness-[A-Za-z0-9]{6})(?:[\\/]|$)/i;

function isThrowawayRoot(value) {
  return Boolean(value) && THROWAWAY_ROOT.test(String(value));
}

function fromSettingsPointer() {
  const appData =
    process.env.APPDATA ||
    (process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : path.join(os.homedir(), ".config"));
  for (const name of ["FRIDAY", "friday", "friday-desk"]) {
    const file = path.join(appData, name, "friday-settings.json");
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8")).workspaceRoot;
      if (value && !isThrowawayRoot(value) && fs.existsSync(value)) return value;
    } catch {
      /* no pointer here */
    }
  }
  return null;
}

function fromRegistry() {
  if (process.platform !== "win32") return null;
  // reg.exe with no timeout has hung a GUI boot on CI. The same 8s bound the
  // main process uses. windowsHide stops the console allocation deadlock.
  const out = spawnSync("reg", ["query", "HKCU\\Software\\FRIDAY", "/v", "WorkspacePath"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 8000,
  });
  if (out.error || out.status !== 0) return null;
  const match = /WorkspacePath\s+REG_SZ\s+(.+)/i.exec(out.stdout || "");
  const value = match ? match[1].trim() : null;
  return value && !isThrowawayRoot(value) && fs.existsSync(value) ? value : null;
}

/**
 * FRIDAY installed into its own checkout (<checkout>\App\FRIDAY.exe next to
 * <checkout>\database\friday.sqlite3). The checkout is then the home, even
 * when the registry entry or settings pointer is gone, so a rebuild keeps
 * using the folder the installed app already uses instead of a second copy of
 * every model under .friday-dev.
 */
function fromOwnCheckout(project = projectRoot) {
  const installed = ["FRIDAY.exe", "FRIDAY"].some((name) =>
    fs.existsSync(path.join(project, "App", name)),
  );
  const hasData = fs.existsSync(path.join(project, "database", "friday.sqlite3"));
  return installed && hasData && !isThrowawayRoot(project) ? project : null;
}

/** The selected FRIDAY home, or null when the user has not chosen one yet. */
function findWorkspaceRoot() {
  const explicit = process.env.FRIDAY_WORKSPACE_ROOT;
  if (explicit) return path.resolve(explicit);
  return fromRegistry() || fromSettingsPointer() || fromOwnCheckout();
}

/**
 * The folder the setup CMD runs in is FRIDAY's home when nothing else has been chosen: the checkout can be named
 * anything and sit anywhere, because the path comes from where this script lives, never from a guessed name.
 * A program-files, Windows, node_modules or unwritable folder is never a home, and neither is a test sandbox.
 */
function isUsableHome(project = projectRoot) {
  if (!project || isThrowawayRoot(project)) return false;
  const lowered = `${String(project).toLowerCase().replace(/\//g, "\\")}\\`;
  if (/\\(program files( \(x86\))?|windows|node_modules)\\/.test(lowered)) return false;
  try {
    fs.accessSync(project, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

let recordedCheckout = false;

/**
 * Writes the checkout into HKCU\Software\FRIDAY\WorkspacePath, the key the installer wizard reads for its
 * default folder and the app reads first, so setup, the build, the installer and the installed app all name the
 * same folder. Only called when no other folder was chosen; never throws; once per process.
 */
function recordWorkspaceRoot(root) {
  if (process.platform !== "win32" || recordedCheckout) return false;
  // A hosted runner is thrown away; it must not leave a registry pointer behind or depend on one.
  if (process.env.CI || process.env.GITHUB_ACTIONS) return false;
  recordedCheckout = true;
  const out = spawnSync(
    "reg",
    ["add", "HKCU\\Software\\FRIDAY", "/v", "WorkspacePath", "/t", "REG_SZ", "/d", root, "/f"],
    { encoding: "utf8", windowsHide: true, timeout: 8000 },
  );
  return !out.error && out.status === 0;
}

/**
 * Root to use for a script that must write something now. On Windows, with no chosen folder, that is the folder
 * the setup CMD runs in (recorded so the installer and the app agree); elsewhere, or when that folder cannot be
 * a home, a clearly named development folder inside the checkout, never the user home.
 */
function workspaceRootOrDev({
  platform = process.platform,
  project = projectRoot,
  record = true,
} = {}) {
  const found = findWorkspaceRoot();
  if (found) return { root: found, development: false };
  if (platform === "win32" && isUsableHome(project)) {
    if (record) recordWorkspaceRoot(project);
    return { root: project, development: false, fromCheckout: true };
  }
  return { root: path.join(project, ".friday-dev"), development: true };
}

/** Runtime folders a checkout must ignore. Source trees are not in this list. */
const RUNTIME_FOLDERS = [
  "cache",
  "data",
  "voices",
  "downloads",
  "memory",
  "state",
  "knowledge",
  "library",
  "sandbox",
  "preferences",
  "database",
  "runtime",
  "logs",
];

/** Canonical data locations derived from one root. */
const layout = (root) => ({
  root,
  data: path.join(root, "data"),
  database: path.join(root, "database", "friday.sqlite3"),
  memory: path.join(root, "memory"),
  config: path.join(root, "config"),
  logs: path.join(root, "logs"),
  runtime: path.join(root, "runtime"),
  cache: path.join(root, "cache"),
});

module.exports = {
  projectRoot,
  findWorkspaceRoot,
  fromOwnCheckout,
  workspaceRootOrDev,
  isUsableHome,
  recordWorkspaceRoot,
  layout,
  RUNTIME_FOLDERS,
  THROWAWAY_ROOT,
  isThrowawayRoot,
};
