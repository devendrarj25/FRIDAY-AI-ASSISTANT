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

/**
 * Home of an installed or planned tool. `where` is the executable or package path, when known.
 * The route facts come first (pip, npm, a path under runtime); then the home the row declares (`tool.home`:
 * friday-root, machine or npm-global, from the data files or the tool table); only a row that declares nothing is
 * guessed from its manager. A real path outside the FRIDAY folder beats a declared friday-root: the index says
 * where the program really is.
 */
function homeOf(tool, root) {
  if (tool.manager === "pip") return "friday-python-env";
  if (tool.manager === "npm") return "npm-global";
  const underRuntime = Boolean(root && tool.path && inside(tool.path, path.join(root, "runtime")));
  if (underRuntime) return "friday-runtime";
  if (tool.home === "machine") return "machine";
  if (tool.home === "npm-global") return "npm-global";
  if (tool.home === "friday-root") return tool.path ? "machine" : "friday-runtime";
  if (tool.manager === "vendor" && !tool.path) return "friday-runtime";
  return "machine";
}

// A packaging revision after a full version (Ruby 3.4.13-1) is the same release as 3.4.13, not a newer one.
const numbers = (value) =>
  String(value || "")
    .replace(/^v/i, "")
    .replace(/^(\d+(?:\.\d+)+)-\d+$/, "$1")
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

/**
 * Write <root>/inventory.json, only when the content changed. Never throws. The post-update model check
 * (`modelCheck`) lives in the same file: a rewrite from a new scan keeps the last record.
 */
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
    const kept = options.modelCheck || previous?.modelCheck;
    if (kept) inventory.modelCheck = kept;
    if (previous && stable(previous) === stable(inventory)) return { written: false, inventory };
    return atomicWrite(file, inventory) ? { written: true, inventory } : { written: false };
  } catch {
    return { written: false };
  }
}

function atomicWrite(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return true;
}

function readInventory(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, FILE), "utf8"));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ the check after an update
 * An update replaces <root>/App only; the downloaded weights live in the root and are not touched. This check reads
 * them once per app version and reports a file that no longer matches its pin. It only reads and reports: a bad file
 * is flagged for the Doctor repair (which fetches just that file again), never removed here.
 *   voice and speech weights   `voice-weights.pinChecks` (the same rows the voice Doctor shows)
 *   FRIDAY Core chat weights   `friday-core.planAssets` (pinned size and SHA-256 per file)
 * Size is always checked; the SHA-256 only with `hash` (a multi-GB file takes seconds, so the Doctor repair asks).
 */

async function coreProblems(root, deps, hash) {
  const core = deps.core || require("./friday-core.cjs");
  const stat = deps.stat || ((file) => fs.statSync(file, { throwIfNoEntry: false }));
  const coreDeps = {
    pack: null,
    ...(deps.manifest !== undefined ? { manifest: deps.manifest } : {}),
  };
  const verify = deps.verifySha || core.verifySha;
  const manifest = core.read(coreDeps);
  const out = { checked: 0, bad: [] };
  for (const variant of manifest?.variants || []) {
    const plan = core.planAssets(root, variant.id, { ...coreDeps, stat });
    if (!plan.ok) continue;
    const seen = plan.assets.map((asset) => ({ asset, info: stat(asset.dest) }));
    // A variant that was never downloaded is not a problem; one with some of its files is checked as a whole.
    if (!seen.some((row) => row.info && row.info.isFile())) continue;
    for (const { asset, info } of seen) {
      out.checked += 1;
      const flag = (detail) =>
        out.bad.push({
          source: "core",
          id: asset.disk,
          label: `FRIDAY Core ${variant.id}`,
          detail,
        });
      if (!info || !info.isFile()) flag(`${asset.disk} missing`);
      else if (info.size !== asset.bytes) flag(`${asset.disk} wrong size`);
      else if (hash) {
        const verdict = await verify(asset.dest, asset.sha256, { bytes: asset.bytes });
        if (!verdict.ok) flag(`${asset.disk} fails SHA-256`);
      }
    }
  }
  return out;
}

/**
 * Check every downloaded, pinned model against its pin. Never throws and never changes a file:
 * `{ ok, checked, hashed, bad: [{ source, id, label, detail }], errors }`. A source that could not be read is in
 * `errors` (unverified), not in `bad`.
 */
async function checkDownloadedModels(root, deps = {}) {
  const hash = deps.hash === true;
  const result = { ok: true, checked: 0, hashed: hash, bad: [], errors: [] };
  if (!root) return { ...result, errors: ["no FRIDAY folder is set"], ok: false };
  const exists = deps.exists || ((file) => fs.existsSync(file));
  try {
    const weights = deps.weights || require("./voice-weights.cjs");
    const rows = await weights.pinChecks(root, {
      exists,
      hash,
      ...(deps.stat ? { stat: deps.stat } : {}),
      ...(deps.hashFile ? { hashFile: deps.hashFile } : {}),
    });
    result.checked += rows.length;
    for (const row of rows) {
      if (!row.ok) {
        result.bad.push({ source: "voice", id: row.id, label: row.label, detail: row.detail });
      }
    }
  } catch (error) {
    result.errors.push(`voice weights: ${error?.message || error}`);
  }
  try {
    const found = await coreProblems(root, deps, hash);
    result.checked += found.checked;
    result.bad.push(...found.bad);
  } catch (error) {
    result.errors.push(`FRIDAY Core: ${error?.message || error}`);
  }
  result.ok = !result.bad.length && !result.errors.length;
  return result;
}

/** The one Doctor row for a check result. `badIds` are the files or rows the repair should fetch again. */
function modelCheckRow(result) {
  const bad = result.bad || [];
  const errors = result.errors || [];
  const how = result.hashed ? "size and SHA-256" : "size";
  const row = {
    id: "models-after-update",
    label: "Downloaded models match their pins after the update",
    ok: result.ok === true,
    optional: true,
    required: false,
    badIds: bad.map((item) => item.id),
    detail: `${result.checked} downloaded file(s) checked by ${how}`,
  };
  if (bad.length) {
    const shown = bad
      .slice(0, 5)
      .map((item) => `${item.id} (${item.detail})`)
      .join(", ");
    row.detail = `${bad.length} flagged, not deleted: ${shown}${bad.length > 5 ? ", ..." : ""}; repair fetches only those files again`;
  } else if (errors.length) {
    row.detail = `could not be checked, so unverified: ${errors.join("; ")}`;
  }
  return row;
}

const previousCheck = (root) => readInventory(root)?.modelCheck || null;

/** True when the models have not been checked for this app version yet. */
function needsModelCheck(root, version) {
  return previousCheck(root)?.version !== String(version);
}

/** Note the outcome in inventory.json (only when that file exists). Returns whether it was written. */
function recordModelCheck(root, result, version, now) {
  try {
    const file = path.join(root, FILE);
    const current = JSON.parse(fs.readFileSync(file, "utf8"));
    current.modelCheck = {
      version: String(version),
      at: Number.isFinite(now) ? new Date(now).toISOString() : null,
      ok: result.ok === true,
      hashed: result.hashed === true,
      checked: result.checked,
      bad: result.bad.map((item) => item.id),
    };
    return atomicWrite(file, current);
  } catch {
    return false;
  }
}

async function runCheck(root, deps) {
  const result = await checkDownloadedModels(root, deps);
  const persisted = result.errors.length
    ? false
    : recordModelCheck(root, result, deps.version, deps.now);
  return { ran: true, result, row: modelCheckRow(result), persisted };
}

/** The cheap check after an update: size only, once per app version. `{ ran: false }` when already done. */
async function postUpdateCheck(root, deps = {}) {
  const version = String(deps.version || "");
  if (!root || !version) return { ran: false, reason: "no FRIDAY folder or version" };
  if (!needsModelCheck(root, version))
    return { ran: false, reason: "already checked for this version" };
  return runCheck(root, { ...deps, version, hash: false });
}

/** The full check from the Doctor repair: size and SHA-256 of every pinned file, whenever it is asked for. */
async function verifyModelHashes(root, deps = {}) {
  if (!root) return { ran: false, reason: "no FRIDAY folder" };
  return runCheck(root, { ...deps, version: String(deps.version || ""), hash: true });
}

module.exports = {
  FILE,
  HOMES,
  homeOf,
  buildInventory,
  writeInventory,
  readInventory,
  newer,
  checkDownloadedModels,
  modelCheckRow,
  needsModelCheck,
  postUpdateCheck,
  verifyModelHashes,
};
