// FRIDAY · workspace importer.
//
// Takes anything the user brings in — a FRIDAY ZIP, a folder, loose files or a
// downloaded GitHub archive — unpacks it into <root>/updates/import-<id>,
// recognises every entry through electron/import-classify.cjs, works out the
// exact destination inside the FRIDAY folder, diffs it against what is already
// there and — only when the user confirms — copies it in after backing up every
// affected folder to <root>/backups/import-<stamp>.
//
// Rules (same as electron/updater.cjs):
//   * nothing is written before a backup exists
//   * unrelated user data is never deleted
//   * every apply returns enough information for a one-click rollback
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { OWNERSHIP } = require("./friday-contract.cjs");
const {
  AREAS,
  HOT_AREAS,
  classify,
  discoverPackages,
  inspectPackage,
  slug,
} = require("./import-classify.cjs");
const documents = require("./document-extract.cjs");
const capabilityVerify = require("./capability-verify.cjs");
const packShape = require("./pack-shape.cjs");
const builtinsSync = require("./builtins-sync.cjs");
const transaction = require("./import-transaction.cjs");

const IGNORED = new Set([
  "node_modules",
  ".git",
  ".venv",
  "release",
  "dist",
  "dist-desktop",
  "__pycache__",
  ".cache",
]);

const STACK_HINTS = [
  ["package.json", "Node"],
  ["requirements.txt", "Python"],
  ["pyproject.toml", "Python"],
  ["electron-builder.yml", "Electron"],
  ["manifest.json", "Manifest"],
  ["vite.config.ts", "Vite"],
  ["tsconfig.json", "TypeScript"],
  ["go.mod", "Go"],
  ["Cargo.toml", "Rust"],
  ["Dockerfile", "Docker"],
];

/**
 * The owner's own data. A source update may add a placeholder that is missing
 * but never replaces a file that is already there.
 */
const USER_DATA_DIRS = new Set(OWNERSHIP.data);
const isUserData = (dest) => USER_DATA_DIRS.has(String(dest).split("/")[0]);

/** Files whose change means a source checkout needs its packages refreshed. */
const DEPENDENCY_FILES = [
  [/^package(-lock)?\.json$/, "npm ci"],
  [/^kernel\/requirements[^/]*\.txt$/, "npm run setup:python"],
  [/^kernel\/pyproject\.toml$/, "npm run setup:python"],
];

const uid = () => crypto.randomBytes(5).toString("hex");
const SCAN_LIMIT = 20;
const scanIndexFile = (root) => path.join(root, "updates", "import-scans.json");

function inside(base, target) {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Persist only validated staged scans so Hub/Import actions survive a restart. */
function saveScan(root, scan) {
  if (!root || !scan?.id || !scan?.contentRoot) return false;
  const updates = path.join(root, "updates");
  if (!inside(updates, scan.contentRoot) || !fs.existsSync(scan.contentRoot)) return false;
  const current = loadScans(root);
  const records = [
    { ...scan, workspaceRoot: path.resolve(root), savedAt: Date.now() },
    ...current.filter((item) => item.id !== scan.id),
  ].slice(0, SCAN_LIMIT);
  fs.mkdirSync(updates, { recursive: true });
  const file = scanIndexFile(root);
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(records, null, 2));
  fs.renameSync(temp, file);
  return true;
}

function loadScans(root) {
  if (!root) return [];
  try {
    const records = JSON.parse(fs.readFileSync(scanIndexFile(root), "utf8"));
    if (!Array.isArray(records)) return [];
    const updates = path.join(root, "updates");
    return records
      .filter(
        (scan) =>
          scan?.id &&
          path.resolve(scan.workspaceRoot || "") === path.resolve(root) &&
          inside(updates, scan.contentRoot || "") &&
          fs.existsSync(scan.contentRoot),
      )
      .slice(0, SCAN_LIMIT);
  } catch {
    return [];
  }
}

function walk(dir, base = dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) {
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        /* vanished mid-walk */
      }
      out.push({ path: path.relative(base, full).replace(/\\/g, "/"), size, full });
    }
  }
  return out;
}

/** SHA-1 of a file read in chunks, so a very large file is hashed instead of throwing. */
const hashFile = (file) => {
  let fd = null;
  try {
    fd = fs.openSync(file, "r");
    const hash = crypto.createHash("sha1");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (let got = fs.readSync(fd, buffer, 0, buffer.length, null); got;) {
      hash.update(buffer.subarray(0, got));
      got = fs.readSync(fd, buffer, 0, buffer.length, null);
    }
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
};

const run = (cmd, args, cwd) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, windowsHide: true, timeout: 300_000 }, (err, stdout, stderr) =>
      resolve({ ok: !err, output: String(stdout || stderr || "") }),
    );
  });

function localTar(archive, args) {
  return require("./load-win-spawn.cjs").loadWinSpawn(__dirname).localTar(archive, args);
}

async function extractZipDetailed(archive, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const attempts = [];
  try {
    require("./archive-safe.cjs").extractArchiveFile(archive, targetDir);
    return { ok: true, via: "archive-safe" };
  } catch (error) {
    const message = String(error.message || error);
    if (/unsafe archive entry|expands past|truncated archive|unsupported archive/i.test(message)) {
      return { ok: false, error: message };
    }
    attempts.push(message.slice(0, 300));
  }
  if (process.platform === "win32") {
    // Single quotes inside a PowerShell literal string must be doubled, or a
    // file such as "friday's build.zip" aborts the whole import.
    const safeArchive = String(archive).replace(/'/g, "''");
    const safeTarget = String(targetDir).replace(/'/g, "''");
    const ps = await run("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Expand-Archive -LiteralPath '${safeArchive}' -DestinationPath '${safeTarget}' -Force`,
    ]);
    if (ps.ok) return { ok: true, via: "Expand-Archive" };
    attempts.push(`Expand-Archive: ${ps.output.trim().slice(0, 300)}`);
  }
  const spec = localTar(archive, ["-xf", archive, "-C", targetDir]);
  const tarRun = await run("tar", spec.args, spec.cwd);
  if (tarRun.ok) return { ok: true, via: "tar" };
  attempts.push(`tar: ${tarRun.output.trim().slice(0, 300)}`);
  const unzipRun = await run("unzip", ["-o", archive, "-d", targetDir]);
  if (unzipRun.ok) return { ok: true, via: "unzip" };
  attempts.push(`unzip: ${unzipRun.output.trim().slice(0, 300)}`);
  return { ok: false, error: attempts.filter(Boolean).join(" | ") || "no extractor available" };
}

async function extractZip(archive, targetDir) {
  return (await extractZipDetailed(archive, targetDir)).ok;
}

/** Pack a file or folder with the same tar/zip tools extractZip uses. */
async function createArchive(source, dest) {
  const from = String(source || "");
  const to = String(dest || "");
  if (!from || !fs.existsSync(from))
    return { ok: false, error: "Nothing to archive — path not found." };
  if (!to) return { ok: false, error: "An archive destination is required." };
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const parent = path.dirname(from);
  const name = path.basename(from);
  const attempts = [];
  const spec = localTar(to, ["-czf", to, "-C", parent, name]);
  const tarRun = await run("tar", spec.args, spec.cwd);
  if (tarRun.ok) return { ok: true, via: "tar", file: to };
  attempts.push(
    `tar: ${String(tarRun.output || "")
      .trim()
      .slice(0, 300)}`,
  );
  if (process.platform === "win32") {
    const safeFrom = from.replace(/'/g, "''");
    const safeTo = to.replace(/'/g, "''");
    const ps = await run("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Compress-Archive -LiteralPath '${safeFrom}' -DestinationPath '${safeTo}' -Force`,
    ]);
    if (ps.ok) return { ok: true, via: "Compress-Archive", file: to };
    attempts.push(
      `Compress-Archive: ${String(ps.output || "")
        .trim()
        .slice(0, 300)}`,
    );
  }
  return { ok: false, error: attempts.filter(Boolean).join(" | ") || "no archiver available" };
}

/** A package may wrap everything in a single top-level folder. */
function unwrap(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.name !== "__MACOSX");
  return entries.length === 1 && entries[0].isDirectory() ? path.join(dir, entries[0].name) : dir;
}

/** Extract archives found inside an import, one level deep. */
async function expandNested(contentRoot) {
  const nested = walk(contentRoot).filter((f) => /\.(zip|tgz|tar|tar\.gz)$/i.test(f.path));
  for (const file of nested.slice(0, 8)) {
    const target = path.join(
      path.dirname(file.full),
      path.basename(file.full).replace(/\.[^.]+$/, ""),
    );
    if (fs.existsSync(target)) continue;
    if (await extractZip(file.full, target)) {
      try {
        fs.rmSync(file.full, { force: true });
      } catch {
        /* keep the archive if it is locked */
      }
    }
  }
}

/** Persist raw bytes coming from the renderer into <root>/updates. */
function stageBytes({ root, name, bytes }) {
  if (!root) throw new Error("No FRIDAY workspace is selected.");
  const dir = path.join(root, "updates");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${(name || "import.zip").replace(/[^\w.-]+/g, "_")}`);
  fs.writeFileSync(file, Buffer.from(bytes));
  return { ok: true, file, bytes: Buffer.from(bytes).length };
}

/**
 * Stage one file of a multi-file / folder upload into a staging directory.
 * `id` groups the files of a single upload; the caller reuses it per file.
 */
function stageFile({ root, id, relative, bytes }) {
  if (!root) throw new Error("No FRIDAY workspace is selected.");
  const safeId = String(id || uid()).replace(/[^\w-]+/g, "");
  const stageDir = path.join(root, "updates", `stage-${safeId}`);
  const rel = String(relative || "file")
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  const target = path.join(stageDir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.from(bytes));
  return { ok: true, id: safeId, dir: stageDir, file: target };
}

/** Download a remote archive or file (GitHub codeload, release asset, …) to updates/. */
async function downloadArchive({
  root,
  url,
  name,
  token,
  onProgress = () => {},
  signal,
  downloader,
}) {
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };
  try {
    const dir = path.join(root, "updates");
    fs.mkdirSync(dir, { recursive: true });
    const resilient = require("./resilient-download.cjs");
    // A source archive has no announced length and GitHub cannot resume it, so a
    // dropped connection starts it again; the archive is checked for its end.
    const got = await (downloader || resilient.downloadToFile)({
      url,
      token: token || "",
      part: path.join(dir, `.download-${process.pid}.part`),
      dest: (response) =>
        path.join(dir, `${Date.now()}-${filenameFromDownload(url, name, response)}`),
      resume: false,
      signal,
      onProgress,
      phase: "Downloading from GitHub",
      headers: { accept: "*/*" },
      validate: async (file) => resilient.archiveProblem(file),
    });
    if (!got.ok)
      return {
        ok: false,
        error: got.error || "The download failed.",
        ...(got.cancelled ? { cancelled: true } : {}),
      };
    return { ok: true, file: got.file, bytes: got.bytes, attempts: got.attempts };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

function filenameFromDownload(url, name, response) {
  const disposition = String(response?.headers?.get?.("content-disposition") || "");
  const quoted = disposition.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i);
  const fromHeader = quoted ? decodeURIComponent(quoted[1]).trim() : "";
  let fromUrl = "";
  try {
    fromUrl = path.basename(new URL(url).pathname);
  } catch {
    fromUrl = "";
  }
  const raw = fromHeader || fromUrl || String(name || "download");
  const safe = raw.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "") || "download";
  if (/\.[a-z0-9]{1,8}$/i.test(safe)) return safe.slice(0, 160);
  return `${safe.slice(0, 140)}.bin`;
}

/**
 * Unpack + recognise + diff. Nothing in the workspace is touched here.
 * Returns { ok, id, staging, mode, files:[{path,dest,state,area,reason}], areas, summary }.
 */
async function scanImport({ root, source, onProgress = () => {}, layout = "" }) {
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };
  if (!source || !fs.existsSync(source)) {
    return { ok: false, error: "The selected import could not be found." };
  }

  const id = uid();
  const staging = path.join(root, "updates", `import-${id}`);
  onProgress({ id, phase: "Extracting" });

  let contentRoot = source;
  const isFile = fs.statSync(source).isFile();
  if (isFile && /\.(zip|tgz|tar|tar\.gz)$/i.test(source)) {
    const extracted = await extractZipDetailed(source, staging);
    if (!extracted.ok) {
      fs.rmSync(staging, { recursive: true, force: true });
      return { ok: false, error: `The archive could not be extracted — ${extracted.error}` };
    }
    contentRoot = unwrap(staging);
  } else if (isFile) {
    // A single loose file — stage it on its own so the pipeline is identical.

    fs.mkdirSync(staging, { recursive: true });
    fs.copyFileSync(source, path.join(staging, path.basename(source)));
    contentRoot = staging;
  } else {
    fs.mkdirSync(staging, { recursive: true });
    fs.cpSync(source, staging, { recursive: true, filter: (p) => !IGNORED.has(path.basename(p)) });
    contentRoot = unwrap(staging);
  }

  onProgress({ id, phase: "Recognising" });
  await expandNested(contentRoot);
  const info = {
    ...inspectPackage(contentRoot, path.basename(source)),
    ...(layout ? { layout } : {}),
  };

  onProgress({ id, phase: "Scanning" });
  const found = walk(contentRoot);
  if (!found.length) {
    fs.rmSync(staging, { recursive: true, force: true });
    return { ok: false, error: "The import contains no readable files." };
  }

  const areas = new Map();
  const destinations = new Map();
  const stack = new Set();
  let added = 0;
  let changed = 0;
  let identical = 0;

  for (const file of found) {
    const verdict = classify(file.path, { ...info, full: file.full });
    const current = path.join(root, verdict.dest);
    let state = "added";
    if (fs.existsSync(current)) {
      state = hashFile(current) === hashFile(file.full) ? "same" : "changed";
    }
    if (state === "added") added += 1;
    else if (state === "changed") changed += 1;
    else identical += 1;
    file.state = state;
    file.area = verdict.area;
    file.dest = verdict.dest;
    file.reason = verdict.reason;
    file.hot = verdict.hot;
    file.extract = Boolean(verdict.extract);
    file.needsApproval = Boolean(verdict.needsApproval);

    const bucket = areas.get(verdict.area) || {
      area: verdict.area,
      hot: verdict.hot,
      files: 0,
      added: 0,
      changed: 0,
      bytes: 0,
      reason: verdict.reason,
    };
    bucket.files += 1;
    bucket.bytes += file.size;
    if (state === "added") bucket.added += 1;
    if (state === "changed") bucket.changed += 1;
    areas.set(verdict.area, bucket);

    const home = verdict.dest.split("/").slice(0, 2).join("/");
    destinations.set(home, (destinations.get(home) || 0) + 1);

    const name = file.path.split("/").pop() || "";
    for (const [hint, label] of STACK_HINTS) if (name === hint) stack.add(label);
  }

  let version = null;
  try {
    version =
      JSON.parse(fs.readFileSync(path.join(contentRoot, "package.json"), "utf8")).version || null;
  } catch {
    /* not a FRIDAY source package — still importable */
  }

  return {
    ok: true,
    id,
    staging,
    contentRoot,
    mode: info.mode,
    ...(layout ? { layout } : {}),
    label: info.label,
    packageName: info.packageName,
    version,
    stack: [...stack],
    areas: [...areas.values()].sort((a, b) => b.files - a.files),
    destinations: [...destinations.entries()]
      .map(([dir, files]) => ({ dir, files }))
      .sort((a, b) => b.files - a.files),
    files: found.slice(0, 500).map((f) => ({
      path: f.path,
      dest: f.dest,
      size: f.size,
      state: f.state,
      area: f.area,
      reason: f.reason,
      extract: Boolean(f.extract),
      needsApproval: Boolean(f.needsApproval),
    })),
    summary: {
      total: found.length,
      added,
      changed,
      identical,
      bytes: found.reduce((n, f) => n + f.size, 0),
      restartRequired: [...areas.values()].some((a) => !a.hot && (a.added || a.changed)),
    },
  };
}

/** Canonical folders FRIDAY keeps in place so the tree stays organised. */
const CANONICAL = [
  "agents/custom",
  "backups",
  "brain-data/knowledge",
  "config",
  "database/backups",
  "memory/permanent",
  "memory/semantic",
  "models/local",
  "models/manifests",
  "modules/custom",
  "plugins/installed",
  "resources/assets",
  "resources/fonts",
  "resources/icons",
  "resources/sounds",
  "skills/custom",
  "tools/custom",
  "updates/unsorted",
  "voices",
  "memory/imports/chats",
  "config/connector-imports",
  "workflows/saved",
  "workspace/projects",
];

function ensureLayout(root) {
  for (const dir of CANONICAL) fs.mkdirSync(path.join(root, dir), { recursive: true });
}

/** Provenance a manifest carries once Update content placed it. */
const RELEASE_CONTENT = "release-content";
/** The content hash written next to the mark: the item as it was when the mark was written. */
const MARK_HASH = "releaseSha256";
const ALREADY_IN_RELEASE = "already in this release";
const OWNER_PROVENANCE = new Set(["user", "import", "marketplace", "forge"]);
/** Why Update content kept a workspace item instead of replacing it. */
const KEPT_REASON = {
  unmarked: "unmarked copy",
  owner: "your own item",
  edited: "edited since it landed",
  legacy: "unmarked or legacy mark",
  file: "your own file",
};

/**
 * The record of what this installer ships (resources/builtins.json), or null
 * when this is not a packaged install or the file is missing or foreign. Null
 * keeps every import exactly as it was before the record existed.
 */
function readBuiltinsManifest(resourcesDir = process.resourcesPath) {
  if (!resourcesDir) return null;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(resourcesDir, "builtins.json"), "utf8"));
    const ok = data && data.schema === 1 && data.trees && typeof data.trees === "object";
    return ok ? data : null;
  } catch {
    return null;
  }
}

const parseVersion = (value) => {
  const match = /^v?(\d+(?:\.\d+){0,3})/.exec(String(value ?? "").trim());
  return match ? match[1].split(".").map(Number) : null;
};

/**
 * `incoming` is strictly newer than `shipped`. The dotted-number comparison is
 * the one capabilities.cjs versionGreater uses (a parity test pins it); the one
 * deliberate difference is that an unreadable shipped version counts as older.
 */
function versionNewer(incoming, shipped) {
  const left = parseVersion(incoming);
  if (!left) return false;
  const right = parseVersion(shipped);
  if (!right) return true;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/** Both versions read as dotted numbers and neither is newer. */
const sameVersion = (a, b) =>
  Boolean(parseVersion(a) && parseVersion(b)) && !versionNewer(a, b) && !versionNewer(b, a);

/** A manifest as the owner's editor may have saved it: a UTF-8 byte order mark is not content. */
const readJsonFile = (file) => {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
};

/**
 * Same bytes, or the same manifest apart from the provenance mark (and its
 * content hash) Update content wrote, so applying one release twice changes
 * nothing the second time.
 */
function sameFile(current, incoming) {
  if (hashFile(current) === hashFile(incoming)) return true;
  if (!current.endsWith(".json") || !incoming.endsWith(".json")) return false;
  const mine = readJsonFile(current);
  const theirs = readJsonFile(incoming);
  if (!mine || !theirs || mine.provenance !== RELEASE_CONTENT) return false;
  for (const data of [mine, theirs]) {
    delete data.provenance;
    delete data[MARK_HASH];
  }
  return JSON.stringify(mine) === JSON.stringify(theirs);
}

/** A real digest; the all-zero digest is the "no content recorded" placeholder. */
const realDigest = (value) =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value) && !/^0+$/.test(value);

/**
 * The content hash of a landed item: the ONE recipe of builtins-sync.cjs itemHash (sorted
 * "relpath\0filehash\n" lines, one ignore list, chunked reads), with the manifest taken from
 * `manifestText` instead of the disk: the stored hash cannot contain itself, so it is the hash
 * of the item as it was before the hash field was written.
 */
const landedHash = (target, manifestFile, manifestText) =>
  builtinsSync.itemHash(target, {
    override: manifestFile ? { file: manifestFile, text: manifestText } : null,
  });

const markText = (data) => `${JSON.stringify(data, null, 2)}\n`;
/** The manifest as it stood when the mark was written (no hash field yet). */
const withoutMarkHash = (data) => {
  const { [MARK_HASH]: _hash, ...rest } = data;
  return rest;
};

const isEmptyDir = (dir) => {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return false;
  }
};

/**
 * Whose is the workspace copy of an item? Returns null when Update content may
 * replace it (nothing there, an empty folder, a release-content copy that is
 * unchanged since it landed, or an unmarked copy that is byte-for-byte the
 * shipped built-in), otherwise why it is kept, with the manifest it read.
 * Fails closed: a copy with no readable release-content mark, or with a mark that carries no
 * content hash, is the owner's.
 */
function workspaceVerdict({ workspaceDir, names, built }) {
  let stat;
  try {
    stat = fs.statSync(workspaceDir);
  } catch {
    return null;
  }
  if (stat.isDirectory() && isEmptyDir(workspaceDir)) return null;
  const manifestFile = stat.isFile()
    ? workspaceDir
    : names.map((name) => path.join(workspaceDir, name)).find((file) => fs.existsSync(file));
  const mine = manifestFile ? readJsonFile(manifestFile) : null;
  const marked = Boolean(mine && mine.provenance === RELEASE_CONTENT);
  if (marked && MARK_HASH in mine) {
    let current = null;
    try {
      current = landedHash(workspaceDir, manifestFile, markText(withoutMarkHash(mine)));
    } catch {
      /* unreadable item: kept */
    }
    return current !== null && current === mine[MARK_HASH]
      ? null
      : { mine, reason: KEPT_REASON.edited };
  }
  // No hash to check (no mark, or a mark from before the hash existed): the owner's, unless the
  // bytes are the shipped built-in (a marked copy is compared with and without its mark).
  if (built && realDigest(built.sha256)) {
    try {
      if (builtinsSync.itemHash(workspaceDir) === built.sha256) return null;
      if (marked) {
        const { provenance: _mark, ...bare } = withoutMarkHash(mine);
        const text = markText(bare);
        if (landedHash(workspaceDir, manifestFile, text) === built.sha256) return null;
      }
    } catch {
      /* unreadable item: kept */
    }
  }
  return {
    mine,
    reason: marked
      ? KEPT_REASON.legacy
      : OWNER_PROVENANCE.has(mine?.provenance)
        ? KEPT_REASON.owner
        : KEPT_REASON.unmarked,
  };
}

/** Is this staged item already part of the installer, by version and (when recorded) content? */
function alreadyShipped(item, built) {
  if (versionNewer(item.version, built.version)) return false;
  if (!realDigest(built.sha256) || !sameVersion(item.version, built.version)) return true;
  try {
    return builtinsSync.itemHash(item.path) === built.sha256;
  } catch {
    return true;
  }
}

/**
 * Decide, item by item, what a release's content merge may place.
 *   * the installer already ships the item (older, or the same version with
 *     the same content): skipped, reported as "already in this release";
 *   * a workspace item without a readable release-content mark, or one the
 *     owner edited after it landed: never replaced (see workspaceVerdict);
 *   * everything else lands and gets the release-content mark and its hash.
 * Nothing here deletes a file.
 */
function planContentUpdate({ root, contentRoot, files, builtins }) {
  const capabilities = require("./capabilities.cjs");
  const shipped = new Map();
  for (const list of Object.values(builtins.trees || {})) {
    for (const item of Array.isArray(list) ? list : []) {
      if (item && typeof item.id === "string") shipped.set(item.id.toLowerCase(), item);
    }
  }
  // Items by relative path: a file belongs to the longest folder that holds it,
  // or to the flat manifest file that is the item itself.
  const byRel = new Map();
  for (const item of capabilities.scanRoot(contentRoot, "app", [contentRoot])) {
    const rel = path.relative(contentRoot, item.path).replace(/\\/g, "/");
    if (!byRel.has(rel)) byRel.set(rel, { item, rel });
  }
  const finderFor = (items) => (filePath) => {
    const exact = items.get(filePath);
    if (exact) return exact;
    for (let cut = filePath.lastIndexOf("/"); cut > 0; cut = filePath.lastIndexOf("/", cut - 1)) {
      const hit = items.get(filePath.slice(0, cut));
      if (hit) return hit;
    }
    return null;
  };
  const findItem = finderFor(byRel);
  // The same lookup from the WORKSPACE side, scanned once and only when a file needs it: a
  // repo file with no item of its own (a manifest that is damaged, a BOM the scan cannot read, a
  // folder no tree names) is still judged by the owner's item it would land in.
  let workspaceFinder = null;
  const findWorkspaceItem = (dest) => {
    if (!workspaceFinder) {
      const items = new Map();
      for (const item of capabilities.scanRoot(root, "workspace", [root])) {
        const rel = path.relative(root, item.path).replace(/\\/g, "/");
        if (!items.has(rel)) items.set(rel, { item, rel });
      }
      workspaceFinder = finderFor(items);
    }
    return workspaceFinder(dest);
  };
  const landingTargets = new Set();
  const addLanding = (target, manifestFile) => {
    if (landingTargets.has(target)) return;
    landingTargets.add(target);
    landing.push({ target, manifestFile });
  };

  const decided = new Map();
  const alreadyInRelease = [];
  const keptYours = [];
  const landing = [];
  const kept = [];
  const yours = (id, tree, incomingVersion, owned) =>
    keptYours.push({
      id,
      tree,
      version: owned.mine?.version == null ? null : String(owned.mine.version),
      incomingVersion,
      provenance: OWNER_PROVENANCE.has(owned.mine?.provenance) ? owned.mine.provenance : "user",
      reason: owned.reason,
    });
  for (const file of files) {
    const hit = findItem(file.path);
    if (!hit) {
      // No item of its own in the release.
      const dest = file.dest;
      const under = findWorkspaceItem(dest);
      if (under) {
        const key = `workspace:${under.rel}`;
        if (!decided.has(key)) {
          const workspaceDir = path.join(root, ...under.rel.split("/"));
          const built = shipped.get(String(under.item.id).toLowerCase());
          const names = capabilities.TREES[under.item.tree]?.names || [];
          const owned = inside(root, workspaceDir)
            ? workspaceVerdict({ workspaceDir, names, built })
            : { mine: null, reason: KEPT_REASON.unmarked };
          if (owned) {
            yours(under.item.id, under.item.tree, null, owned);
            decided.set(key, "yours");
          } else {
            const flat =
              under.item.manifestFile &&
              path.resolve(under.item.manifestFile) === path.resolve(under.item.path);
            addLanding(workspaceDir, flat ? workspaceDir : under.item.manifestFile || null);
            decided.set(key, "land");
          }
        }
        if (decided.get(key) === "land") kept.push(file);
      } else if (fs.existsSync(path.join(root, dest))) {
        // A different file is already there and nothing says it is release content.
        yours(dest, dest.split("/")[0], null, { mine: null, reason: KEPT_REASON.file });
      } else {
        kept.push(file);
      }
      continue;
    }
    if (!decided.has(hit.rel)) {
      const { item, rel } = hit;
      const built = shipped.get(String(item.id).toLowerCase());
      const names = capabilities.TREES[item.tree]?.names || [];
      const workspaceDir = path.join(root, ...rel.split("/"));
      let verdict = "land";
      if (built && alreadyShipped(item, built)) {
        verdict = "shipped";
        alreadyInRelease.push({
          id: item.id,
          tree: item.tree,
          version: item.version,
          builtinVersion: built.version ?? null,
          reason: ALREADY_IN_RELEASE,
        });
      } else if (inside(root, workspaceDir)) {
        const owned = workspaceVerdict({ workspaceDir, names, built });
        if (owned) {
          verdict = "yours";
          yours(item.id, item.tree, item.version, owned);
        }
      }
      if (verdict === "land") {
        const flat =
          item.manifestFile && path.resolve(item.manifestFile) === path.resolve(item.path);
        addLanding(
          workspaceDir,
          flat
            ? workspaceDir
            : item.manifestFile
              ? path.join(workspaceDir, path.basename(item.manifestFile))
              : null,
        );
      }
      decided.set(hit.rel, verdict);
    }
    if (decided.get(hit.rel) === "land") kept.push(file);
  }
  return { files: kept, alreadyInRelease, keptYours, landing };
}

/**
 * An imported manifest never carries the release-content mark in: only this module writes it,
 * and only for what Update content itself places (markReleaseContent runs after the copy).
 * A copied `.json` that claims it is rewritten as an import, hash and all.
 */
function scrubForgedMark(file) {
  try {
    if (fs.statSync(file).size > 2 * 1024 * 1024) return;
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.includes(RELEASE_CONTENT)) return;
    const data = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    if (data.provenance !== RELEASE_CONTENT) return;
    fs.writeFileSync(file, markText({ ...withoutMarkHash(data), provenance: "import" }));
  } catch {
    /* not a readable manifest: nothing to scrub */
  }
}

/**
 * Mark a placed item as content that came with a release (never the owner's
 * own work), with the hash of the item as placed: an item the owner edits
 * afterwards no longer matches it and is the owner's from then on.
 */
function markReleaseContent({ target, manifestFile }) {
  if (!manifestFile) return;
  const data = readJsonFile(manifestFile);
  if (!data) return;
  const base = { ...withoutMarkHash(data), provenance: RELEASE_CONTENT };
  // An item that cannot be hashed (a locked file) is marked without a hash: it reads as the
  // owner's until a release ships its exact bytes, so one odd file never fails Update content.
  let hash = null;
  try {
    hash = landedHash(target, manifestFile, markText(base));
  } catch {
    /* marked without a hash */
  }
  const temp = `${manifestFile}.tmp`;
  fs.writeFileSync(temp, markText(hash ? { ...base, [MARK_HASH]: hash } : base));
  fs.renameSync(temp, manifestFile);
}

/**
 * Copy a scanned import into the workspace after backing up every top-level
 * folder it touches. Returns { ok, backup, applied, restartRequired, areas }.
 */
async function applyImport({
  root,
  scan,
  onProgress = () => {},
  keepBackup = true,
  areas = null,
  builtins,
  resourcesPath,
}) {
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };
  const contentRoot = scan?.contentRoot;
  if (!contentRoot || !fs.existsSync(contentRoot)) {
    return { ok: false, error: "This import is no longer staged — scan it again." };
  }

  ensureLayout(root);
  const info = {
    mode: scan.mode,
    packageName: scan.packageName,
    manifestKind: scan.manifestKind,
    manifestName: scan.manifestName,
    ...(scan.layout ? { layout: scan.layout } : {}),
    // The scan travels over IPC, so the recognised packages are re-derived here
    // from the same staged tree — apply must place files exactly where the
    // preview said it would.
    packages: scan.mode === "loose" ? discoverPackages(contentRoot) : undefined,
  };

  const allowed = Array.isArray(areas) && areas.length ? new Set(areas.map(String)) : null;
  let preserved = 0;
  // A release's content merge into an installed app: what the installer already
  // ships is not copied again (see planContentUpdate). Outside a packaged
  // install there is no built-ins record and nothing here applies.
  const shipped =
    scan.githubRef && scan.layout === "repo"
      ? builtins !== undefined
        ? builtins
        : readBuiltinsManifest(resourcesPath)
      : null;
  let plan = null;
  const candidates = walk(contentRoot)
    .map((file) => {
      const verdict = classify(file.path, { ...info, full: file.full });
      return {
        ...file,
        dest: verdict.dest,
        area: verdict.area,
        hot: verdict.hot,
        extract: Boolean(verdict.extract),
      };
    })
    .filter((f) => (allowed ? allowed.has(f.area) : true))
    .filter((f) => {
      const current = path.join(root, f.dest);
      return (
        !fs.existsSync(current) ||
        !(shipped ? sameFile(current, f.full) : hashFile(current) === hashFile(f.full))
      );
    });
  if (shipped) {
    plan = planContentUpdate({ root, contentRoot, files: candidates, builtins: shipped });
  }
  const contentReport = {
    alreadyInRelease: plan ? plan.alreadyInRelease : [],
    keptYours: plan ? plan.keptYours : [],
  };
  const files = (plan ? plan.files : candidates).filter((f) => {
    // A GitHub source update never replaces the owner's own data.
    if (
      (scan.githubRef || scan.layout === "repo") &&
      isUserData(f.dest) &&
      fs.existsSync(path.join(root, f.dest))
    ) {
      preserved += 1;
      return false;
    }
    return true;
  });
  if (!files.length) {
    return {
      ok: true,
      applied: 0,
      backup: null,
      restartRequired: false,
      areas: [],
      placed: [],
      preserved,
      dependencyChanges: [],
      ...contentReport,
    };
  }

  onProgress({ id: scan.id, phase: "Backing up" });
  const tops = new Set(files.map((f) => f.dest.split("/")[0]));
  const { backup, stamp } = transaction.createBackup({
    root,
    prefix: "import",
    tops: [...tops],
    details: { mode: scan.mode, files: files.map((f) => f.dest) },
  });

  onProgress({ id: scan.id, phase: "Installing" });
  const touched = new Set();
  const placed = new Map();
  let applied = 0;
  try {
    for (const file of files) {
      const target = path.join(root, file.dest);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file.full, target);
      if (/\.json$/i.test(target)) scrubForgedMark(target);
      if (file.extract) extractDocumentBeside(target, file.full);
      touched.add(file.area);
      const home = file.dest.split("/").slice(0, 2).join("/");
      placed.set(home, (placed.get(home) || 0) + 1);
      applied += 1;
    }
    // Content that came with a release is marked, so it is never mistaken for
    // something the owner made (and a rollback of this apply removes the mark).
    for (const item of plan ? plan.landing : []) markReleaseContent(item);
  } catch (error) {
    // Put everything back exactly as it was before this import started.
    transaction.restoreBackup({ root, backup });
    return { ok: false, error: `Import failed and was rolled back: ${error.message}` };
  }

  const restartRequired = [...touched].some((area) => !HOT_AREAS.has(area));
  if (!keepBackup) {
    try {
      fs.rmSync(backup, { recursive: true, force: true });
    } catch {
      /* keep it if the OS holds a handle */
    }
  }
  return {
    ok: true,
    applied,
    backup: keepBackup ? backup : null,
    areas: [...touched],
    placed: [...placed.entries()].map(([dir, count]) => ({ dir, files: count })),
    restartRequired,
    preserved,
    ...contentReport,
    dependencyChanges: files
      .map((f) => {
        const hit = DEPENDENCY_FILES.find(([pattern]) => pattern.test(f.dest));
        return hit ? { file: f.dest, command: hit[1] } : null;
      })
      .filter(Boolean),
    at: stamp,
  };
}

/** Restore a backup produced by applyImport. */
function rollbackImport({ root, backup }) {
  return transaction.restoreBackup({ root, backup });
}

function extractDocumentBeside(target, source) {
  try {
    const bytes = fs.readFileSync(source);
    const extracted = documents.extract({ filename: path.basename(source), bytes });
    const text = String(extracted?.text || "").trim();
    if (!text) return;
    const beside = `${target}.extracted.txt`;
    fs.writeFileSync(beside, text, "utf8");
  } catch {
    /* extract is best-effort; the original file is already copied */
  }
}

const KIND_TREE = {
  skill: "skills",
  tool: "tools",
  agent: "agents",
  module: "modules",
  plugin: "plugins",
  workflow: "workflows",
};

/**
 * Sandbox-verify each discovered pack with capability-verify (the same module
 * the *-forge.ts sandboxVerify path uses). Packs without a runnable tree are
 * skipped honestly instead of faking a pass.
 */
async function verifyStagedPacks({ root, scan }) {
  const contentRoot = scan?.contentRoot;
  if (!root || !contentRoot || !fs.existsSync(contentRoot)) {
    return { ok: false, error: "This import is no longer staged — scan it again.", packs: [] };
  }
  const info = inspectPackage(contentRoot, scan.packageName || path.basename(contentRoot));
  const pending = [];
  if (info.mode === "manifest" && info.manifestKind) {
    pending.push({
      dir: "",
      kind: info.manifestKind,
      name: info.manifestName || info.packageName,
    });
  }
  const nested = discoverPackages(contentRoot);
  for (const [dir, pkg] of nested) {
    pending.push({ dir, kind: pkg.kind, name: pkg.name });
  }

  const packs = [];
  for (const item of pending) {
    const tree = KIND_TREE[item.kind];
    const dir = path.join(contentRoot, item.dir);
    if (!tree) {
      packs.push({
        id: item.name,
        kind: item.kind,
        ok: true,
        skipped: true,
        detail: "no forge verify for this kind",
      });
      continue;
    }
    const shaped = packShape.detectPackShape({
      filename: `${item.kind}.json`,
      kind: item.kind,
      manifestName: `${item.kind}.json`,
    });
    const result = await capabilityVerify.verifyCapability(
      { root },
      { id: `${tree}/${item.name}`, tree: shaped.tree || tree, dir },
      { allowInstall: false },
    );
    packs.push({
      id: item.name,
      kind: item.kind,
      tree: shaped.tree || tree,
      ok: Boolean(result.ok),
      skipped: false,
      detail: result.error || result.status || (result.ok ? "sandbox passed" : "sandbox failed"),
      status: result.status,
    });
  }

  const ok = packs.length ? packs.every((p) => p.ok || p.skipped) : true;
  return { ok, packs };
}

module.exports = {
  AREAS,
  isUserData,
  classify,
  inspectPackage,
  ensureLayout,
  scanImport,
  applyImport,
  readBuiltinsManifest,
  versionNewer,
  rollbackImport,
  verifyStagedPacks,
  filenameFromDownload,
  stageBytes,
  stageFile,
  downloadArchive,
  saveScan,
  loadScans,
  walk,
  CANONICAL,
  extractZip,
  extractZipDetailed,
  createArchive,
};
