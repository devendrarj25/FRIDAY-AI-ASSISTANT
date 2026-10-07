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

const hashFile = (file) => {
  try {
    return crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
};

const run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 300_000 }, (err, stdout, stderr) =>
      resolve({ ok: !err, output: String(stdout || stderr || "") }),
    );
  });

async function extractZipDetailed(archive, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const attempts = [];
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
  const tarRun = await run("tar", ["-xf", archive, "-C", targetDir]);
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
  const tarRun = await run("tar", ["-czf", to, "-C", parent, name]);
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
async function downloadArchive({ root, url, name, token }) {
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };
  try {
    const headers = { "User-Agent": "FRIDAY" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const response = await fetch(url, { headers, redirect: "follow" });
    if (!response.ok) return { ok: false, error: `Download failed (${response.status})` };
    const buffer = Buffer.from(await response.arrayBuffer());
    const dir = path.join(root, "updates");
    fs.mkdirSync(dir, { recursive: true });
    const hinted = filenameFromDownload(url, name, response);
    const file = path.join(dir, `${Date.now()}-${hinted}`);
    fs.writeFileSync(file, buffer);
    return { ok: true, file, bytes: buffer.length };
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
async function scanImport({ root, source, onProgress = () => {} }) {
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
  const info = inspectPackage(contentRoot, path.basename(source));

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

/**
 * Copy a scanned import into the workspace after backing up every top-level
 * folder it touches. Returns { ok, backup, applied, restartRequired, areas }.
 */
async function applyImport({ root, scan, onProgress = () => {}, keepBackup = true, areas = null }) {
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
    // The scan travels over IPC, so the recognised packages are re-derived here
    // from the same staged tree — apply must place files exactly where the
    // preview said it would.
    packages: scan.mode === "loose" ? discoverPackages(contentRoot) : undefined,
  };

  const allowed = Array.isArray(areas) && areas.length ? new Set(areas.map(String)) : null;
  const files = walk(contentRoot)
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
      return !fs.existsSync(current) || hashFile(current) !== hashFile(f.full);
    });
  if (!files.length) {
    return { ok: true, applied: 0, backup: null, restartRequired: false, areas: [], placed: [] };
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
      if (file.extract) extractDocumentBeside(target, file.full);
      touched.add(file.area);
      const home = file.dest.split("/").slice(0, 2).join("/");
      placed.set(home, (placed.get(home) || 0) + 1);
      applied += 1;
    }
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
  classify,
  inspectPackage,
  ensureLayout,
  scanImport,
  applyImport,
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
