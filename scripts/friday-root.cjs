/**
 * The one place a script may discover the selected FRIDAY folder.
 *
 * Order: explicit env -> persisted settings pointer -> installer registry
 * entry. There is deliberately no C:\FRIDAY / %USERPROFILE%\FRIDAY guess: a
 * script that finds nothing uses a development-only folder inside the source
 * checkout and says so.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");

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
      if (value && fs.existsSync(value)) return value;
    } catch {
      /* no pointer here */
    }
  }
  return null;
}

function fromRegistry() {
  if (process.platform !== "win32") return null;
  const out = spawnSync("reg", ["query", "HKCU\\Software\\FRIDAY", "/v", "WorkspacePath"], {
    encoding: "utf8",
  });
  if (out.status !== 0) return null;
  const match = /WorkspacePath\s+REG_SZ\s+(.+)/i.exec(out.stdout || "");
  const value = match ? match[1].trim() : null;
  return value && fs.existsSync(value) ? value : null;
}

/** The selected FRIDAY home, or null when the user has not chosen one yet. */
function findWorkspaceRoot() {
  const explicit = process.env.FRIDAY_WORKSPACE_ROOT;
  if (explicit) return path.resolve(explicit);
  return fromSettingsPointer() || fromRegistry();
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

module.exports = { projectRoot, findWorkspaceRoot, workspaceRootOrDev, layout };
