/**
 * FRIDAY · canonical project-root and database resolution (main process only).
 *
 * Why this exists: the packaged app has three different "roots" and the Doctor
 * used `process.resourcesPath` for all of them, so it searched for
 * `D:\FRIDAY\resources\package.json` — a file that never exists. The manifest
 * lives in the real project root (`D:\FRIDAY\package.json`) or inside the asar
 * archive. This module resolves all of them once, from real files on disk, and
 * every other module reuses it instead of guessing.
 *
 * Nothing here creates a duplicate package.json. It only *finds* the real one.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { resolveManagedPython } = require("./python.cjs");

const WIN = process.platform === "win32";

const exists = (p) => {
  try {
    return Boolean(p) && fs.existsSync(p);
  } catch {
    return false;
  }
};

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

/**
 * Ordered candidates for the directory that owns package.json.
 * The first candidate holding a readable manifest wins; a manifest whose name
 * is FRIDAY's own wins over any other.
 */
function projectRootCandidates({ appPath = null, resourcesPath = null, exePath = null } = {}) {
  const res = resourcesPath || process.resourcesPath || null;
  const exeDir = exePath ? path.dirname(exePath) : null;
  return [
    process.env.FRIDAY_PROJECT_ROOT || null,
    appPath, // dev: repo root · packaged: …/resources/app(.asar)
    res ? path.join(res, "app") : null,
    res ? path.join(res, "app.asar") : null,
    exeDir, // packaged install root — D:\FRIDAY
    res ? path.dirname(res) : null,
    process.cwd(),
  ].filter(Boolean);
}

let cachedRoot = null;

/** Resolve the real project root (the folder whose package.json is FRIDAY's). */
function resolveProjectRoot(ctx = {}) {
  if (cachedRoot && exists(path.join(cachedRoot, "package.json"))) return cachedRoot;
  const candidates = projectRootCandidates(ctx);
  let fallback = null;
  for (const dir of candidates) {
    const manifest = path.join(dir, "package.json");
    if (!exists(manifest)) continue;
    const pkg = readJson(manifest);
    if (!pkg) continue;
    if (
      String(pkg.name || "")
        .toLowerCase()
        .includes("friday")
    ) {
      cachedRoot = dir;
      return dir;
    }
    fallback = fallback || dir;
  }
  cachedRoot = fallback || candidates[0] || process.cwd();
  return cachedRoot;
}

/** Locate a project file across project root, resources and the workspace. */
function locate(relative, ctx = {}) {
  const roots = [
    resolveProjectRoot(ctx),
    ctx.resourcesPath || process.resourcesPath || null,
    ctx.install || null,
    ctx.root || null,
  ].filter(Boolean);
  for (const base of roots) {
    const full = path.join(base, relative);
    if (exists(full)) return full;
  }
  return null;
}

/* ------------------------------------------------------------------ SQLite */

/**
 * The kernel writes to FRIDAY_DATA_DIR/friday.sqlite3 (see kernel/main.py and
 * the env block in electron/main.cjs). Older builds looked for friday.db in
 * userData, which never existed, so a healthy first run was reported as a
 * failure. Both names are accepted; the canonical one is created on demand.
 */
function databasePath(userData) {
  return path.join(userData, "data", "friday.sqlite3");
}

function databaseCandidates(userData, root) {
  // The selected FRIDAY folder owns the database. userData paths stay in the
  // list only so a pre-workspace first run and older installs are still found.
  return [
    process.env.FRIDAY_DB_PATH || null,
    root ? path.join(root, "database", "friday.sqlite3") : null,
    root ? path.join(root, "database", "friday.db") : null,
    root ? path.join(root, "data", "friday.sqlite3") : null,
    databasePath(userData),
    path.join(userData, "friday.db"),
  ].filter(Boolean);
}

function isSqliteFile(file) {
  try {
    const header = Buffer.alloc(16);
    const fd = fs.openSync(file, "r");
    fs.readSync(fd, header, 0, 16, 0);
    fs.closeSync(fd);
    return header.toString("utf8", 0, 15) === "SQLite format 3";
  } catch {
    return false;
  }
}

/**
 * Interpreter used by ensureDatabase() / runPython(). The selected FRIDAY
 * folder's runtime/.venv wins; the app/checkout tree is the next managed
 * fallback (legacy <root>/.venv via resolveManagedPython). PATH/env only
 * after both managed locations miss.
 */
function resolveDatabasePython({ install = null, root = null } = {}, options = {}) {
  const tried = [];
  const seen = new Set();

  const consider = (fridayRoot, rootKind) => {
    if (!fridayRoot) return null;
    let resolved;
    try {
      resolved = path.resolve(fridayRoot);
    } catch {
      resolved = String(fridayRoot);
    }
    if (seen.has(resolved)) return null;
    seen.add(resolved);
    const picked = resolveManagedPython(fridayRoot, options);
    for (const candidate of picked.tried) {
      tried.push(candidate);
    }
    if (picked.exe) {
      return {
        exe: picked.exe,
        source: `${rootKind}:${picked.source}`,
        tried,
        reason: picked.reason,
      };
    }
    return null;
  };

  const fromWorkspace = consider(root, "workspace");
  if (fromWorkspace) return fromWorkspace;

  const appRoot =
    install && exists(path.join(install, "package.json")) ? install : resolveProjectRoot({});
  const fromApp = consider(appRoot, "app");
  if (fromApp) return fromApp;

  const missing = tried.slice();
  const missingNote = missing.length
    ? `no managed interpreter (tried: ${missing.join(", ")})`
    : "no managed interpreter";

  const envPy = options.env?.FRIDAY_PYTHON ?? process.env.FRIDAY_PYTHON;
  if (envPy) {
    tried.push(envPy);
    return {
      exe: envPy,
      source: "env",
      tried,
      reason: `${missingNote}; using FRIDAY_PYTHON`,
    };
  }

  const win32 = options.win32 ?? WIN;
  const system = win32 ? "python" : "python3";
  tried.push(system);
  return {
    exe: system,
    source: "system",
    tried,
    reason: `${missingNote}; using system ${system}`,
  };
}

const runPython = (code, timeout = 30_000, install = null, workspaceRoot = null) =>
  new Promise((resolve) => {
    const picked = resolveDatabasePython({ install, root: workspaceRoot });
    try {
      execFile(
        picked.exe,
        ["-B", "-c", code],
        {
          timeout,
          windowsHide: true,
          // -B + the env flag keep __pycache__ out of the checkout/install tree.
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
        },
        (err, stdout, stderr) => {
          const out = `${stdout || ""}${stderr || ""}`.trim();
          resolve({ ok: !err, out, python: picked });
        },
      );
    } catch (err) {
      resolve({ ok: false, out: String(err.message), python: picked });
    }
  });

/**
 * Create the database and its schema if it does not exist, then run a real
 * integrity check. Uses the kernel's own schema so there is exactly one
 * definition of the tables (kernel/db.py stays the single source of truth).
 */
async function ensureDatabase({ userData = os.tmpdir(), root = null, install = null } = {}) {
  const log = [];
  // The selected FRIDAY folder is authoritative. Legacy/bootstrap locations are
  // only a migration source: the newest one found is copied in once and never
  // written to again.
  const canonical = root
    ? path.join(root, "database", "friday.sqlite3")
    : process.env.FRIDAY_DB_PATH || databasePath(userData);
  const file = process.env.FRIDAY_DB_PATH && !root ? process.env.FRIDAY_DB_PATH : canonical;
  const dir = path.dirname(file);

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, file, log: [...log, `cannot create ${dir}: ${String(err.message)}`] };
  }

  if (root && !exists(file)) {
    const legacy = databaseCandidates(userData, root).find((c) => c !== file && exists(c));
    if (legacy && isSqliteFile(legacy)) {
      try {
        fs.copyFileSync(legacy, file);
        log.push(`migrated existing database from ${legacy}`);
      } catch (err) {
        log.push(`could not migrate ${legacy}: ${String(err.message)}`);
      }
    }
  }

  const dbModule = locate(path.join("kernel", "db.py"), { root, install });
  if (!dbModule) {
    return {
      ok: false,
      file,
      log: [...log, "kernel/db.py not found — cannot apply the schema without reinstalling FRIDAY"],
    };
  }

  const created = !exists(file);
  const script = [
    "import sys, sqlite3, json",
    `sys.path.insert(0, ${JSON.stringify(path.dirname(dbModule))})`,
    "from db import SCHEMA",
    `conn = sqlite3.connect(${JSON.stringify(file)})`,
    "conn.executescript(SCHEMA)",
    "conn.commit()",
    "integrity = conn.execute('PRAGMA integrity_check').fetchone()[0]",
    "tables = [r[0] for r in conn.execute(\"SELECT name FROM sqlite_master WHERE type='table'\")]",
    "conn.close()",
    "print(json.dumps({'integrity': integrity, 'tables': tables}))",
  ].join("\n");

  const { ok, out, python: picked } = await runPython(script, 60_000, install, root);
  if (!ok) {
    const exe = picked?.exe || "(unknown)";
    const source = picked?.source || "unknown";
    const reason = picked?.reason || "no resolver detail";
    const tried =
      Array.isArray(picked?.tried) && picked.tried.length ? picked.tried.join(", ") : "none";
    return {
      ok: false,
      file,
      python: exe,
      pythonSource: source,
      log: [
        ...log,
        `python could not initialise the database using ${exe} (source=${source}; ${reason}; tried: ${tried}): ${out || "no output"}`,
      ],
    };
  }

  let report = null;
  try {
    report = JSON.parse(out.split(/\r?\n/).filter(Boolean).pop());
  } catch {
    /* fall through — verified below by header check */
  }

  const valid = isSqliteFile(file);
  log.push(created ? `created ${file}` : `verified ${file}`);
  if (report) log.push(`${report.tables.length} table(s) · integrity ${report.integrity}`);
  return {
    ok: valid && (!report || report.integrity === "ok"),
    file,
    created,
    tables: report ? report.tables : [],
    integrity: report ? report.integrity : null,
    log,
  };
}

module.exports = {
  exists,
  readJson,
  resolveProjectRoot,
  projectRootCandidates,
  locate,
  databasePath,
  databaseCandidates,
  isSqliteFile,
  ensureDatabase,
  resolveDatabasePython,
};
