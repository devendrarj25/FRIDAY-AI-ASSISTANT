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
 *
 * Hardening of a copy from a build root (the files come from a folder another process may still be writing):
 *
 *   * the bundle is read by electron/build-bundle.cjs (strict), found at `<root>/friday-bundle.json`, then
 *     `<root>/release/`, then the newest `<root>/installer/installers/<version>/`. The model must also match the
 *     pin in `config/friday-models.json` (a bundle for an old revision is skipped), the folder must hold exactly
 *     the listed files (a duplicate row, a link or any entry that is neither a plain file nor a folder refuses);
 *   * free space is checked first, so a model that cannot fit is never hashed on every launch;
 *   * the finished `.adopting` copy is hashed against the manifest BEFORE it is renamed into place, so a source
 *     that changed during the copy ends skipped. A file item is published with a hard link (it never replaces a
 *     file that appeared meanwhile). Partial names carry a random suffix; a partial is swept at the start only when
 *     it is ours (`<item>.<8 hex>.adopting`, `<item>` held by a source) and ten minutes old. An item that is a
 *     symlink or junction is skipped with the reason `link`, and a copy that turned into a link is never published;
 *   * the pointer accepts local drive paths only (no UNC or device path, so no network share is ever touched),
 *     is written atomically, and keeps fields and rows it does not know;
 *   * one job runs per resolved root and jobs are serialised; `whenIdle` waits for all of them.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const buildBundle = require("./build-bundle.cjs");
const { writeFileSafe } = require("./safe-write.cjs");

const STAGING_NAME = ".friday-dev";
const POINTER_FILE = "staged-assets.json";
const POINTER_SCHEMA = 2;
const BUILD_ROOT_KINDS = ["staging", "checkout"];
/** A copy from a build root leaves at least this much free on the destination volume. */
const FREE_SPACE_MARGIN = 2 * 1024 ** 3;
const PARTIAL_SUFFIX = ".adopting";
/** Our own partial names: `<name>.adopting` (older) and `<name>.<8 hex>.adopting`. */
const OWN_PARTIAL = /(?:\.[0-9a-f]{8})?\.adopting$/;
/** A partial younger than this may still be written by a running copy, so a sweep leaves it. */
const PARTIAL_GRACE_MS = 10 * 60 * 1000;

/** Parents whose children are downloads. Each child moves as one item. */
const ADOPTED = [
  ["cache", "stt"],
  ["models"],
  ["runtime", "installers"],
  // llama.cpp, unpacked by setup, moves with its zip so the chosen folder has the engine too.
  ["runtime", "engines"],
];

/** One running job per resolved root; jobs run one after the other (`tail`), so two roots never overlap. */
const jobs = new Map();
let tail = Promise.resolve();

function appDataDir(env = process.env) {
  if (env.APPDATA) return env.APPDATA;
  return process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support")
    : path.join(os.homedir(), ".config");
}

const pointerPath = (env = process.env) => path.join(appDataDir(env), "FRIDAY", POINTER_FILE);

const isStagingDir = (dir) => Boolean(dir) && path.basename(path.resolve(dir)) === STAGING_NAME;

/** Windows and macOS disks fold case; a Linux disk does not, so `/A` and `/a` stay two folders there. */
const foldCase = (value) =>
  process.platform === "win32" || process.platform === "darwin" ? value.toLowerCase() : value;

const sameKey = (value) => foldCase(path.resolve(value));

/**
 * A folder the pointer may name: an absolute path on a local drive. A UNC share, a device path (`\\?\`, `\\.\`)
 * or a relative path is never accepted, so reading the pointer never opens a network connection.
 */
function isLocalPath(value) {
  if (typeof value !== "string" || !value || value.includes("\0")) return false;
  if (/^[\\/]{2}/.test(value)) return false;
  return process.platform === "win32" ? /^[A-Za-z]:[\\/]/.test(value) : value.startsWith("/");
}

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Reads a schema 1 or schema 2 pointer into one shape. Never throws. Besides the usable `staging` and
 * `buildRoots`, it keeps what it does not understand (`extra` fields, `rows` of a newer schema) so a rewrite
 * does not lose them.
 */
function readPointerFile(env = process.env) {
  const empty = { schema: POINTER_SCHEMA, staging: null, buildRoots: [], rows: [], extra: {} };
  try {
    const data = JSON.parse(fs.readFileSync(pointerPath(env), "utf8"));
    if (!isPlainObject(data)) return empty;
    const staging =
      typeof data.staging === "string" && isLocalPath(data.staging) && isStagingDir(data.staging)
        ? path.resolve(data.staging)
        : null;
    const rows = [];
    const buildRoots = [];
    for (const raw of Array.isArray(data.buildRoots) ? data.buildRoots : []) {
      const root = typeof raw === "string" ? raw : raw?.root;
      const kind = typeof raw === "string" ? "checkout" : raw?.kind;
      if (!isLocalPath(root) || !BUILD_ROOT_KINDS.includes(kind)) {
        // Not usable here (a newer kind, a network path): kept in the file, never read.
        rows.push(raw);
        continue;
      }
      if (buildRoots.some((have) => sameKey(have.root) === sameKey(root))) continue;
      const valid = { root: path.resolve(root), kind };
      buildRoots.push(valid);
      rows.push({ ...(isPlainObject(raw) ? raw : {}), ...valid });
    }
    const extra = Object.fromEntries(
      Object.entries(data).filter(([key]) => !["schema", "staging", "buildRoots"].includes(key)),
    );
    const schema =
      Number.isInteger(data.schema) && data.schema > POINTER_SCHEMA ? data.schema : POINTER_SCHEMA;
    return { schema, staging, buildRoots, rows, extra };
  } catch {
    return empty;
  }
}

/** Writes the pointer atomically, or removes the file when nothing is left to keep. Never throws. */
function writePointerFile(pointer, env = process.env) {
  try {
    const file = pointerPath(env);
    const nothing = !pointer.staging && !pointer.rows.length && !Object.keys(pointer.extra).length;
    if (nothing) {
      fs.rmSync(file, { force: true });
      return true;
    }
    const body = {
      ...pointer.extra,
      schema: pointer.schema,
      ...(pointer.staging ? { staging: pointer.staging } : {}),
      buildRoots: pointer.rows,
    };
    writeFileSafe(file, `${JSON.stringify(body, null, 2)}\n`, { keepBackup: false });
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
  if (!isLocalPath(root) || !BUILD_ROOT_KINDS.includes(kind)) return false;
  const pointer = readPointerFile(env);
  if (kind === "staging") {
    if (!isStagingDir(root)) return false;
    pointer.staging = path.resolve(root);
  } else if (!pointer.buildRoots.some((have) => sameKey(have.root) === sameKey(root))) {
    pointer.rows.push({ root: path.resolve(root), kind });
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
  writePointerFile({ ...readPointerFile(env), staging: null }, env);
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
    const key = sameKey(dir);
    if (seen.has(key) || key === sameKey(root)) continue;
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

/** The copy is not what the manifest lists: the source changed while it was being copied. */
class CopyChanged extends Error {
  constructor() {
    super("source changed while copying");
    this.code = "COPY_CHANGED";
  }
}

/** An item (or its copy) is a symlink or junction: it is never copied, moved or published. */
class LinkRefused extends Error {
  constructor() {
    super("link");
    this.code = "LINK";
  }
}

async function refuseLink(target) {
  const stat = await fs.promises.lstat(target);
  if (stat.isSymbolicLink()) throw new LinkRefused();
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

async function sha256Of(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Every entry under `dir` as a posix path, or null when one is neither a plain file nor a folder (a symlink, a
 * junction, a device). A link is never followed.
 */
async function walkPlain(dir, prefix = "") {
  const out = [];
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const inner = await walkPlain(path.join(dir, entry.name), rel);
      if (!inner) return null;
      out.push(...inner);
    } else if (entry.isFile()) {
      out.push(rel);
    } else {
      return null;
    }
  }
  return out;
}

/** Does `dir` hold exactly the manifest's files, with their sizes and (when `hash`) their sha256? */
async function treeMatches(dir, files, hash) {
  const listed = await walkPlain(dir);
  if (!listed || listed.length !== files.length) return false;
  const want = new Set(files.map((file) => file.path));
  if (want.size !== files.length || listed.some((rel) => !want.has(rel))) return false;
  for (const file of files) {
    const full = path.join(dir, ...file.path.split("/"));
    const stat = await fs.promises.lstat(full).catch(() => null);
    if (!stat?.isFile() || stat.size !== file.bytes) return false;
    if (hash && (await sha256Of(full)) !== String(file.sha256).toLowerCase()) return false;
  }
  return true;
}

/**
 * Copy under a random temporary name, check it, then publish it only if the destination is still free.
 * `expected` (the manifest's files) makes the check a hash of the finished copy, not of the source, so bytes
 * that changed while copying never land. A folder is renamed into place (the rename refuses a folder that has
 * content); a file is published with a hard link, which never replaces a file that appeared meanwhile.
 */
async function copyThenRename(from, to, expected = null) {
  const partial = `${to}.${crypto.randomBytes(4).toString("hex")}${PARTIAL_SUFFIX}`;
  try {
    await fs.promises.cp(from, partial, { recursive: true, force: false, errorOnExist: true });
    // walkPlain follows a link at the top, so look at the copy itself before it is read or published.
    await refuseLink(partial);
    if (expected) {
      if (!(await treeMatches(partial, expected, true))) throw new CopyChanged();
    } else if ((await treeBytes(from)) !== (await treeBytes(partial))) {
      throw new Error("the copy is not the same size as the original");
    }
    if (await exists(to)) throw new DestinationAppeared();
    await publish(partial, to);
  } catch (error) {
    await fs.promises.rm(partial, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function publish(partial, to) {
  const stat = await fs.promises.lstat(partial);
  if (stat.isSymbolicLink()) throw new LinkRefused();
  if (stat.isDirectory()) {
    await fs.promises.rename(partial, to);
    return;
  }
  try {
    await fs.promises.link(partial, to);
  } catch (error) {
    if (error?.code === "EEXIST") throw new DestinationAppeared();
    // A disk without hard links: the check above is the last look before the rename.
    if (!["EPERM", "ENOSYS", "EXDEV", "EACCES", "ENOTSUP", "EOPNOTSUPP"].includes(error?.code)) {
      throw error;
    }
    if (await exists(to)) throw new DestinationAppeared();
    await fs.promises.rename(partial, to);
    return;
  }
  await fs.promises.unlink(partial);
}

async function copyItem(from, to, expected) {
  await claimDestination(to);
  await copyThenRename(from, to, expected);
  return "copied";
}

const normalDir = (value) =>
  String(value ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();

const versionParts = (name) => name.split(".").map((part) => Number.parseInt(part, 10) || 0);

function newerVersion(a, b) {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let index = 0; index < Math.max(x.length, y.length); index += 1) {
    const delta = (y[index] ?? 0) - (x[index] ?? 0);
    if (delta) return delta;
  }
  return a < b ? 1 : a > b ? -1 : 0;
}

/**
 * Where a build root keeps its bundle: next to the root, in `release/`, or the newest
 * `installer/installers/<version>/`. The first one that exists is the one (an older copy never replaces a
 * damaged newer one).
 */
async function findBundleFile(buildRoot) {
  const direct = [
    path.join(buildRoot, buildBundle.FILE_NAME),
    path.join(buildRoot, "release", buildBundle.FILE_NAME),
  ];
  for (const file of direct) if (await exists(file)) return file;
  const base = path.join(buildRoot, "installer", "installers");
  const versions = await fs.promises.readdir(base).catch(() => []);
  for (const version of [...versions].sort(newerVersion)) {
    const file = path.join(base, version, buildBundle.FILE_NAME);
    if (await exists(file)) return file;
  }
  return null;
}

/** The pin rows of config/friday-models.json (`assets`), read once. Empty when the file cannot be read. */
function configPins() {
  try {
    const loaded = require("./resource-paths.cjs").readConfigJson("friday-models.json", null);
    return Array.isArray(loaded?.value?.assets) ? loaded.value.assets : [];
  } catch {
    return [];
  }
}

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Default item check. Returns the manifest's file list when the item is good, else false. Good means:
 *   * electron/build-bundle.cjs reads a valid bundle for this build root;
 *   * the bundle lists the item (`models[].dir`) and the config pin for that model agrees with it, file for file
 *     (the pin always wins: a bundle for an older revision is not adoptable);
 *   * the folder holds exactly the listed files, plain files and folders only, each with the listed size and sha256.
 * Hashing goes one file at a time with a pause between files, so the window keeps answering.
 */
async function verifyAgainstBundle(from, label, buildRoot, pins) {
  try {
    const file = await findBundleFile(buildRoot);
    const bundle = file ? buildBundle.read(file) : null;
    const entry = bundle?.models.find((model) => normalDir(model.dir) === label.toLowerCase());
    if (!entry) return false;
    if (!buildBundle.pinWins(entry, buildBundle.pinFromAssets(pins, entry.fridayId))) return false;
    const listed = await walkPlain(from);
    if (!listed || listed.length !== entry.files.length) return false;
    const want = new Set(entry.files.map((row) => row.path));
    if (listed.some((rel) => !want.has(rel))) return false;
    for (const row of entry.files) {
      const one = { ...bundle, models: [{ ...entry, bytes: row.bytes, files: [row] }] };
      const result = buildBundle.bundleFilesMatch(buildRoot, one, {
        scope: "models",
        modelsRoot: buildRoot,
      });
      if (!result.ok) return false;
      await yieldToLoop();
    }
    return entry.files;
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

/**
 * The items under `base` that adoption knows: `{segments, name, from, link}` for each. `link` is true when the
 * item itself is a symlink or junction (found with lstat, never followed).
 */
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
      if (name.endsWith(PARTIAL_SUFFIX)) continue;
      const from = path.join(base, ...segments, name);
      const link = await fs.promises.lstat(from).then(
        (stat) => stat.isSymbolicLink(),
        () => false,
      );
      found.push({ segments, name, from, link });
    }
  }
  return found;
}

/** Keys (`models/name`) of the items every source holds, for the sweep: a partial belongs to one of them. */
async function sourceItemKeys(root, env) {
  const bases = [...candidates(root, env)];
  if (String(env.FRIDAY_LOCAL_BUNDLES ?? "1").trim() !== "0") {
    for (const build of readBuildRoots(env)) if (isDirectory(build.root)) bases.push(build.root);
  }
  const keys = new Set();
  for (const base of bases) {
    for (const item of await listItems(base)) {
      keys.add(foldCase([...item.segments, item.name].join("/")));
    }
  }
  return keys;
}

/**
 * Our own half-finished copies, left by a crash. A partial is swept only when its name is one of ours
 * (`<item>.adopting` or `<item>.<8 hex>.adopting`), `<item>` is an item a source still holds (so a folder the owner
 * happens to call `userdata.adopting` is never listed), and it has not been written for ten minutes (so the live
 * copy of another running instance is left). The owner's other folders and files are never touched.
 */
async function sweepPartials(root, report, { keys, now }) {
  for (const segments of ADOPTED) {
    const parent = path.join(root, ...segments);
    let names = [];
    try {
      names = await fs.promises.readdir(parent);
    } catch {
      continue;
    }
    for (const name of names) {
      const own = OWN_PARTIAL.exec(name);
      if (!own) continue;
      if (!keys.has(foldCase([...segments, name.slice(0, own.index)].join("/")))) continue;
      const full = path.join(parent, name);
      try {
        const stat = await fs.promises.lstat(full);
        if (now() - stat.mtimeMs < PARTIAL_GRACE_MS) continue;
        await fs.promises.rm(full, { recursive: true, force: true });
        report.swept.push([...segments, name].join("/"));
      } catch {
        /* locked: the next launch tries again */
      }
    }
  }
}

/**
 * Is `to` the start of this item, written by something else (a file manager, an interrupted copy)? True when it
 * is a folder whose files all exist in the source but not all of them, or not at full size.
 */
async function looksUnfinished(from, to) {
  try {
    const [source, target] = [await walkPlain(from), await walkPlain(to)];
    if (!source || !target || !target.length) return false;
    const sizes = new Map();
    for (const rel of source) {
      sizes.set(rel, (await fs.promises.lstat(path.join(from, ...rel.split("/")))).size);
    }
    let short = target.length < source.length;
    for (const rel of target) {
      const have = sizes.get(rel);
      if (have === undefined) return false;
      const size = (await fs.promises.lstat(path.join(to, ...rel.split("/")))).size;
      if (size > have) return false;
      if (size < have) short = true;
    }
    return short;
  } catch {
    return false;
  }
}

/**
 * mode "move": the `.friday-dev` staging rules. mode "copy": a build root, copy only what verifies.
 * mode "in-place": the build root is the install root; report what is there and touch nothing.
 */
async function adoptFrom(base, root, report, mode, ctx) {
  const origin = path.resolve(base);
  const note = (id, result, reason) => report.items.push({ id, origin, result, reason });
  for (const { segments, name, from, link } of await listItems(base)) {
    const to = path.join(root, ...segments, name);
    const label = [...segments, name].join("/");
    if (mode === "in-place") {
      note(label, "in-place", "build root is the install root");
      continue;
    }
    if (link) {
      // A link could point anywhere (another disk, the owner's folders): it is never copied or moved.
      note(label, "skipped", "link");
      continue;
    }
    if (!(await isFree(to))) {
      report.kept.push(label);
      note(
        label,
        "skipped",
        (await looksUnfinished(from, to))
          ? "destination looks like an unfinished copy; left as it is"
          : "destination already holds it",
      );
      continue;
    }
    try {
      if (mode === "copy") {
        // Space first: a model that cannot fit is never hashed, launch after launch.
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
        const verified = await ctx.verify(from, label, base);
        if (!verified) {
          note(label, "skipped", "not verified");
          continue;
        }
        await copyItem(from, to, Array.isArray(verified) ? verified : null);
        report.copied.push({ item: label, origin });
        note(label, "adopted", "copied");
      } else {
        const how = await moveItem(from, to);
        report.moved.push({ item: label, how });
        note(label, "adopted", how);
      }
    } catch (error) {
      if (["DEST_APPEARED", "COPY_CHANGED", "LINK"].includes(error?.code)) {
        if (error.code === "DEST_APPEARED") report.kept.push(label);
        note(label, "skipped", error.message);
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

async function runAdoption(root, options, env) {
  const ctx = {
    statfs: options.statfs ?? ((dir) => fs.promises.statfs(dir)),
    realpath: options.realpath ?? ((dir) => fs.realpathSync.native(dir)),
    platform: options.platform ?? process.platform,
    now: options.now ?? Date.now,
  };
  const pins = options.pins ?? configPins();
  ctx.verify =
    options.verify ?? ((from, label, base) => verifyAgainstBundle(from, label, base, pins));
  const report = {
    moved: [],
    copied: [],
    kept: [],
    failed: [],
    sources: [],
    items: [],
    swept: [],
  };
  if (String(env.FRIDAY_ADOPT_STAGED ?? "1").trim() === "0") return report;
  // The build's readiness run uses a throwaway FRIDAY folder that is deleted afterwards. Moving the
  // owner's staged models into it would copy gigabytes for nothing and then destroy them.
  if (String(env.FRIDAY_READINESS ?? "").trim() === "1") return report;
  try {
    const target = path.resolve(root);
    await sweepPartials(target, report, { keys: await sourceItemKeys(root, env), now: ctx.now });
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
}

/**
 * Bring what the build staged into `root`. Resolves with what moved, what was copied, what was left because
 * the FRIDAY folder already had it, what failed, `swept` (stale partial copies removed) and `items`, one row per
 * item. Never throws. One job runs per resolved root, a second call for the same root gets the same promise, and
 * jobs for different roots run one after the other.
 * Options inject the machine: `realpath`, `statfs`, `platform`, `verify`, `pins`, `now` (the clock of the sweep).
 */
function adopt(root, options = {}) {
  const { env = process.env } = options;
  if (!root) {
    return Promise.resolve({
      moved: [],
      copied: [],
      kept: [],
      failed: [],
      sources: [],
      items: [],
      swept: [],
    });
  }
  const key = sameKey(root);
  if (jobs.has(key)) return jobs.get(key);
  const job = tail
    .then(() => runAdoption(root, options, env))
    .finally(() => {
      if (jobs.get(key) === job) jobs.delete(key);
    });
  jobs.set(key, job);
  tail = job.then(
    () => undefined,
    () => undefined,
  );
  return job;
}

/** Resolves when no adoption is running, so a download waits instead of repeating one. */
async function whenIdle() {
  while (jobs.size) await tail;
}

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
