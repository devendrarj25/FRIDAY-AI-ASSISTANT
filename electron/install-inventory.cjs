/**
 * FRIDAY · install inventory
 *
 * Everything FRIDAY uses is installed in one of a few homes, and the Install
 * Manager decides which one from how the thing is installed, not from a guess:
 *
 *   friday-python-env  pip libraries, in the managed environment <root>/runtime/.venv
 *   friday-runtime     tools FRIDAY unpacked herself, <root>/runtime/<id>
 *   friday-models      model files, <root>/models
 *   friday-speech      speech weights, <root>/cache/stt
 *   machine            winget and vendor installers (Git, Docker, CUDA, ...): they
 *                      need Windows' own folders, services and PATH, so they stay
 *                      there and are only recorded here
 *   npm-global         npm -g packages, in the user's npm prefix
 *
 * None of these is <root>/App. The program folder is replaced by every update;
 * everything above is read by FRIDAY from where it is and survives an update,
 * a reinstall and a normal uninstall. "Delete all FRIDAY data" removes the
 * friday-* homes (they live in the root) and never touches machine installs.
 *
 * `inventory.json` in the root is the readable record of that: one row per
 * thing with its home, path, version and whether a newer one exists, rebuilt
 * from the real scan (`tools:detect`) and the real folders. It adds no second
 * installer or detector; it only writes down what those found.
 */
const fs = require("node:fs");
const path = require("node:path");

const FILE = "inventory.json";

const HOMES = {
  "friday-python-env": { inRoot: true, label: "FRIDAY Python environment (runtime/.venv)" },
  "friday-runtime": { inRoot: true, label: "FRIDAY runtime tools (runtime/<tool>)" },
  "friday-models": { inRoot: true, label: "Models (models)" },
  "friday-speech": { inRoot: true, label: "Speech weights (cache/stt)" },
  machine: { inRoot: false, label: "This PC (Windows folders, PATH, services)" },
  "npm-global": { inRoot: false, label: "npm global packages (the user's npm prefix)" },
};

const inside = (child, parent) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/** Home of an installed or planned tool. `where` is the executable or package path, when known. */
function homeOf(tool, root) {
  if (tool.manager === "pip") return "friday-python-env";
  if (tool.manager === "npm") return "npm-global";
  if (root && tool.path && inside(tool.path, path.join(root, "runtime"))) return "friday-runtime";
  if (tool.manager === "vendor" && !tool.path) return "friday-runtime";
  return "machine";
}

const numbers = (value) =>
  String(value || "")
    .replace(/^v/i, "")
    .split(/[^\d]+/)
    .filter(Boolean)
    .map(Number);

function newer(latest, installed) {
  const a = numbers(latest);
  const b = numbers(installed);
  if (!a.length || !b.length) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

const latestOf = (value) =>
  value && typeof value === "object" ? value.version || value.latest || null : value || null;

function toolRow(tool, root, latest) {
  const home = homeOf(tool, root);
  const seen = latestOf(latest?.[tool.id]);
  const installed = Boolean(tool.installed);
  return {
    id: tool.id,
    category: tool.category || "Tool",
    installed,
    status: tool.status || (installed ? "Ready" : "Missing"),
    version: tool.version || null,
    latest: seen || null,
    updateAvailable: installed && Boolean(seen) && newer(seen, tool.version),
    manager: tool.manager || "vendor",
    home,
    path: tool.path || null,
    removedByDeleteAllData: installed && HOMES[home].inRoot,
  };
}

function listDir(dir, exists = fs.existsSync) {
  try {
    if (!exists(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((name) => !name.startsWith(".") && !name.endsWith(".adopting"))
      .sort();
  } catch {
    return [];
  }
}

/** Model and speech folders as they are on disk. */
function diskRows(root) {
  if (!root) return [];
  const rows = [];
  for (const name of listDir(path.join(root, "models"))) {
    rows.push({
      id: name,
      category: "Model",
      installed: true,
      status: "Ready",
      version: null,
      latest: null,
      updateAvailable: false,
      manager: "files",
      home: "friday-models",
      path: path.join(root, "models", name),
      removedByDeleteAllData: true,
    });
  }
  for (const name of listDir(path.join(root, "cache", "stt"))) {
    rows.push({
      id: `stt-${name}`,
      category: "Speech",
      installed: true,
      status: "Ready",
      version: null,
      latest: null,
      updateAvailable: false,
      manager: "files",
      home: "friday-speech",
      path: path.join(root, "cache", "stt", name),
      removedByDeleteAllData: true,
    });
  }
  return rows;
}

/**
 * The inventory object for one scan. Pure: tools come from `tools:detect`,
 * `latest` from `tools:latest`, and the folders from the disk.
 */
function buildInventory(root, { tools = [], latest = null, version = "0.0.0", at = null } = {}) {
  const items = [
    ...tools.filter((tool) => !tool.aliasOf).map((tool) => toolRow(tool, root, latest)),
    ...diskRows(root),
  ];
  const byHome = {};
  for (const item of items) {
    if (!item.installed) continue;
    byHome[item.home] = (byHome[item.home] || 0) + 1;
  }
  return {
    schemaVersion: 1,
    root,
    version: String(version),
    scannedAt: at ? new Date(at).toISOString() : null,
    homes: Object.fromEntries(
      Object.entries(HOMES).map(([key, row]) => [key, { label: row.label, inRoot: row.inRoot }]),
    ),
    totals: {
      items: items.length,
      installed: items.filter((item) => item.installed).length,
      missing: items.filter((item) => !item.installed).length,
      updatesAvailable: items.filter((item) => item.updateAvailable).length,
      byHome,
    },
    items,
  };
}

const stable = (inventory) => JSON.stringify({ ...inventory, scannedAt: null });

/** Write <root>/inventory.json, only when the content changed. Never throws. */
function writeInventory(root, scan, options = {}) {
  if (!root || !scan) return { written: false };
  try {
    const inventory = buildInventory(root, {
      tools: scan.tools,
      latest: options.latest,
      version: options.version,
      at: scan.at,
    });
    const file = path.join(root, FILE);
    let previous = null;
    try {
      previous = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      /* first write */
    }
    if (previous && stable(previous) === stable(inventory)) return { written: false, inventory };
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(inventory, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return { written: true, inventory };
  } catch {
    return { written: false };
  }
}

function readInventory(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, FILE), "utf8"));
  } catch {
    return null;
  }
}

module.exports = { FILE, HOMES, homeOf, buildInventory, writeInventory, readInventory, newer };
