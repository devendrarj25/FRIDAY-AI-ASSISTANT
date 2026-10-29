/**
 * FRIDAY · staged build downloads
 *
 * `npm run setup` and `build:win` download the speech, voice and chat models
 * before any FRIDAY folder has been chosen. With no folder selected they write
 * to `.friday-dev` inside the checkout (scripts/friday-root.cjs). The installed
 * app then looks for the same files in the folder the owner picks, finds none,
 * and downloads them again.
 *
 * This is the one place that closes that gap. The build records where it
 * staged the files (`recordStaging`); the app, once it has a root, moves each
 * staged item into that root (`adopt`). Rules:
 *
 *   * an item moves whole and only to a place that is still free, so nothing
 *     in the FRIDAY folder is ever overwritten or merged into;
 *   * a move inside one volume is a rename; across volumes it is copied under
 *     a temporary name, size-checked, renamed into place, and only then is the
 *     staged original removed, so a half copy is never mistaken for a model;
 *   * only the download folders move (speech weights, models, installers).
 *     The staged database, memory and settings are left alone;
 *   * only a folder named `.friday-dev` is ever read from or removed from.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STAGING_NAME = ".friday-dev";
const POINTER_FILE = "staged-assets.json";

/** Parents whose children are downloads. Each child moves as one item. */
const ADOPTED = [["cache", "stt"], ["models"], ["runtime", "installers"]];

let running = null;

function appDataDir(env = process.env) {
  if (env.APPDATA) return env.APPDATA;
  return process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support")
    : path.join(os.homedir(), ".config");
}

const pointerPath = (env = process.env) => path.join(appDataDir(env), "FRIDAY", POINTER_FILE);

const isStagingDir = (dir) => Boolean(dir) && path.basename(path.resolve(dir)) === STAGING_NAME;

/** The build calls this when it used the development folder. Never throws. */
function recordStaging(stagingDir, { env = process.env } = {}) {
  if (!isStagingDir(stagingDir)) return false;
  try {
    const file = pointerPath(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${JSON.stringify({ staging: path.resolve(stagingDir), recordedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    return true;
  } catch {
    return false;
  }
}

function readPointer(env = process.env) {
  try {
    const value = JSON.parse(fs.readFileSync(pointerPath(env), "utf8")).staging;
    return typeof value === "string" && isStagingDir(value) ? path.resolve(value) : null;
  } catch {
    return null;
  }
}

function clearPointer(env = process.env) {
  try {
    fs.rmSync(pointerPath(env), { force: true });
  } catch {
    /* a leftover pointer only costs one more look */
  }
}

const isRealDir = (dir) => {
  try {
    const stat = fs.lstatSync(dir);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
};

/** Staging folders worth reading: the one inside the root, and the one the build recorded. */
function candidates(root, env = process.env) {
  const seen = new Set();
  const found = [];
  for (const dir of [path.join(root, STAGING_NAME), readPointer(env)]) {
    if (!dir) continue;
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key) || key === path.resolve(root).toLowerCase()) continue;
    seen.add(key);
    if (isRealDir(dir)) found.push(path.resolve(dir));
  }
  return found;
}

async function treeBytes(target) {
  const stat = await fs.promises.lstat(target);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of await fs.promises.readdir(target)) {
    total += await treeBytes(path.join(target, entry));
  }
  return total;
}

const exists = async (target) =>
  fs.promises.lstat(target).then(
    () => true,
    () => false,
  );

/** A destination that is absent, or an empty folder, is free to take an item. */
async function isFree(target) {
  if (!(await exists(target))) return true;
  try {
    const stat = await fs.promises.lstat(target);
    return stat.isDirectory() && (await fs.promises.readdir(target)).length === 0;
  } catch {
    return false;
  }
}

async function moveItem(from, to) {
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  if (await exists(to)) await fs.promises.rm(to, { recursive: true, force: true });
  try {
    await fs.promises.rename(from, to);
    return "renamed";
  } catch (error) {
    if (!["EXDEV", "EPERM", "EACCES", "EBUSY"].includes(error?.code)) throw error;
  }
  const partial = `${to}.adopting`;
  await fs.promises.rm(partial, { recursive: true, force: true });
  try {
    await fs.promises.cp(from, partial, { recursive: true, force: false, errorOnExist: true });
    if ((await treeBytes(from)) !== (await treeBytes(partial))) {
      throw new Error("the copy is not the same size as the original");
    }
    await fs.promises.rename(partial, to);
  } catch (error) {
    await fs.promises.rm(partial, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  await fs.promises.rm(from, { recursive: true, force: true });
  return "copied";
}

async function adoptFrom(staging, root, report) {
  for (const segments of ADOPTED) {
    const parent = path.join(staging, ...segments);
    let names = [];
    try {
      names = await fs.promises.readdir(parent);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith(".adopting")) continue;
      const from = path.join(parent, name);
      const to = path.join(root, ...segments, name);
      const label = [...segments, name].join("/");
      if (!(await isFree(to))) {
        report.kept.push(label);
        continue;
      }
      try {
        const how = await moveItem(from, to);
        report.moved.push({ item: label, how });
      } catch (error) {
        report.failed.push({ item: label, error: String(error?.message || error) });
      }
    }
  }
}

/**
 * Move what the build staged into `root`. Resolves with what moved, what was
 * left because the FRIDAY folder already had it, and what failed. Never throws.
 */
function adopt(root, { env = process.env } = {}) {
  if (running) return running;
  running = (async () => {
    const report = { moved: [], kept: [], failed: [], sources: [] };
    if (!root || String(env.FRIDAY_ADOPT_STAGED ?? "1").trim() === "0") return report;
    try {
      for (const staging of candidates(root, env)) {
        report.sources.push(staging);
        await adoptFrom(staging, path.resolve(root), report);
      }
      if (!report.failed.length) clearPointer(env);
    } catch (error) {
      report.failed.push({ item: "(staging)", error: String(error?.message || error) });
    }
    return report;
  })().finally(() => {
    running = null;
  });
  return running;
}

/** Resolves when no adoption is running, so a download waits instead of repeating one. */
const whenIdle = () => (running ? running.then(() => undefined) : Promise.resolve());

module.exports = {
  STAGING_NAME,
  ADOPTED,
  pointerPath,
  recordStaging,
  readPointer,
  candidates,
  adopt,
  whenIdle,
};
