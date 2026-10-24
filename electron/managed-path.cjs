/**
 * The folders of tools FRIDAY installed for herself (runtime\<tool>\...), as one
 * PATH addition.
 *
 * A tool unpacked into <FRIDAY folder>\runtime is only useful if the things
 * FRIDAY starts can find it: the terminal, agents, the sandbox and the kernel's
 * command tools. The list is appended to PATH (after the system's own entries,
 * so an installed Git or Node still wins) and written to
 * runtime\managed-path.json, which the kernel reads for the commands it spawns.
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
  const dirs = managedBinDirs(root, tools, io.exists);
  if (!root) return { dirs: [], changed: false };
  const next = withManagedPath(env.PATH, dirs);
  const changed = next !== env.PATH;
  env.PATH = next;
  try {
    const file = path.join(root, "runtime", FILE);
    const body = JSON.stringify({ dirs, at: Date.now() });
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

module.exports = { FILE, toolDir, managedBinDirs, withManagedPath, applyManagedPath };
