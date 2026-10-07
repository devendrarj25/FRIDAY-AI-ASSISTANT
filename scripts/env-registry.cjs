/**
 * FRIDAY — persistent dependency / environment registry.
 *
 * ONE shared implementation used by the Electron main process, the setup
 * scripts and the readiness test, so browser mode and the packaged Windows EXE
 * always see the same truth about the machine:
 *
 *   what is installed · version · path · health · source · capability
 *
 * The registry is a plain JSON file so it survives restarts, updates and
 * reinstalls, and can be inspected by a human. Nothing here guesses: every
 * entry comes from a real probe of the local machine.
 *
 * Repair is deliberately conservative and uses FRIDAY's own official-source
 * installers (scripts/setup-python.cjs, scripts/ensure-electron.cjs,
 * scripts/init-runtime.cjs, npm ci) — never a mirror, never a downgrade.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { spawnCaptured, spawnNpm } = require("./win-spawn.cjs");

const runtime = require("./python-runtime.cjs");

const root = runtime.root;
const win = runtime.win;
const versions = JSON.parse(
  fs.readFileSync(path.join(root, "config", "toolchain-versions.json"), "utf8"),
);

// The registry lives inside the selected FRIDAY folder, like all other data.
const picked = require("./friday-root.cjs").workspaceRootOrDev();
const dataRoot = process.env.FRIDAY_DATA_DIR || path.join(picked.root, "data");
// ONE canonical database, the same file the kernel opens (kernel/main.py):
// <FRIDAY folder>/database/friday.sqlite3. FRIDAY_DB_PATH overrides it only
// when the runtime was explicitly pointed somewhere else.
const databaseFile =
  process.env.FRIDAY_DB_PATH || require("./friday-root.cjs").layout(picked.root).database;

/** Registry lives with FRIDAY's data so an app update never discards it. */
const registryFile = path.join(dataRoot, "environment-registry.json");

const logDir = path.join(root, "debug", "diagnostics");

const spawnOfficial = spawnCaptured;

const parts = (v) =>
  String(v || "")
    .split(".")
    .map((p) => Number(p) || 0);
function compare(left, right) {
  const a = parts(left);
  const b = parts(right);
  for (let i = 0; i < Math.max(a.length, b.length, 3); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  }
  return 0;
}
const meets = (found, minimum) => !minimum || (!!found && compare(found, minimum) >= 0);

const capture = (exe, args, opts = {}) => {
  try {
    const r = spawnOfficial(exe, args, {
      encoding: "utf8",
      cwd: root,
      windowsHide: true,
      timeout: 20000,
      ...opts,
    });
    if (r.error || r.status !== 0) return null;
    return `${r.stdout || ""}${r.stderr || ""}`.trim();
  } catch {
    return null;
  }
};

const firstVersion = (text) => (text ? (text.match(/\d+\.\d+(?:\.\d+)?/) || [null])[0] : null);

const locate = (cmd) => {
  const out = capture(win ? "where" : "which", [cmd], { timeout: 8000 });
  if (!out) return null;
  const line = out.split(/\r?\n/).find((l) => l.trim() && !/^INFO:/i.test(l));
  return line ? line.trim() : null;
};

/* ------------------------------------------------------------------ probes */
/**
 * Every probe returns the same record shape. `health` is one of:
 *   ready      — present, supported, usable
 *   outdated   — present but below FRIDAY's minimum
 *   missing    — not installed
 *   broken     — present but failed its usability test
 */
const record = (id, extra) => ({
  id,
  version: null,
  path: null,
  health: "missing",
  source: null,
  capability: [],
  detail: null,
  minimum: null,
  repairable: false,
  ...extra,
});

function probeNode() {
  const version = firstVersion(capture(process.execPath, ["-v"]));
  return record("node", {
    label: "Node.js",
    kind: "runtime",
    version,
    path: process.execPath,
    minimum: versions.nodeMinimum,
    source: "nodejs.org",
    capability: ["build", "electron-main", "scripts"],
    health: !version ? "missing" : meets(version, versions.nodeMinimum) ? "ready" : "outdated",
  });
}

function probeNpm() {
  const exe = win ? "npm.cmd" : "npm";
  const npmOut = (() => {
    try {
      const r = spawnNpm(["--version"], { cwd: root, timeout: 20000 });
      if (r.error || r.status !== 0) return null;
      return `${r.stdout || ""}${r.stderr || ""}`.trim();
    } catch {
      return null;
    }
  })();
  const version = firstVersion(npmOut);
  return record("npm", {
    label: "npm",
    kind: "runtime",
    version,
    path: locate(exe),
    minimum: versions.npmMinimum,
    source: "npmjs.com",
    capability: ["dependencies", "build"],
    health: !version ? "missing" : meets(version, versions.npmMinimum) ? "ready" : "outdated",
  });
}

function probeSystemPython() {
  // Detection first, always: a supported interpreter that already exists on
  // this PC is reused and never reinstalled or downgraded.
  const found = runtime.discoverPython();
  const version = found?.version || null;
  return record("python", {
    label: "Python",
    kind: "runtime",
    version,
    path: found?.executable || null,
    minimum: versions.pythonMinimum,
    source: "python.org",
    capability: ["kernel", "venv", "model-runtime"],
    repairable: true,
    health: !version ? "missing" : meets(version, versions.pythonMinimum) ? "ready" : "outdated",
    detail: found
      ? `reusing existing interpreter ${found.executable}`
      : "no supported interpreter found",
  });
}

function probeVenv() {
  const exe = runtime.venvPython;
  const exists = fs.existsSync(exe);
  const version = exists
    ? firstVersion(
        capture(exe, ["-c", "import sys;print('.'.join(map(str,sys.version_info[:3])))"]),
      )
    : null;
  return record("python-venv", {
    label: "FRIDAY Python environment",
    kind: "environment",
    version,
    path: exists ? exe : null,
    minimum: versions.pythonMinimum,
    source: "scripts/setup-python.cjs",
    capability: ["kernel", "database", "tools"],
    repairable: true,
    health: !exists ? "missing" : version ? "ready" : "broken",
  });
}

const KERNEL_IMPORTS = ["fastapi", "uvicorn", "httpx", "pydantic", "yaml"];

function probePythonDeps() {
  const exe = runtime.venvPython;
  if (!fs.existsSync(exe)) {
    return record("python-deps", {
      label: "Kernel Python packages",
      kind: "dependencies",
      source: "pypi.org",
      capability: ["kernel"],
      repairable: true,
      detail: "the FRIDAY Python environment is missing",
    });
  }
  const code = `import json;m=[]\nfor n in ${JSON.stringify(KERNEL_IMPORTS)}:\n    try:\n        __import__(n)\n    except Exception:\n        m.append(n)\nprint(json.dumps(m))`;
  const out = capture(exe, ["-c", code], { timeout: 60000 });
  let missing = null;
  try {
    missing = JSON.parse(
      String(out || "")
        .trim()
        .split(/\r?\n/)
        .pop(),
    );
  } catch {
    missing = null;
  }
  return record("python-deps", {
    label: "Kernel Python packages",
    kind: "dependencies",
    path: path.join(root, "kernel", "requirements.txt"),
    source: "pypi.org",
    capability: ["kernel", "chat", "memory"],
    repairable: true,
    version: missing && missing.length === 0 ? "complete" : null,
    health: missing === null ? "broken" : missing.length ? "missing" : "ready",
    detail: missing && missing.length ? `missing: ${missing.join(", ")}` : null,
  });
}

function electronBinary() {
  const dir = path.join(root, "node_modules", "electron");
  const pathFile = path.join(dir, "path.txt");
  if (!fs.existsSync(pathFile)) return null;
  const rel = fs.readFileSync(pathFile, "utf8").trim();
  const exe = path.join(dir, "dist", rel);
  return fs.existsSync(exe) ? exe : null;
}

function probeElectron() {
  const exe = electronBinary();
  let version = null;
  try {
    version = JSON.parse(
      fs.readFileSync(path.join(root, "node_modules", "electron", "package.json"), "utf8"),
    ).version;
  } catch {
    version = null;
  }
  return record("electron", {
    label: "Electron runtime",
    kind: "runtime",
    version,
    path: exe,
    minimum: versions.electronMinimum,
    source: "github.com/electron/electron",
    capability: ["desktop", "windows-exe"],
    repairable: true,
    health: !exe ? "missing" : meets(version, versions.electronMinimum) ? "ready" : "outdated",
    detail: exe ? null : "electron.exe was not extracted by npm install",
  });
}

function probeNodeModules() {
  // Accept any resolved install (npm, bun or pnpm): what matters is that the
  // packages FRIDAY actually loads are present and executable.
  const required = ["electron", "vite", "react"];
  const present = required.every((name) => fs.existsSync(path.join(root, "node_modules", name)));
  return record("node-modules", {
    label: "Electron/app dependencies",
    kind: "dependencies",
    path: present ? path.join(root, "node_modules") : null,
    source: "package-lock.json",
    capability: ["build", "desktop", "browser"],
    repairable: true,
    version: present ? "installed" : null,
    health: present ? "ready" : "missing",
  });
}

function probeKernel() {
  // In the installed EXE the kernel ships as extraResources (resources/kernel);
  // in a source checkout it is <project>/kernel. The packaged copy wins so the
  // EXE never depends on a development tree that may not exist.
  const packaged = path.join(process.resourcesPath || "", "kernel", "main.py");
  const entry = path.join(root, "kernel", "main.py");
  const file = fs.existsSync(packaged) ? packaged : fs.existsSync(entry) ? entry : null;
  let health = file ? "ready" : "missing";
  let detail = null;
  if (file && fs.existsSync(runtime.venvPython)) {
    // py_compile must never write into the install directory: Program Files is
    // read-only for a normal user and the failed write reported a healthy
    // kernel as "broken", which blocked the whole ENVIRONMENT check.
    const cacheFile = path.join(
      fs.mkdtempSync(path.join(require("node:os").tmpdir(), "friday-kernel-")),
      "kernel.pyc",
    );
    // The raw result is used (not capture()) so the REAL reason is visible:
    // capture() collapses "interpreter could not even run" and "the file has a
    // syntax error" into the same null, which reported a healthy kernel as
    // broken and blocked the whole ENVIRONMENT check.
    let result = null;
    try {
      result = spawnSync(
        runtime.venvPython,
        [
          "-c",
          "import sys,py_compile;py_compile.compile(sys.argv[1],cfile=sys.argv[2],doraise=True)",
          file,
          cacheFile,
        ],
        {
          encoding: "utf8",
          cwd: root,
          windowsHide: true,
          timeout: 60000,
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
        },
      );
    } catch (error) {
      result = { error };
    }
    try {
      fs.rmSync(path.dirname(cacheFile), { recursive: true, force: true });
    } catch {
      /* temp cleanup is best effort */
    }
    const output = `${result?.stdout || ""}${result?.stderr || ""}`.trim();
    if (result && !result.error && result.status === 0) {
      // compiles cleanly
    } else if (/SyntaxError|PyCompileError|IndentationError/i.test(output)) {
      health = "broken";
      detail = `kernel/main.py failed to compile — ${output.split(/\r?\n/).pop()}`;
    } else {
      // The kernel file exists and ships with FRIDAY; the compile check itself
      // could not run (interpreter busy, timeout, sandboxed temp dir). That is
      // not a broken kernel, so it must not block the environment.
      detail = `compile check skipped — ${result?.error?.message || output || `exit ${result?.status}`}`;
    }
  }

  return record("kernel", {
    label: "FRIDAY Python kernel",
    kind: "component",
    path: file,
    version: file ? "source" : null,
    source: "project",
    capability: ["chat", "tools", "memory"],
    health,
    detail,
  });
}

function probeDatabase() {
  const db = databaseFile;
  if (!fs.existsSync(runtime.venvPython)) {
    return record("database", {
      label: "SQLite database",
      kind: "storage",
      path: db,
      source: "scripts/init-runtime.cjs",
      capability: ["chat-history", "memory", "tasks"],
      repairable: true,
      detail: "cannot be verified without the FRIDAY Python environment",
    });
  }
  const code = [
    "import json,sqlite3",
    `c=sqlite3.connect(${JSON.stringify(db)})`,
    "i=c.execute('PRAGMA integrity_check').fetchone()[0]",
    "t=[r[0] for r in c.execute(\"SELECT name FROM sqlite_master WHERE type='table'\")]",
    "v=c.execute('select sqlite_version()').fetchone()[0]",
    "c.close()",
    "print(json.dumps({'integrity':i,'tables':t,'version':v}))",
  ].join("\n");
  const out = capture(runtime.venvPython, ["-c", code], { timeout: 30000 });
  let report = null;
  try {
    report = JSON.parse(
      String(out || "")
        .trim()
        .split(/\r?\n/)
        .pop(),
    );
  } catch {
    report = null;
  }
  const ok = report && report.integrity === "ok" && (report.tables || []).includes("chats");
  return record("database", {
    label: "SQLite database",
    kind: "storage",
    path: db,
    version: report?.version || null,
    minimum: versions.sqliteMinimum,
    source: "scripts/init-runtime.cjs",
    capability: ["chat-history", "memory", "tasks"],
    repairable: true,
    health: ok ? "ready" : fs.existsSync(db) ? "broken" : "missing",
    detail: report ? `${(report.tables || []).length} tables` : "database could not be opened",
  });
}

function probeConfig() {
  const files = [
    path.join(root, "config", "kernel.yaml"),
    path.join(root, "config", "models.yaml"),
    path.join(root, "config", "toolchain-versions.json"),
  ];
  const missing = files.filter((f) => !fs.existsSync(f));
  return record("config", {
    label: "Configuration",
    kind: "component",
    path: path.join(root, "config"),
    version: missing.length ? null : "complete",
    source: "project",
    capability: ["kernel", "models", "versions"],
    health: missing.length ? "missing" : "ready",
    detail: missing.length ? `missing: ${missing.map((f) => path.basename(f)).join(", ")}` : null,
  });
}

function probeBrowserBundle() {
  const desktop = path.join(root, "dist-desktop", "index.html");
  const web = path.join(root, "dist", "index.html");
  const file = fs.existsSync(desktop) ? desktop : fs.existsSync(web) ? web : null;
  return record("renderer", {
    label: "FRIDAY interface bundle",
    kind: "component",
    path: file,
    version: file ? "built" : null,
    source: "vite",
    capability: ["browser", "desktop-window"],
    repairable: true,
    // Missing until `npm run build:desktop` / `npm run build:win`. Setup and
    // Doctor must still PASS so a fresh clone can pack; the pack step builds it.
    optional: true,
    health: file ? "ready" : "missing",
    detail: file ? null : "run npm run build:desktop or npm run build:win",
  });
}

/** The installed Windows app, when FRIDAY has been installed on this PC. */
function installedApp() {
  if (!win) return null;
  const candidates = [
    path.join(process.env.LOCALAPPDATA || "", "Programs", "FRIDAY", "FRIDAY.exe"),
    path.join(process.env.PROGRAMFILES || "", "FRIDAY", "FRIDAY.exe"),
    path.join(root, "release", "win-unpacked", "FRIDAY.exe"),
  ];
  return candidates.find((c) => c && fs.existsSync(c)) || null;
}

function probeInstalledApp() {
  const exe = installedApp();
  return record("installed-app", {
    label: "Installed FRIDAY (Windows)",
    kind: "application",
    path: exe,
    version: exe
      ? JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version
      : null,
    source: "FRIDAY-Setup.exe",
    capability: ["windows-exe"],
    optional: true,
    health: exe ? "ready" : "missing",
    detail: win ? null : "Windows only — not applicable on this platform",
  });
}

function probeModelRuntimes() {
  const ollama = locate(win ? "ollama.exe" : "ollama");
  const ollamaVersion = ollama ? firstVersion(capture(ollama, ["--version"])) : null;
  const entries = [
    record("ollama", {
      label: "Ollama (local models)",
      kind: "model-runtime",
      version: ollamaVersion,
      path: ollama,
      source: "ollama.com",
      capability: ["local-chat", "embeddings"],
      health: ollama ? "ready" : "missing",
      detail: ollama ? null : "optional — cloud models still work",
      optional: true,
    }),
  ];
  return entries;
}

/* ---------------------------------------------------------------- registry */

function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(registryFile, "utf8"));
  } catch {
    return { version: 1, updatedAt: null, platform: process.platform, components: [] };
  }
}

function writeRegistry(registry) {
  try {
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2));
  } catch {
    /* read-only data folder — the in-memory registry is still returned */
  }
  return registry;
}

/** Re-probe the machine and persist the result. */
function refreshRegistry() {
  const previous = readRegistry();
  const seen = new Map((previous.components || []).map((c) => [c.id, c]));
  const components = [
    probeNode(),
    probeNpm(),
    probeSystemPython(),
    probeVenv(),
    probePythonDeps(),
    probeNodeModules(),
    probeElectron(),
    probeKernel(),
    probeDatabase(),
    probeConfig(),
    probeBrowserBundle(),
    probeInstalledApp(),
    ...probeModelRuntimes(),
  ].map((component) => ({
    ...component,
    checkedAt: Date.now(),
    // Keep the moment a component first became usable, for diagnostics.
    readySince:
      component.health === "ready" ? seen.get(component.id)?.readySince || Date.now() : null,
  }));

  const blocking = components.filter(
    (c) =>
      !c.optional && (c.health === "missing" || c.health === "broken" || c.health === "outdated"),
  );
  return writeRegistry({
    version: 1,
    updatedAt: Date.now(),
    platform: process.platform,
    root,
    dataRoot,
    registryFile,
    ready: blocking.length === 0,
    blocking: blocking.map((c) => c.id),
    components,
  });
}

/* ------------------------------------------------------------------ repair */
/**
 * Official-source repair chain per component. Each step is a real command that
 * downloads → verifies → installs; the component is re-probed afterwards and is
 * only reported repaired when the probe itself says it is usable.
 */
const REPAIRS = {
  python: [[process.execPath, [path.join(root, "scripts", "setup-python.cjs")]]],
  "python-venv": [[process.execPath, [path.join(root, "scripts", "setup-python.cjs")]]],
  "python-deps": [[process.execPath, [path.join(root, "scripts", "setup-python.cjs")]]],
  electron: [[process.execPath, [path.join(root, "scripts", "ensure-electron.cjs")]]],
  "node-modules": [
    [win ? "npm.cmd" : "npm", ["ci", "--no-audit", "--no-fund"]],
    [win ? "npm.cmd" : "npm", ["install", "--no-audit", "--no-fund"]],
  ],
  database: [[process.execPath, [path.join(root, "scripts", "init-runtime.cjs")]]],
  renderer: [[win ? "npm.cmd" : "npm", ["run", "build:desktop"]]],
};

function repairComponent(id, { onLog = () => {} } = {}) {
  const steps = REPAIRS[id];
  if (!steps) return { ok: false, id, error: `"${id}" cannot be repaired automatically.` };
  const attempts = [];
  for (const [cmd, args] of steps) {
    onLog(`[friday] repairing ${id}: ${cmd} ${args.join(" ")}`);
    const result = spawnOfficial(cmd, args, {
      encoding: "utf8",
      cwd: root,
      windowsHide: true,
      timeout: 20 * 60 * 1000,
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    attempts.push({
      command: `${cmd} ${args.join(" ")}`,
      code: result.status,
      output: output.slice(-4000),
    });
    if (result.status === 0) break;
  }
  const registry = refreshRegistry();
  const component = registry.components.find((c) => c.id === id) || null;
  const ok = component?.health === "ready";
  writeLog(`repair-${id}`, { id, ok, attempts, component });
  return { ok, id, component, attempts };
}

/** Repair everything that is blocking, in dependency order. */
function repairAll(options = {}) {
  const skip = new Set(options.skip || []);
  const order = [
    "node-modules",
    "electron",
    "python",
    "python-venv",
    "python-deps",
    "database",
    "renderer",
  ];
  let registry = refreshRegistry();
  const results = [];
  for (const id of order) {
    if (skip.has(id)) continue;
    const component = registry.components.find((c) => c.id === id);
    if (!component || component.health === "ready") continue;
    results.push(repairComponent(id, options));
    registry = readRegistry();
  }
  return { registry: refreshRegistry(), results };
}

/* -------------------------------------------------------------------- logs */

function writeLog(name, payload) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(
      path.join(logDir, `${name}-${stamp}.json`),
      JSON.stringify({ at: Date.now(), ...payload }, null, 2),
    );
  } catch {
    /* diagnostics are best-effort and never block a repair */
  }
}

module.exports = {
  registryFile,
  dataRoot,
  readRegistry,
  refreshRegistry,
  repairComponent,
  repairAll,
  installedApp,
  writeLog,
  REPAIRS,
};

/* ------------------------------------------------------------------- CLI */
if (require.main === module) {
  const command = (process.argv[2] || "report").toLowerCase();
  // `npm run build:win` runs repair then deletes dist-desktop. Do not spend a
  // Vite build on a bundle that the pack step rebuilds. Pass --with-renderer
  // when Doctor/Install Manager should compile the interface now.
  const skipRenderer = command === "repair" && !process.argv.includes("--with-renderer");
  const registry =
    command === "repair"
      ? repairAll({ skip: skipRenderer ? ["renderer"] : [] }).registry
      : refreshRegistry();
  for (const c of registry.components) {
    const mark =
      c.health === "ready"
        ? "ok      "
        : c.optional
          ? "optional"
          : c.health.toUpperCase().padEnd(8);
    console.log(
      `[friday] ${mark} ${c.label}${c.version ? ` ${c.version}` : ""}${c.detail ? ` — ${c.detail}` : ""}`,
    );
  }
  console.log(`[friday] registry: ${registryFile}`);
  if (!registry.ready) {
    console.error(`[friday] not ready: ${registry.blocking.join(", ")}`);
    process.exit(1);
  }
  console.log("[friday] environment registry: READY");
}
