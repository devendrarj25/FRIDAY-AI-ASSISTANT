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

/** The selected FRIDAY home, or null when the user has not chosen one yet. */
function findWorkspaceRoot() {
  const explicit = process.env.FRIDAY_WORKSPACE_ROOT;
  if (explicit) return path.resolve(explicit);
  return fromRegistry() || fromSettingsPointer();
}

/**
 * Root to use for a script that must write something now. Falls back to a
 * clearly named development folder inside the checkout — never the user home.
 */
function workspaceRootOrDev() {
  const found = findWorkspaceRoot();
  if (found) return { root: found, development: false };
  return { root: path.join(projectRoot, ".friday-dev"), development: true };
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
  workspaceRootOrDev,
  layout,
  RUNTIME_FOLDERS,
  THROWAWAY_ROOT,
  isThrowawayRoot,
};
