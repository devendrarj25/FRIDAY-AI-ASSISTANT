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
 *   * only a folder named `.friday-dev` is ever read from or removed from;
 *   * nothing moves while the build's readiness run is going (FRIDAY_READINESS=1): its FRIDAY folder is a
 *     throwaway one, so the staged downloads stay where the next build finds them.
 *
 * Build roots (`recordBuildRoot`): a build that wrote into some other folder records it too. The pointer is
 * schema 2, `{schema: 2, staging, buildRoots: [{root, kind}]}`, and a schema 1 file (one `staging` path) is
 * read as is and rewritten forward on the next record. For a recorded build root:
 *
 *   * the install root itself (same real path, case-insensitive on Windows) is used in place: nothing moves;
 *   * any other root is COPIED from, never moved: only an item the bundle manifest verifies (size and sha256),
 *     only to a destination that is absent or empty, and only with free space of at least the item plus 2 GiB.
 *     Otherwise the item is skipped with a reason. A source is never deleted and a destination never replaced;
 *   * `FRIDAY_LOCAL_BUNDLES=0` turns build roots off.
 *
 * Every adoption returns `items`: `{id, origin, result: "adopted" | "in-place" | "skipped", reason}`.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STAGING_NAME = ".friday-dev";
const POINTER_FILE = "staged-assets.json";
const POINTER_SCHEMA = 2;
const BUILD_ROOT_KINDS = ["staging", "checkout"];
const BUNDLE_FILE = "friday-bundle.json";
/** A copy from a build root leaves at least this much free on the destination volume. */
const FREE_SPACE_MARGIN = 2 * 1024 ** 3;

/** Parents whose children are downloads. Each child moves as one item. */
const ADOPTED = [
  ["cache", "stt"],
  ["models"],
  ["runtime", "installers"],
  // llama.cpp, unpacked by setup, moves with its zip so the chosen folder has the engine too.
  ["runtime", "engines"],
];

let running = null;

function appDataDir(env = process.env) {
  if (env.APPDATA) return env.APPDATA;
  return process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support")
    : path.join(os.homedir(), ".config");
}

const pointerPath = (env = process.env) => path.join(appDataDir(env), "FRIDAY", POINTER_FILE);

const isStagingDir = (dir) => Boolean(dir) && path.basename(path.resolve(dir)) === STAGING_NAME;

const sameKey = (value) => path.resolve(value).toLowerCase();

/** Reads a schema 1 or schema 2 pointer into one shape. Never throws. */
function readPointerFile(env = process.env) {
  const empty = { staging: null, buildRoots: [] };
  try {
    const data = JSON.parse(fs.readFileSync(pointerPath(env), "utf8"));
    const staging =
      typeof data.staging === "string" && isStagingDir(data.staging)
        ? path.resolve(data.staging)
        : null;
    const buildRoots = [];
    for (const row of Array.isArray(data.buildRoots) ? data.buildRoots : []) {
      const root = typeof row === "string" ? row : row?.root;
      const kind = typeof row === "string" ? "checkout" : row?.kind;
      if (typeof root !== "string" || !root || !BUILD_ROOT_KINDS.includes(kind)) continue;
      if (buildRoots.some((have) => sameKey(have.root) === sameKey(root))) continue;
      buildRoots.push({ root: path.resolve(root), kind });
    }
    return { staging, buildRoots };
  } catch {
    return empty;
  }
}

/** Writes schema 2, or removes the file when nothing is left to point at. Never throws. */
function writePointerFile({ staging, buildRoots }, env = process.env) {
  try {
    const file = pointerPath(env);
    if (!staging && !buildRoots.length) {
      fs.rmSync(file, { force: true });
      return true;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = { schema: POINTER_SCHEMA, ...(staging ? { staging } : {}), buildRoots };
    fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * The build calls this with the folder it wrote into. kind "staging" is the development folder
 * (`.friday-dev`), whose items move; kind "checkout" is any other build root, whose items are copied.
 * Never throws.
 */
function recordBuildRoot(root, { kind, env = process.env } = {}) {
  if (!root || typeof root !== "string" || !BUILD_ROOT_KINDS.includes(kind)) return false;
  const pointer = readPointerFile(env);
  if (kind === "staging") {
    if (!isStagingDir(root)) return false;
    pointer.staging = path.resolve(root);
  } else if (!pointer.buildRoots.some((have) => sameKey(have.root) === sameKey(root))) {
    pointer.buildRoots.push({ root: path.resolve(root), kind });
  }
  return writePointerFile(pointer, env);
}

/** The build calls this when it used the development folder. Never throws. */
function recordStaging(stagingDir, { env = process.env } = {}) {
  return recordBuildRoot(stagingDir, { kind: "staging", env });
}

const readPointer = (env = process.env) => readPointerFile(env).staging;

const readBuildRoots = (env = process.env) => readPointerFile(env).buildRoots;

/** The staging link is spent once everything arrived; recorded build roots stay for later launches. */
function clearPointer(env = process.env) {
  const pointer = readPointerFile(env);
  writePointerFile({ staging: null, buildRoots: pointer.buildRoots }, env);
}

/** A build root may sit behind a link (it is only read, or compared by real path). */
const isDirectory = (dir) => {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

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

/** A destination that filled up between the free check and the move: kept, never replaced. */
class DestinationAppeared extends Error {
  constructor() {
    super("destination appeared meanwhile");
    this.code = "DEST_APPEARED";
  }
}

/**
 * Last look before anything lands. An empty folder is removed with a plain rmdir (it refuses a folder that
 * has content), so a destination that filled up meanwhile is never emptied; anything still there refuses.
 */
async function claimDestination(to) {
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  const stat = await fs.promises.lstat(to).catch(() => null);
  if (stat?.isDirectory() && !stat.isSymbolicLink()) await fs.promises.rmdir(to).catch(() => {});
  if (await exists(to)) throw new DestinationAppeared();
}

async function moveItem(from, to) {
  await claimDestination(to);
  try {
    await fs.promises.rename(from, to);
    return "renamed";
  } catch (error) {
    if (!["EXDEV", "EPERM", "EACCES", "EBUSY"].includes(error?.code)) throw error;
  }
  await copyThenRename(from, to);
  await fs.promises.rm(from, { recursive: true, force: true });
  return "copied";
}

/** Copy under a temporary name, size-check, then rename into place if the destination is still free. */
async function copyThenRename(from, to) {
  const partial = `${to}.adopting`;
  await fs.promises.rm(partial, { recursive: true, force: true });
  try {
    await fs.promises.cp(from, partial, { recursive: true, force: false, errorOnExist: true });
    if ((await treeBytes(from)) !== (await treeBytes(partial))) {
      throw new Error("the copy is not the same size as the original");
    }
    if (await exists(to)) throw new DestinationAppeared();
    await fs.promises.rename(partial, to);
  } catch (error) {
    await fs.promises.rm(partial, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function copyItem(from, to) {
  await claimDestination(to);
  await copyThenRename(from, to);
  return "copied";
}

async function sha256Of(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

const normalDir = (value) =>
  String(value ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();

/**
 * Default item check: the build root's bundle manifest lists the item (`models[].dir`) with the size and
 * sha256 of every file, and the folder holds exactly those bytes. No manifest, no entry, no match: false.
 */
async function verifyAgainstBundle(from, label, buildRoot) {
  try {
    const bundle = JSON.parse(
      await fs.promises.readFile(path.join(buildRoot, BUNDLE_FILE), "utf8"),
    );
    const entry = (Array.isArray(bundle?.models) ? bundle.models : []).find(
      (model) => normalDir(model?.dir) === label.toLowerCase(),
    );
    const files = Array.isArray(entry?.files) ? entry.files : [];
    if (!files.length) return false;
    let total = 0;
    for (const file of files) {
      const rel = String(file?.path ?? "");
      if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) return false;
      const full = path.join(from, ...rel.split(/[\\/]/));
      const stat = await fs.promises.lstat(full);
      if (!stat.isFile() || stat.size !== file.bytes) return false;
      if ((await sha256Of(full)) !== String(file.sha256 ?? "").toLowerCase()) return false;
      total += stat.size;
    }
    return total === (await treeBytes(from));
  } catch {
    return false;
  }
}

/** Free bytes on the volume that holds `target`, read from its nearest existing parent. */
async function freeBytesAt(target, statfs) {
  let dir = path.dirname(target);
  while (!(await exists(dir)) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const info = await statfs(dir);
  const free = Number(info?.bavail) * Number(info?.bsize);
  return Number.isFinite(free) ? free : null;
}

const GIB_LABEL = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

/** The items under `base` that adoption knows: [segments, name, full path] for each. */
async function listItems(base) {
  const found = [];
  for (const segments of ADOPTED) {
    let names = [];
    try {
      names = await fs.promises.readdir(path.join(base, ...segments));
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith(".adopting")) continue;
      found.push({ segments, name, from: path.join(base, ...segments, name) });
    }
  }
  return found;
}

/**
 * mode "move": the `.friday-dev` staging rules. mode "copy": a build root, copy only what verifies.
 * mode "in-place": the build root is the install root; report what is there and touch nothing.
 */
async function adoptFrom(base, root, report, mode, ctx) {
  const origin = path.resolve(base);
  const note = (id, result, reason) => report.items.push({ id, origin, result, reason });
  for (const { segments, name, from } of await listItems(base)) {
    const to = path.join(root, ...segments, name);
    const label = [...segments, name].join("/");
    if (mode === "in-place") {
      note(label, "in-place", "build root is the install root");
      continue;
    }
    if (!(await isFree(to))) {
      report.kept.push(label);
      note(label, "skipped", "destination already holds it");
      continue;
    }
    try {
      if (mode === "copy") {
        if (!(await ctx.verify(from, label, base))) {
          note(label, "skipped", "not verified");
          continue;
        }
        const need = (await treeBytes(from)) + FREE_SPACE_MARGIN;
        const free = await freeBytesAt(to, ctx.statfs).catch(() => null);
        if (free === null || free < need) {
          note(
            label,
            "skipped",
            free === null
              ? "free space unknown"
              : `not enough free space (${GIB_LABEL(free)} free, needs ${GIB_LABEL(need)})`,
          );
          continue;
        }
        await copyItem(from, to);
        report.copied.push({ item: label, origin });
        note(label, "adopted", "copied");
      } else {
        const how = await moveItem(from, to);
        report.moved.push({ item: label, how });
        note(label, "adopted", how);
      }
    } catch (error) {
      if (error?.code === "DEST_APPEARED") {
        report.kept.push(label);
        note(label, "skipped", "destination appeared meanwhile");
        continue;
      }
      const message = String(error?.message || error);
      report.failed.push({ item: label, error: message });
      note(label, "skipped", `failed: ${message}`);
    }
  }
}

/** Same real folder? Case-insensitive on Windows. The reader is injected so a test needs no real disk. */
async function sameFolder(a, b, { realpath, platform }) {
  const real = async (value) => {
    try {
      return String(await realpath(path.resolve(value)));
    } catch {
      return path.resolve(value);
    }
  };
  const [left, right] = [await real(a), await real(b)];
  return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Bring what the build staged into `root`. Resolves with what moved, what was copied, what was left because
 * the FRIDAY folder already had it, what failed, and `items`, one row per item. Never throws.
 * Options inject the machine: `realpath`, `statfs`, `platform`, `verify`.
 */
function adopt(root, options = {}) {
  const { env = process.env } = options;
  if (running) return running;
  const ctx = {
    verify: options.verify ?? verifyAgainstBundle,
    statfs: options.statfs ?? ((dir) => fs.promises.statfs(dir)),
    realpath: options.realpath ?? ((dir) => fs.realpathSync.native(dir)),
    platform: options.platform ?? process.platform,
  };
  running = (async () => {
    const report = { moved: [], copied: [], kept: [], failed: [], sources: [], items: [] };
    if (!root || String(env.FRIDAY_ADOPT_STAGED ?? "1").trim() === "0") return report;
    // The build's readiness run uses a throwaway FRIDAY folder that is deleted afterwards. Moving the
    // owner's staged models into it would copy gigabytes for nothing and then destroy them.
    if (String(env.FRIDAY_READINESS ?? "").trim() === "1") return report;
    try {
      const target = path.resolve(root);
      for (const staging of candidates(root, env)) {
        report.sources.push(staging);
        await adoptFrom(staging, target, report, "move", ctx);
      }
      if (String(env.FRIDAY_LOCAL_BUNDLES ?? "1").trim() !== "0") {
        for (const build of readBuildRoots(env)) {
          if (!isDirectory(build.root)) continue;
          const inPlace = await sameFolder(build.root, target, ctx);
          report.sources.push(build.root);
          await adoptFrom(build.root, target, report, inPlace ? "in-place" : "copy", ctx);
        }
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
  recordBuildRoot,
  readPointer,
  readBuildRoots,
  candidates,
  adopt,
  whenIdle,
};
