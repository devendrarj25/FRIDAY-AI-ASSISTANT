/**
 * The folders of tools FRIDAY installed for herself (runtime\<tool>\...), as one
 * PATH addition.
 *
 * A tool unpacked into <FRIDAY folder>\runtime is only useful if the things
 * FRIDAY starts can find it: the terminal, agents, the sandbox and the kernel's
 * command tools. The list is appended to PATH (after the system's own entries,
 * so an installed Git or Node still wins) and written to
 * runtime\managed-path.json, which the kernel reads for the commands it spawns.
 * The folders where PC-wide installs keep their commands (Go, Rust's cargo, CMake, 7-Zip ...) are
 * added the same way when they exist, so a tool installed by winget or its own installer is used
 * from where it is, even when this process started before the install and never saw its PATH entry.
 * Nothing here touches the registry or the system PATH.
 */
const fs = require("node:fs");
const path = require("node:path");

const { toolDir, installedBin } = require("./managed-install.cjs");

const FILE = "managed-path.json";

/**
 * Existing bin folders for archive-installed tools.
 * `tools` is the toolchain list; a tool counts when it unpacks an archive
 * (`archiveBin`) and is not a stored installer or data file (`storeOnly`).
 */
function managedBinDirs(root, tools, exists = fs.existsSync) {
  if (!root) return [];
  const out = [];
  const add = (dir) => {
    if (dir && !out.includes(dir) && exists(dir)) out.push(dir);
  };
  for (const tool of tools || []) {
    if (!tool.archiveBin || tool.storeOnly) continue;
    const found = installedBin(root, tool, exists);
    if (!found) continue;
    const dir = path.dirname(found.bin);
    add(dir);
    // A Python also exposes its Scripts folder (pip, wheels' entry points).
    if (/python\.exe$/i.test(found.bin)) add(path.join(dir, "Scripts"));
  }
  return out;
}

/**
 * Where tools installed for the whole PC (or per user) keep their commands when the installer did
 * not put them on this process's PATH: the folders the agent toolkit probes (config/agent-toolkit.json),
 * winget's link folder and cargo's. They are used from where they are, never copied or downloaded
 * again, and only the ones that exist are returned. Windows only.
 */
function machineToolDirs({
  env = process.env,
  exists = fs.existsSync,
  platform = process.platform,
  toolkit = null,
} = {}) {
  if (platform !== "win32") return [];
  // config/ sits beside the asar in the packed app, so it is read through the app's config loader.
  const entries =
    toolkit ||
    require("./resource-paths.cjs").readConfigJson("agent-toolkit.json", { prefetch: [] }).value;
  const expand = (text) =>
    String(text || "").replace(/%([^%]+)%/g, (_m, name) => env[name] ?? "\0");
  const home = env.USERPROFILE || "";
  const local = env.LOCALAPPDATA || (home ? path.join(home, "AppData", "Local") : "");
  const wanted = [
    ...(entries.prefetch || []).flatMap((entry) => entry.probe?.dirs || []).map(expand),
    local ? path.join(local, "Microsoft", "WinGet", "Links") : "",
    path.join(env.CARGO_HOME || (home ? path.join(home, ".cargo") : ""), "bin"),
  ];
  const out = [];
  for (const dir of wanted) {
    const key = dir.toLowerCase();
    if (dir && !dir.includes("\0") && !out.some((d) => d.toLowerCase() === key) && exists(dir)) {
      out.push(dir);
    }
  }
  return out;
}

/**
 * Folders that go in FRONT of PATH: the managed copy of a tool whose update FRIDAY installed beside an
 * older PC-wide copy (CMake from winget at 4.1, the vendor's 4.2 unpacked under runtime\\). Recorded
 * by the toolkit step only after it checked the managed copy is the newer one; read back on every
 * apply, so FRIDAY's own terminal, agents and scans use the newest copy. Nothing outside FRIDAY changes.
 */
function readFirst(root) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, "runtime", FILE), "utf8"));
    return Array.isArray(data.first) ? data.first.filter((d) => typeof d === "string") : [];
  } catch {
    return [];
  }
}

function preferManaged(root, dir) {
  if (!root || !dir) return false;
  const first = readFirst(root).filter((d) => d.toLowerCase() !== String(dir).toLowerCase());
  first.unshift(dir);
  try {
    const file = path.join(root, "runtime", FILE);
    let data = {};
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8")) || {};
    } catch {
      data = {};
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...data, first }));
    return true;
  } catch {
    return false;
  }
}

/** PATH with `dirs` moved or put in front (the same folder is never listed twice). */
function withFirstPath(currentPath, dirs, delimiter = path.delimiter) {
  const front = (dirs || []).filter(Boolean);
  const keys = new Set(front.map((d) => d.toLowerCase()));
  const rest = String(currentPath || "")
    .split(delimiter)
    .filter((part) => part && !keys.has(part.toLowerCase()));
  return [...front, ...rest].join(delimiter);
}

/** Append the managed folders to a PATH string without repeating any entry. */
function withManagedPath(currentPath, dirs, delimiter = path.delimiter) {
  const parts = String(currentPath || "")
    .split(delimiter)
    .filter(Boolean);
  const seen = new Set(parts.map((p) => p.toLowerCase()));
  for (const dir of dirs || []) {
    if (!seen.has(dir.toLowerCase())) {
      parts.push(dir);
      seen.add(dir.toLowerCase());
    }
  }
  return parts.join(delimiter);
}

/**
 * Apply the managed folders to this process (so every child inherits them) and
 * record them for the kernel. Returns what is now managed.
 */
function applyManagedPath(root, tools, env = process.env, io = {}) {
  if (!root) return { dirs: [], changed: false };
  const dirs = [
    ...managedBinDirs(root, tools, io.exists),
    ...machineToolDirs({ env, exists: io.exists, platform: io.platform }),
  ];
  const first = readFirst(root).filter((dir) => (io.exists || fs.existsSync)(dir));
  const next = withFirstPath(withManagedPath(env.PATH, dirs), first);
  const changed = next !== env.PATH;
  env.PATH = next;
  try {
    const file = path.join(root, "runtime", FILE);
    const body = JSON.stringify({ dirs, first: readFirst(root), at: Date.now() });
    const previous = (() => {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8")).dirs;
      } catch {
        return null;
      }
    })();
    if (JSON.stringify(previous) !== JSON.stringify(dirs)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
    }
  } catch {
    /* the list is a convenience; a read-only root must not break a scan */
  }
  return { dirs, changed };
}

module.exports = {
  FILE,
  toolDir,
  managedBinDirs,
  machineToolDirs,
  withManagedPath,
  withFirstPath,
  readFirst,
  preferManaged,
  applyManagedPath,
};
