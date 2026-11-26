/**
 * FRIDAY — environment check for a fresh Windows PC.
 *
 * Detects every runtime FRIDAY needs to build and run, prints the exact official
 * installation command for anything missing, and exits non-zero when a REQUIRED
 * component is absent.
 *
 * Required means "the setup downloads it": on a Windows PC where the tool step
 * runs (not hosted CI, not offline, not switched off), FFmpeg, Tesseract OCR,
 * the Visual C++ runtime, Ollama and every agent tool that applies to this PC
 * are required. What cannot apply to this PC (CUDA without an NVIDIA driver,
 * Windows Sandbox on an edition without it) is shown as not applicable, not as a
 * warning.
 *
 *   node scripts/check-environment.cjs          report
 *   node scripts/check-environment.cjs --fix    repair what FRIDAY can install, check again
 *   node scripts/check-environment.cjs --strict report + fail on warnings
 *
 * Without --fix nothing is installed or modified; `npm run doctor` runs it with
 * --fix and `npm run setup` installs the whole list.
 */
const { spawnSync } = require("node:child_process");
// Colour that means something (ok green, FAIL red, a note yellow) on a real console; plain text everywhere else.
if (require.main === module) require("./live-console.cjs").installColorConsole();
const fs = require("node:fs");
const path = require("node:path");
const { spawnCaptured, spawnNpm } = require("./win-spawn.cjs");
const probes = require("./doctor-probes.cjs");
// Tools that setup or Doctor just installed or upgraded are on the registry PATH, not on
// the PATH this console started with: read it first so they are not reported missing.
require("./win-path.cjs").refreshWindowsPath();

const root = path.resolve(__dirname, "..");
const win = process.platform === "win32";
const strict = process.argv.includes("--strict");
const versions = JSON.parse(
  fs.readFileSync(path.join(root, "config", "toolchain-versions.json"), "utf8"),
);

const capture = (exe, args, timeout = 15000) => {
  try {
    const r = spawnCaptured(exe, args, {
      encoding: "utf8",
      cwd: root,
      windowsHide: true,
      timeout,
    });
    if (r.status !== 0) return null;
    // wsl.exe prints UTF-16; read as UTF-8 every letter is followed by a NUL.
    return `${r.stdout || ""}${r.stderr || ""}`.replace(/\u0000/g, "").trim();
  } catch {
    return null;
  }
};

// A tool whose newer copy was installed beside an older one (CMake, Pandoc) is found at the copy setup chose to
// use first (runtime/managed-path.json `first`), so this check names the version FRIDAY really runs.
if (win) {
  try {
    const managedPath = require("../electron/managed-path.cjs");
    const first = managedPath.readFirst(require("./friday-root.cjs").workspaceRootOrDev().root);
    if (first.length) process.env.PATH = managedPath.withFirstPath(process.env.PATH, first);
  } catch {
    /* without a recorded choice the PATH order stands */
  }
}

/** PATH first, then well-known install folders (winget often skips user PATH). */
function captureCommand(names, args, extraDirs = []) {
  for (const name of names) {
    const hit = capture(name, args);
    if (hit) return hit;
  }
  if (!win) return null;
  for (const dir of extraDirs) {
    if (!dir) continue;
    for (const name of names) {
      const exe = path.join(dir, name);
      if (!fs.existsSync(exe)) continue;
      const hit = capture(exe, args);
      if (hit) return hit;
    }
  }
  return null;
}

/** The download hosts of a setup job by id (the Ollama installer, for one), from the real plan with every switch on. */
function jobHostsOf(id) {
  try {
    // A read-only look: it must never record the checkout as the FRIDAY home in the registry.
    const jobs = require("./prefetch-models.cjs").prefetchPlan(
      require("./friday-root.cjs").workspaceRootOrDev({ record: false }).root,
      {
        ...process.env,
        CI: "",
        GITHUB_ACTIONS: "",
        FRIDAY_PREFETCH: "1",
        FRIDAY_PREFETCH_OLLAMA: "1",
      },
      "win32",
      {},
    );
    return probes.jobHosts(jobs.find((job) => job.id === id));
  } catch {
    return [];
  }
}

/** The hosts a tool of electron/toolchain.cjs is fetched from (winget's index, then the vendor installer). */
function toolHostsOf(id) {
  try {
    return probes.toolHosts(require("../electron/toolchain.cjs").toolById(id));
  } catch {
    return [];
  }
}

const firstVersion = (text) =>
  text ? (text.match(/\d+\.\d+(\.\d+)?/) || [text.split(/\r?\n/)[0]])[0] : null;
const parts = (v) =>
  String(v || "")
    .split(".")
    .map((part) => Number(part) || 0);
const compare = (left, right) => {
  const a = parts(left);
  const b = parts(right);
  for (let i = 0; i < Math.max(a.length, b.length, 3); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  }
  return 0;
};
const supported = (found, minimum) => !!found && compare(found, minimum) >= 0;
const minimumLabel = (minimum) => `>=${minimum}`;

/** Supported version set — keep in sync with INSTALL.md and package.json engines. */
const SUPPORTED = {
  node: minimumLabel(versions.nodeMinimum),
  npm: minimumLabel(versions.npmMinimum),
  python: minimumLabel(versions.pythonMinimum),
  git: minimumLabel(versions.gitMinimum),
  powershell: minimumLabel(versions.powershellMinimum),
};

/**
 * The setup downloads these on a Windows PC, so a missing one is a failure, not a
 * warning. Hosted CI, an offline build and FRIDAY_PREFETCH*=0 keep them optional
 * because the step that installs them does not run there either.
 */
const toolsRequired =
  win && require("./prefetch-toolkit.cjs").skipReason(process.env, process.platform) === "";
const elevatedRequired =
  toolsRequired && String(process.env.FRIDAY_PREFETCH_TOOLKIT_ELEVATED ?? "1").trim() !== "0";
/**
 * Why a tool row is not required on this run. A row that is not required is never
 * called "optional": it names the step that does not run here, so the report
 * never reads as a tool FRIDAY can do without.
 */
const notRequiredBecause = (elevated = false) => {
  const reason = require("./prefetch-toolkit.cjs").skipReason(process.env, process.platform);
  if (reason) return `not installed on this run (${reason}); npm run setup installs it on your PC`;
  if (elevated)
    return "not installed on this run (FRIDAY_PREFETCH_TOOLKIT_ELEVATED=0 skips administrator tools)";
  return "this run does not install it (hosted CI, FRIDAY_OFFLINE=1 or FRIDAY_PREFETCH_STRICT=0); npm run setup installs it on your PC";
};
/**
 * Capability packages (requirements-capabilities.txt) are required on a Windows PC that builds
 * FRIDAY, exactly where npm run setup:python stops when one is missing. Hosted CI, an offline
 * build and FRIDAY_PREFETCH_STRICT=0 keep them reported only. chromadb stays reported only
 * everywhere: FRIDAY falls back to SQLite memory without it.
 */
const capabilitiesRequired =
  win &&
  !process.env.CI &&
  !process.env.GITHUB_ACTIONS &&
  process.env.FRIDAY_OFFLINE !== "1" &&
  String(process.env.FRIDAY_PREFETCH_STRICT ?? "1").trim() !== "0";
/** Windows Sandbox needs Pro, Enterprise or Education; Home can never install it. */
const windowsEdition = () =>
  win
    ? capture("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-CimInstance Win32_OperatingSystem).Caption",
      ]) || ""
    : "";

const checks = [];
const add = (c) => checks.push(c);
/** Absolute path of the interpreter FRIDAY would use, filled in below. */
let pythonExecutable = null;

// ---------------------------------------------------------------- required
{
  const v = process.versions.node;
  add({
    name: "Node.js",
    required: true,
    ok: supported(v, versions.nodeMinimum),
    found: `v${v}`,
    want: SUPPORTED.node,
    fix: "npm run setup",
    url: "https://nodejs.org/en/download",
  });
}
{
  const npmOut = (() => {
    try {
      const r = spawnNpm(["--version"], { cwd: root, timeout: 15000 });
      if (r.status !== 0) return null;
      return `${r.stdout || ""}${r.stderr || ""}`.trim();
    } catch {
      return null;
    }
  })();
  const v = firstVersion(npmOut);
  add({
    name: "npm",
    required: true,
    ok: supported(v, versions.npmMinimum),
    found: v ? `v${v}` : "not found",
    want: SUPPORTED.npm,
    fix: "npm run setup",
    url: "https://docs.npmjs.com/downloading-and-installing-node-js-and-npm",
  });
}
if (win) {
  // The build and Doctor start node scripts directly, so a console whose cmd.exe cannot find node or npm no longer
  // stops them; it still breaks `npm run <script>` and tools that start a command by name, which is what ended a
  // build with "'node' is not recognized" on one PC. This asks cmd.exe itself, with the PATH this console has.
  const pathText = String(process.env.Path || process.env.PATH || "");
  const found = spawnSync(
    process.env.ComSpec || "cmd.exe",
    ["/d", "/s", "/c", "where node && where npm"],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
    },
  );
  const reachable = found.status === 0;
  add({
    name: "Shell PATH (cmd.exe)",
    required: false,
    skip: "a console that cannot find node or npm by name does not stop the build; open a new terminal if a script says 'node' is not recognized",
    group: "shell-path",
    ok: reachable,
    found: reachable
      ? `node and npm found (PATH ${pathText.length} chars)`
      : `cmd.exe cannot find node or npm (PATH ${pathText.length} chars)`,
    want: "cmd.exe finds node and npm by name",
    fix: "open a new terminal (a console started before the install has the old PATH), then run npm run doctor",
    url: "https://docs.npmjs.com/cli/commands/npm-run-script",
  });
}
{
  // A real interpreter prints its own path; the Windows Store stub does not.
  const probe = (exe, prefix = []) => {
    const out = capture(exe, [
      ...prefix,
      "-c",
      "import sys;print(sys.executable);print('.'.join(map(str,sys.version_info[:3])))",
    ]);
    if (!out) return null;
    const [executable, version] = out.split(/\r?\n/);
    if (!executable || !fs.existsSync(executable)) return null;
    return { executable, version };
  };
  const runtime = require("./python-runtime.cjs");
  const venvPython = runtime.resolveVenvPython();
  const venvDir = path.dirname(path.dirname(venvPython));
  const candidates = [[venvPython, []]];

  let found = null;
  for (const [exe, prefix] of candidates) {
    if (path.isAbsolute(exe) && !fs.existsSync(exe)) continue;
    found = probe(exe, prefix);
    if (found) break;
  }
  const okVersion = found && supported(found.version, versions.pythonMinimum);

  // The isolated FRIDAY environment itself: folder + interpreter binary must exist.
  const venvFile =
    fs.existsSync(venvPython) &&
    (() => {
      try {
        return fs.statSync(venvPython).size > 0;
      } catch {
        return false;
      }
    })();
  add({
    name: "Python .venv (FRIDAY runtime)",
    required: true,
    group: "python-runtime",
    ok: !!venvFile,
    found: venvFile
      ? venvPython
      : fs.existsSync(venvDir)
        ? "present but interpreter binary missing/empty"
        : "not created",
    want: `isolated environment at ${venvDir} with a working interpreter`,
    fix: "npm run setup:python",
    url: "https://docs.python.org/3/library/venv.html",
  });

  add({
    name: "Python",
    required: true,
    group: "python-runtime",
    ok: !!okVersion,
    found: found ? `${found.version} (${found.executable})` : "not found",
    want: `${SUPPORTED.python} in ${venvDir}`,
    fix: "npm run setup",
    url: "https://www.python.org/downloads/windows/",
  });

  // pip must actually run inside the isolated environment, not merely exist.
  const pipVersion = found
    ? firstVersion(capture(found.executable, ["-m", "pip", "--version"]))
    : null;
  add({
    name: "pip (in .venv)",
    required: true,
    group: "python-runtime",
    ok: !!pipVersion,
    found: pipVersion
      ? `v${pipVersion}`
      : found
        ? "not runnable in the FRIDAY environment"
        : "no Python interpreter",
    want: "pip runnable via python -m pip inside .venv",
    fix: "npm run setup:python",
    url: "https://pip.pypa.io/",
  });

  // ---- Python kernel packages, checked ONE BY ONE against the supported set.
  // A single "packages missing" line is never actionable, so every requirement
  // in kernel/requirements.txt becomes its own check with found/required
  // version. Requirements are compatibility FLOORS (>=): a newer compatible
  // release passes and is never downgraded.
  const reqFile = path.join(root, "kernel", "requirements.txt");
  const pins = fs.existsSync(reqFile)
    ? fs
        .readFileSync(reqFile, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => {
          const m = l.match(/^([A-Za-z0-9._-]+)(\[[^\]]+\])?(>=|==)([^\s;]+)/);
          return m
            ? { name: m[1], extras: m[2] || "", operator: m[3], version: m[4], spec: l }
            : null;
        })
        .filter(Boolean)
    : [];

  // Distribution name -> module name, where they differ.
  const MODULE = {
    PyYAML: "yaml",
    "uvicorn[standard]": "uvicorn",
    Pillow: "PIL",
    PyAutoGUI: "pyautogui",
    pywin32: "win32gui",
    pymupdf: "pymupdf",
  };
  const voiceNames = new Set(runtime.VOICE_PACKAGES);

  const capFile = path.join(root, "kernel", "requirements-capabilities.txt");
  const capPins = fs.existsSync(capFile)
    ? fs
        .readFileSync(capFile, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => {
          const m = l.match(/^([A-Za-z0-9._-]+)(\[[^\]]+\])?(>=|==)([^\s;]+)/);
          return m
            ? { name: m[1], extras: m[2] || "", operator: m[3], version: m[4], spec: l }
            : null;
        })
        .filter(Boolean)
        .filter((pin) => win || !/sys_platform\s*==\s*"win32"/.test(pin.spec))
    : [];
  // Every package of requirements-capabilities.txt is a capability package; the file is the one list.
  const capabilityNames = new Set(capPins.map((pin) => pin.name));
  const allPins = [...pins, ...capPins.filter((pin) => !pins.some((p) => p.name === pin.name))];

  let installed = {};
  if (found) {
    const script =
      "import json,sys\n" +
      "try:\n from importlib.metadata import version, PackageNotFoundError\n" +
      "except Exception:\n from importlib_metadata import version, PackageNotFoundError\n" +
      "names=json.loads(sys.argv[1])\n" +
      "out={}\n" +
      "for n in names:\n" +
      " try: out[n]=version(n)\n" +
      " except Exception: out[n]=None\n" +
      "print(json.dumps(out))";
    const raw = capture(found.executable, [
      "-c",
      script,
      JSON.stringify(allPins.map((p) => p.name)),
    ]);
    try {
      installed = JSON.parse((raw || "{}").split(/\r?\n/).pop());
    } catch {
      installed = {};
    }
  }

  for (const pin of allPins) {
    const have = installed[pin.name] || null;
    const voice = voiceNames.has(pin.name);
    const capability = capabilityNames.has(pin.name);
    const importName = MODULE[pin.name] || pin.name.toLowerCase().replace(/-/g, "_");
    const importTimeout = voice || capability ? 120000 : 15000;
    const importable =
      have && found
        ? capture(found.executable, ["-c", `import ${importName}`], importTimeout) !== null ||
          (pin.name === "pymupdf" &&
            capture(found.executable, ["-c", "import fitz"], importTimeout) !== null)
        : false;
    const versionOk = pin.operator === "==" ? have === pin.version : supported(have, pin.version);
    const ok = !!have && versionOk && importable;
    add({
      name: `Python package: ${pin.name}`,
      required: capability ? capabilitiesRequired && pin.name !== "chromadb" : !voice || win,
      skip: capability
        ? pin.name === "chromadb"
          ? "FRIDAY falls back to SQLite memory when chromadb is missing"
          : "capability packages are required on a Windows PC build (not on hosted CI, offline or FRIDAY_PREFETCH_STRICT=0); npm run setup:python installs them"
        : "",
      group: "python-packages",
      hosts: probes.PYPI_HOSTS,
      ok,
      found: !found
        ? "no Python interpreter"
        : !have
          ? "not installed"
          : !versionOk
            ? `${have} (minimum supported is ${pin.version})`
            : importable
              ? have
              : `${have} installed but not importable`,
      want: `${pin.name}${pin.operator}${pin.version}${pin.operator === ">=" ? " (newer compatible releases pass)" : ""}`,
      fix: "npm run setup:python",
      url: `https://pypi.org/project/${pin.name}/`,
    });
  }

  // All core kernel imports must load together in one interpreter session:
  // individually importable packages can still clash at runtime.
  const coreImports = found
    ? capture(found.executable, [
        "-c",
        "import fastapi, uvicorn, httpx, pydantic, yaml, sqlite3; print('ok')",
      ])
    : null;
  add({
    name: "Python core imports",
    required: true,
    group: "python-packages",
    ok: !!coreImports,
    found: coreImports
      ? "fastapi, uvicorn, httpx, pydantic, yaml, sqlite3 all import"
      : found
        ? "one or more core imports fail"
        : "no Python interpreter",
    want: "every FRIDAY kernel import loads in a single interpreter session",
    fix: "npm run setup:python",
    url: "https://pypi.org/",
  });

  // SQLite ships inside CPython; a build without it breaks FRIDAY's database.
  // Verified by an actual write/read round-trip, not just an import.
  const sqlite = found
    ? capture(found.executable, ["-c", "import sqlite3;print(sqlite3.sqlite_version)"])
    : null;
  const sqliteWorks = found
    ? capture(found.executable, [
        "-c",
        "import sqlite3;c=sqlite3.connect(':memory:');c.execute('create table t(a)');c.execute('insert into t values(1)');print(c.execute('select a from t').fetchone()[0]);c.close()",
      ])
    : null;
  add({
    name: "SQLite (python sqlite3 module)",
    required: true,
    group: "python-runtime",
    ok:
      supported(firstVersion(sqlite), versions.sqliteMinimum) &&
      (sqliteWorks || "").trim().endsWith("1"),
    found: !sqlite
      ? "not available in this Python build"
      : sqliteWorks
        ? `sqlite ${firstVersion(sqlite)} (read/write verified)`
        : `sqlite ${firstVersion(sqlite)} (module present but a query failed)`,
    want: `SQLite ${minimumLabel(versions.sqliteMinimum)}, bundled with supported Python`,
    fix: "npm run setup",
    url: "https://www.python.org/downloads/windows/",
  });

  pythonExecutable = found ? found.executable : null;
}

// ---------------------------------------------------------------- recommended
{
  const v = firstVersion(capture("git", ["--version"]));
  add({
    name: "Git",
    required: true,
    group: "toolchain",
    ok: supported(v, versions.gitMinimum),
    found: v ? `v${v}` : "not found",
    want: SUPPORTED.git,
    fix: "npm run setup",
    url: "https://git-scm.com/download/win",
  });
}
if (win) {
  const v = firstVersion(
    capture("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]),
  );
  add({
    name: "PowerShell",
    required: true,
    group: "toolchain",
    ok: supported(v, versions.powershellMinimum),
    found: v ? `v${v}` : "not found",
    want: SUPPORTED.powershell,
    fix: "npm run setup",
    url: "https://learn.microsoft.com/powershell/",
  });
  {
    const longPaths = require("./long-paths.cjs");
    const assessed = longPaths.assess({
      state: longPaths.readLongPathsEnabled(),
      root: require("./friday-root.cjs").workspaceRootOrDev({ record: false }).root,
    });
    const placed = require("./folder-advice.cjs").assess(
      require("./friday-root.cjs").workspaceRootOrDev({ record: false }).root,
    );
    add({
      name: "FRIDAY folder location",
      required: false,
      group: "toolchain",
      ok: placed.ok,
      found: placed.note,
      want: "a plain local folder: not synced by OneDrive, Dropbox or Google Drive, and not under Program Files",
      fix: placed.fix,
      url: "https://learn.microsoft.com/windows/win32/fileio/maximum-file-path-limitation",
    });
    add({
      name: "Windows long paths",
      required: false,
      group: "toolchain",
      ok: assessed.ok,
      found: assessed.note,
      want: "a FRIDAY folder shallow enough, or long paths enabled, so deep package paths can unpack",
      fix: assessed.fix,
      url: "https://learn.microsoft.com/windows/win32/fileio/maximum-file-path-limitation",
    });
  }
  const wg = firstVersion(capture("winget", ["--version"]));
  add({
    name: "winget (App Installer)",
    required: true,
    ok: !!wg,
    found: wg ? `v${wg}` : "not found",
    want: "used by FRIDAY's Install Manager for official-source installs",
    fix: "Install Microsoft's App Installer from https://aka.ms/getwinget",
    url: "https://learn.microsoft.com/windows/package-manager/",
  });
}

// ---------------------------------------------------------------- optional
{
  const electronDir = path.join(root, "node_modules", "electron");
  const electronBinary = path.join(
    electronDir,
    "dist",
    win
      ? "electron.exe"
      : process.platform === "darwin"
        ? "Electron.app/Contents/MacOS/Electron"
        : "electron",
  );
  let electronSize = 0;
  try {
    const stat = fs.statSync(electronBinary);
    if (stat.isFile()) electronSize = stat.size;
  } catch {
    electronSize = 0;
  }
  let electronVersion = null;
  try {
    electronVersion = JSON.parse(
      fs.readFileSync(path.join(electronDir, "package.json"), "utf8"),
    ).version;
  } catch {
    electronVersion = null;
  }

  // 1) npm package present with its own runtime dependencies resolvable.
  const electronDeps = (() => {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(electronDir, "package.json"), "utf8"));
      const names = Object.keys(meta.dependencies || {});
      const miss = names.filter((n) => {
        try {
          require.resolve(`${n}/package.json`, { paths: [electronDir, root] });
          return false;
        } catch {
          return !fs.existsSync(path.join(root, "node_modules", n));
        }
      });
      return { names, miss };
    } catch {
      return null;
    }
  })();
  add({
    name: "Electron package + dependencies",
    required: true,
    group: "electron-binary",
    ok: !!electronDeps && electronDeps.miss.length === 0,
    found: !electronDeps
      ? "electron npm package not installed"
      : electronDeps.miss.length
        ? `missing dependencies: ${electronDeps.miss.join(", ")}`
        : `installed with ${electronDeps.names.length} dependency(ies)`,
    want: "node_modules/electron plus every dependency it declares",
    fix: "npm run setup:electron",
    url: "https://www.electronjs.org/",
  });

  // 1b) The scripts the build runs (vite, electron-builder) must be installed; they are started with node, so no
  //     command link in node_modules/.bin is needed.
  const missingTools = require("./build-pipeline.cjs").missingBuildTools(root);
  add({
    name: "Build tools (vite, electron-builder)",
    required: true,
    group: "node-deps",
    ok: missingTools.length === 0,
    found: missingTools.length
      ? `not installed in node_modules: ${missingTools.join(", ")}`
      : "installed in node_modules",
    want: "node_modules has vite and electron-builder",
    fix: "npm ci",
    url: "https://docs.npmjs.com/cli/commands/npm-ci",
  });

  // 2) The binary must actually execute and report its version. The very same
  //    verification the Electron repair tool uses, so doctor and setup can
  //    never disagree about the state of node_modules/electron/dist.
  let runnable = null;
  let runError = "";
  if (electronSize > 0) {
    try {
      const probe = require(path.join(root, "scripts", "ensure-electron.cjs")).verifyBinary();
      runnable = probe.runnable ? probe.version : null;
      runError = probe.error || "";
    } catch (error) {
      runnable = null;
      runError = String(error && error.message ? error.message : error);
    }
  }

  // Missing desktop system libraries are an OS limitation, not a bad download,
  // and only matter on the platform FRIDAY ships to (Windows).
  const systemLibs = /shared librar|libglib|libgtk|libnss|\.so\.\d/i.test(runError);

  // 3) The binary itself: present, non-empty and — on Windows — only PASS when
  //    the executed binary itself reports a supported version.
  add({
    name: "Electron binary",
    required: true,
    group: "electron-binary",
    ok:
      electronSize > 0 &&
      (supported(runnable, versions.electronMinimum) ||
        (!win && systemLibs && supported(electronVersion, versions.electronMinimum))),
    found:
      electronSize > 0
        ? runnable
          ? `v${runnable} verified by executing ${electronBinary}`
          : systemLibs && !win
            ? `v${electronVersion || "unknown"} present at ${electronBinary} (cannot execute on this OS: ${runError})`
            : `present but did not report a supported version${runError ? ` - ${runError}` : ""}`
        : "missing (npm install did not run its download step)",
    want: `Electron ${minimumLabel(versions.electronMinimum)}: real binary at ${electronBinary} that executes and reports its version`,
    fix: "npm run setup:electron",
    url: "https://www.electronjs.org/",
  });

  add({
    name: "Electron binary runnable",
    required: win || !systemLibs,
    group: systemLibs ? undefined : "electron-binary",
    ok: !!runnable && supported(runnable, versions.electronMinimum),
    found: runnable
      ? `executes and reports v${runnable}`
      : electronSize > 0
        ? systemLibs
          ? `not launchable on this OS: ${runError}`
          : `binary present but failed to execute (corrupt or incomplete download)${runError ? ` - ${runError}` : ""}`
        : "no binary to execute",
    want: "electron binary starts and reports a supported version",
    fix: systemLibs
      ? "Install the desktop system libraries for this OS (not needed on Windows)"
      : "npm run setup:electron",
    url: "https://www.electronjs.org/",
  });

  // 4) The installer tools electron-builder needs to make the NSIS installer. They are fetched with the
  //    Electron binary, so the build does not start its first big download in the middle of packaging.
  {
    const tools = require(path.join(root, "scripts", "ensure-electron.cjs")).installerToolsReady();
    add({
      name: "Installer tools (NSIS)",
      required: win,
      group: win ? "electron-binary" : undefined,
      ok: tools.ready,
      found: tools.ready
        ? tools.wanted
          ? "fetched and cached for electron-builder"
          : "not needed on this OS"
        : `not ready (${tools.reason})`,
      want: "NSIS and its plugins in electron-builder's cache, fetched before the build",
      fix: "npm run setup:electron",
      url: "https://github.com/electron-userland/electron-builder-binaries/releases",
    });
  }
}

// This PC's setup plan as plain data (prefetch-models.cjs --plan --json), read once by the model rows below.
let setupPlanData = null;
{
  // The installed client, on PATH or in its standard folders: a per-user
  // install is not on the PATH of a shell opened before it was installed.
  const installedOllama = require("../electron/local-library.cjs").findInstalledOllama();
  const ollama = installedOllama ? installedOllama.version || "installed" : null;
  add({
    name: "Ollama (local models)",
    required: toolsRequired,
    group: "local-models",
    hosts: jobHostsOf("ollama-setup"),
    ok: !!ollama,
    found: ollama ? (/^\d/.test(ollama) ? `v${ollama}` : ollama) : "not installed",
    want: toolsRequired
      ? "the local chat engine the build installs (npm run setup:python)"
      : "only for local LLMs",
    fix: toolsRequired ? "npm run doctor" : "winget install -e --id Ollama.Ollama",
    url: "https://ollama.com/download",
  });
  // The speech, voice and chat weights that make FRIDAY listen, talk and answer. Doctor used to pass without
  // looking at them, so a setup that lost its network halfway still ended "ready" and the first launch then
  // downloaded gigabytes. One row each; `--fix` runs setup-python, which fetches what is missing.
  try {
    const prefetchModels = require("./prefetch-models.cjs");
    const pickedRoot = require("./friday-root.cjs").workspaceRootOrDev().root;
    const ramGb = require("node:os").totalmem() / 1024 ** 3;
    const labels = {
      "stt-tiny": "Speech model: tiny (lite fallback)",
      "stt-base": "Speech model: base (fast listening)",
      "stt-small": "Speech model: small (Hindi and Hinglish)",
      "stt-medium": "Speech model: medium (accurate)",
      "stt-large-v3-turbo": "Speech model: large-v3-turbo (big, fast)",
      "stt-large-v3": "Speech model: large-v3 (most accurate)",
      "smart-turn": "Voice model: end-of-turn detector",
      "silero-vad": "Voice model: speech detector",
      "supertonic-3": "Voice model: offline voice (Supertonic 3)",
      "hindi-ear": "Voice model: Hindi ear",
      "hindi-punct": "Voice model: Hindi punctuation",
      "hindi-light-tts": "Voice model: light Hindi voice",
      "hinglish-ear": "Voice model: Hinglish ear",
      "hindi-fallback-ear": "Voice model: Hindi fallback ear",
      "qwen3-4b": "Chat model file: Qwen3 4B",
      "llamacpp-runtime": "Local engine: llama.cpp (llama-server)",
    };
    // ONE required set for this PC: the plan setup itself followed (electron/setup-plan.cjs through prefetch-models.cjs
    // --plan --json), so a model the plan skipped here is shown as skipped, never missing, and a required one that is
    // absent is a real failure. Without a readable plan the older fixed list below is checked as before.
    const planData = prefetchModels.readPlanSync(process.env);
    setupPlanData = planData;
    if (planData) {
      const weights = require("../electron/voice-weights.cjs");
      const needed = new Map(planData.required.map((row) => [row.id, row]));
      const neededJobs = new Set(
        planData.required
          .filter((row) => row.kind === "voice-model")
          .map((row) => prefetchModels.voiceJobId(row.id)),
      );
      const skippedBy = new Map((planData.skipped || []).map((row) => [row.id, row.reason]));
      const jobIdOfSkipped = (id) => (weights.SIZE_ORDER.includes(id) ? `stt-${id}` : id);
      const skippedJobs = new Map(
        [...skippedBy].map(([id, reason]) => [jobIdOfSkipped(id), reason]),
      );
      const llamaNeeded =
        needed.has("llama.cpp") && ["install", "present"].includes(needed.get("llama.cpp").action);
      const synthetic = {
        items: planData.required
          .filter((row) => row.kind === "voice-model")
          .map((row) => ({
            id: row.id,
            state: row.action === "present" ? "on-disk" : "download",
          })),
        blocked: weights.SIZE_ORDER.filter((size) => skippedBy.has(size)).map((size) => ({
          id: size,
          size,
          reason: skippedBy.get(size),
        })),
      };
      const jobs = prefetchModels.prefetchPlan(pickedRoot, process.env, process.platform, {
        ollama: true,
        plan: synthetic,
        ...(llamaNeeded ? { llama: { action: "install" } } : {}),
      });
      const shown = new Set();
      for (const job of jobs) {
        if (!labels[job.id]) continue;
        if (job.id === "qwen3-4b" && win) continue; // Ollama holds the chat model; the file copy is a fallback
        shown.add(job.id);
        const planned = neededJobs.has(job.id) || (job.id === "llamacpp-runtime" && llamaNeeded);
        const reason = skippedJobs.get(job.id) || job.skipReason;
        const here =
          job.id === "llamacpp-runtime"
            ? require("../electron/llama-runtime.cjs").installed(pickedRoot) ||
              prefetchModels.alreadyThere(job)
            : prefetchModels.alreadyThere(job);
        if (!planned && reason) {
          add({
            name: labels[job.id],
            required: false,
            group: "local-models",
            hosts: probes.jobHosts(job),
            ok: true,
            found: `skipped on this PC: ${reason}`.slice(0, 160),
            want: "not part of this PC's plan; install it from the Models page if you want it",
            fix: "npm run doctor",
            url: "https://huggingface.co",
          });
          continue;
        }
        add({
          name: labels[job.id],
          required: planned && toolsRequired && !job.optional,
          group: "local-models",
          hosts: probes.jobHosts(job),
          // A piece setup fetches that this PC's plan does not need is an extra: never a failure.
          ok: planned ? here : true,
          found: here
            ? "on disk"
            : planned
              ? "missing"
              : "not on disk (extra, not part of this PC's plan)",
          want:
            job.id === "llamacpp-runtime"
              ? "unpacked by npm run setup under the FRIDAY folder; FRIDAY starts it with the chat model"
              : "downloaded by npm run setup, so FRIDAY listens, talks and answers offline",
          fix: "npm run doctor",
          url: "https://huggingface.co",
        });
      }
      for (const [id, reason] of skippedJobs) {
        if (shown.has(id) || !labels[id] || neededJobs.has(id)) continue;
        add({
          name: labels[id],
          required: false,
          group: "local-models",
          ok: true,
          found: `skipped on this PC: ${reason}`.slice(0, 160),
          want: "not part of this PC's plan; install it from the Models page if you want it",
          fix: "npm run doctor",
          url: "https://huggingface.co",
        });
      }
    } else {
      add({
        name: "This PC's setup plan",
        required: false,
        group: "local-models",
        ok: false,
        found: "could not be read; the fixed model list is checked instead",
        want: "node scripts/prefetch-models.cjs --plan prints it",
        skip: "the plan needs the hardware probe; the older fixed list below is checked as before",
        fix: "npm run doctor",
        url: "https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT",
      });
      // llama.cpp serves the chat model from its GGUF file, so on Windows the file is needed as well as Ollama's copy.
      const llamaPlanned = prefetchModels
        .prefetchPlan(pickedRoot, process.env, process.platform, { ollama: true })
        .some((job) => job.id === "llamacpp-runtime");
      for (const job of prefetchModels.prefetchPlan(pickedRoot, process.env, process.platform, {
        ollama: true,
      })) {
        if (!labels[job.id]) continue;
        if (job.minRamGb && ramGb < job.minRamGb) continue;
        // Ollama provides the small chat model on Windows; its file copy is only a fallback.
        if (job.id === "qwen3-4b" && win && !llamaPlanned) continue;
        const here = prefetchModels.alreadyThere(job);
        add({
          name: labels[job.id],
          required: toolsRequired && !job.optional,
          group: "local-models",
          hosts: probes.jobHosts(job),
          ok: here,
          found: here ? "on disk" : "missing",
          want:
            job.id === "llamacpp-runtime"
              ? "unpacked by npm run setup under the FRIDAY folder; FRIDAY starts it with the chat model"
              : "downloaded by npm run setup, so FRIDAY listens, talks and answers offline",
          fix: "npm run doctor",
          url: "https://huggingface.co",
        });
      }
    }
    const english = prefetchModels.moonshineReady(
      path.join(pickedRoot, ...prefetchModels.MOONSHINE_DIR),
    );
    // Setup fetches the English streaming speech on every PC unless its own switch (or all of prefetch) is off, so
    // "skipped on this PC" is said only for that, or while no Python runtime exists to fetch it with.
    const moonshineOff = ["FRIDAY_PREFETCH_MOONSHINE", "FRIDAY_PREFETCH"].some(
      (key) => String(process.env[key] ?? "1").trim() === "0",
    );
    const moonshineWhy = moonshineOff
      ? "its prefetch is switched off (FRIDAY_PREFETCH_MOONSHINE=0)"
      : !pythonExecutable
        ? "no Python runtime yet; npm run setup:python fetches it"
        : "";
    add({
      name: "Speech model: English streaming (Moonshine)",
      required: toolsRequired && !moonshineWhy,
      group: "local-models",
      hosts: ["download.moonshine.ai"],
      ok: english || !!moonshineWhy,
      found: english ? "on disk" : moonshineWhy ? `skipped on this PC: ${moonshineWhy}` : "missing",
      want: "the fastest English listening, fetched by npm run setup",
      fix: "npm run doctor",
      url: "https://github.com/moonshine-ai/moonshine",
    });
    // The installed ONNX Runtime build against the one this PC's plan recommends (information only).
    const ort = probes.ortRow(
      probes.probeOrt(pythonExecutable),
      setupPlanData?.required.find((row) => row.id === "onnxruntime"),
    );
    add({
      name: "ONNX Runtime build (cpu, gpu, directml)",
      required: false,
      group: "local-models",
      hosts: probes.PYPI_HOSTS,
      ok: true,
      found: ort.found,
      want: ort.want,
      note: [ort.want, ort.note].filter(Boolean).join("; "),
      fix: "npm run doctor",
      url: "https://onnxruntime.ai/",
    });
    if (win && installedOllama) {
      const listed = (capture(installedOllama.exe || "ollama", ["list"]) || "").toLowerCase();
      const holds = (tag) => listed.includes(String(tag).toLowerCase());
      const chat = planData?.required.find((row) => row.kind === "chat-model");
      if (planData && chat) {
        // The tier model for this PC (or the installed model that stays in use). The light Qwen registered from its file
        // when the registry could not be reached also answers.
        const light = prefetchModels.OLLAMA_MODELS[0]?.tag;
        const has = holds(chat.id);
        const fallback = !has && chat.action === "pull" && light && holds(light);
        const waiting = !has && !fallback && chat.action === "defer";
        add({
          name: `Chat model in Ollama: ${chat.id}`,
          required: toolsRequired && !waiting,
          group: "local-models",
          ok: has || fallback || waiting,
          found: has
            ? chat.action === "keep" || chat.action === "offer-upgrade"
              ? "installed and in use (kept, never replaced)"
              : "pulled (this PC's tier)"
            : fallback
              ? `${light} is in use; the tier model ${chat.id} was not pulled`
              : waiting
                ? "waiting for a better moment (offline, metered line or battery)"
                : "not pulled",
          want: `the chat model this PC's memory carries (${planData.pc?.ramGb ?? "unknown"} GB RAM${planData.pc?.gpu ? `, ${planData.pc.gpu.vramGb ?? "unknown"} GB video memory` : ", no GPU"})`,
          fix: "npm run doctor",
          url: "https://ollama.com/library",
        });
      } else if (!planData) {
        // The light model is required; the bigger tiers are checked only on a PC with the memory and never block.
        for (const model of prefetchModels.OLLAMA_MODELS) {
          if (model.minRamGb && ramGb < model.minRamGb) continue;
          const has = holds(model.tag);
          add({
            name: `Chat model in Ollama: ${model.tag}`,
            required: toolsRequired && !model.optional,
            group: "local-models",
            ok: has,
            found: has ? "pulled" : "not pulled",
            want: model.role || "a local chat model",
            fix: "npm run doctor",
            url: "https://ollama.com/library",
          });
        }
      }
    }
  } catch (error) {
    add({
      name: "Speech and chat models",
      required: false,
      group: "local-models",
      ok: false,
      found: `could not be checked (${String((error && error.message) || error).slice(0, 80)})`,
      want: "the speech, voice and chat weights",
      fix: "npm run doctor",
      url: "https://huggingface.co",
    });
  }
  const ffmpeg = capture("ffmpeg", ["-version"]);
  add({
    name: "FFmpeg",
    required: toolsRequired,
    group: "toolchain",
    hosts: toolHostsOf("FFmpeg"),
    ok: !!ffmpeg,
    found: ffmpeg ? firstVersion(ffmpeg) || "present" : "not installed",
    want: toolsRequired
      ? "installed by setup — media convert/trim tools"
      : "media convert/trim tools",
    fix: toolsRequired ? "npm run doctor" : "winget install -e --id Gyan.FFmpeg",
    url: "https://ffmpeg.org/download.html",
  });
  const tesseract = captureCommand(
    ["tesseract", "tesseract.exe"],
    ["--version"],
    [
      path.join(process.env.ProgramFiles || "C:\\Program Files", "Tesseract-OCR"),
      path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Tesseract-OCR"),
    ],
  );
  add({
    name: "Tesseract OCR",
    required: toolsRequired,
    group: "toolchain",
    hosts: toolHostsOf("Tesseract OCR"),
    ok: !!tesseract,
    found: tesseract ? firstVersion(tesseract) || "present" : "not installed",
    want: toolsRequired ? "installed by setup — screen and PDF OCR" : "screen and PDF OCR",
    fix: toolsRequired ? "npm run doctor" : "winget install -e --id UB-Mannheim.TesseractOCR",
    url: "https://github.com/UB-Mannheim/tesseract/wiki",
  });
  if (tesseract) {
    // `tesseract --list-langs`: English is needed by the OCR tool; Hindi is a language pack that is read when present.
    const langs = probes.tesseractLanguages(
      captureCommand(
        ["tesseract", "tesseract.exe"],
        ["--list-langs"],
        [
          path.join(process.env.ProgramFiles || "C:\\Program Files", "Tesseract-OCR"),
          path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Tesseract-OCR"),
        ],
      ),
    );
    add({
      name: "Tesseract language: English (eng)",
      required: toolsRequired,
      group: "toolchain",
      ok: langs.eng,
      found: langs.eng
        ? `eng (${langs.langs.length} language pack(s): ${langs.langs.slice(0, 6).join(", ")}${langs.langs.length > 6 ? ", ..." : ""})`
        : langs.listed
          ? `not installed (found: ${langs.langs.join(", ")})`
          : "tesseract --list-langs gave no list",
      want: "eng.traineddata, the language every OCR call needs",
      fix: toolsRequired ? "npm run doctor" : "reinstall Tesseract OCR with its English data",
      url: "https://github.com/tesseract-ocr/tessdata",
    });
    add({
      name: "Tesseract language pack: Hindi (hin)",
      required: false,
      group: "toolchain",
      ok: langs.hin,
      found: langs.hin ? "hin" : "not installed",
      want: "hin.traineddata, so Hindi text on the screen and in PDFs is read",
      skip: "the Hindi pack is a language pack: npm run setup installs it, and OCR of Devanagari text waits for it",
      fix: "npm run doctor",
      url: "https://github.com/tesseract-ocr/tessdata",
    });
  }
}
if (win) {
  const vc = fs.existsSync(
    path.join(process.env.SystemRoot || "C:\\Windows", "System32", "vcruntime140.dll"),
  );
  add({
    name: "Visual C++ 2015-2022 Redistributable",
    required: toolsRequired,
    group: "toolchain",
    ok: vc,
    found: vc ? "present" : "not detected",
    want: toolsRequired
      ? "installed by setup — native Python wheels and model runtimes need it"
      : "needed by some native model runtimes",
    fix: toolsRequired ? "npm run doctor" : "winget install -e --id Microsoft.VCRedist.2015+.x64",
    url: "https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist",
  });
  const cuda = !!capture("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"]);
  // Hardware, not software: no NVIDIA GPU means the CUDA libraries do not apply, so this row describes the PC and never
  // warns. With this PC's plan it names the measured facts (card, video memory, compute capability, driver, CUDA version).
  const pc = setupPlanData?.pc;
  const card = pc?.gpu && pc.gpu.vendor === "nvidia" ? pc.gpu : null;
  const known = (value, unit = "") =>
    value === null || value === undefined ? "unknown" : `${value}${unit}`;
  add({
    name: "NVIDIA GPU / CUDA",
    required: false,
    ok: true,
    found: card
      ? `${card.name || "NVIDIA card"}, ${known(card.vramGb, " GB")} video memory, compute ${known(card.computeCap)}, driver ${known(card.driver)}, CUDA ${known(pc.cudaVersion)}`
      : cuda
        ? "GPU detected"
        : "not applicable: no NVIDIA GPU (CPU inference is used)",
    want: cuda
      ? "CUDA libraries are installed by setup when the plan says so"
      : "nothing to install on this PC",
    fix: "Install the NVIDIA driver, then npm run doctor",
    url: "https://developer.nvidia.com/cuda-downloads",
  });
  // The CUDA 12 libraries (cuBLAS, cuDNN): required only when this PC's plan installs them; the plan never installs them
  // without an NVIDIA card whose driver reports CUDA 12.
  const libs = setupPlanData?.required.find((row) => row.id === "cuda-libs");
  if (libs) {
    const python = require("./explicit-python.cjs").explicitPython(process.env.FRIDAY_PYTHON);
    const probe = [
      "import importlib.util as u, pathlib",
      "def ok(m, d):",
      "    s = u.find_spec(m)",
      "    return bool(s and s.submodule_search_locations and any((pathlib.Path(p) / 'bin' / d).is_file() for p in s.submodule_search_locations))",
      "raise SystemExit(0 if ok('nvidia.cublas', 'cublas64_12.dll') and ok('nvidia.cudnn', 'cudnn64_9.dll') else 1)",
    ].join("\n");
    const have = python ? capture(python, ["-c", probe]) !== null : false;
    add({
      name: "CUDA 12 libraries (cuBLAS, cuDNN)",
      required: toolsRequired && libs.action !== "defer" && !!python,
      group: "local-models",
      hosts: probes.PYPI_HOSTS,
      ok: have || libs.action === "defer",
      found: have
        ? "present"
        : libs.action === "defer"
          ? "waiting for a better moment (offline, metered line or battery)"
          : python
            ? "not installed"
            : "cannot be checked (no Python runtime yet)",
      want: "installed by npm run setup:python on an NVIDIA PC whose driver reports CUDA 12",
      fix: "npm run doctor",
      url: "https://developer.nvidia.com/cuda-downloads",
    });
  }
}

// ---------------------------------------------------------------- agent toolkit
// The tools FRIDAY leans on to run, build, test, search, convert, containerise
// and use the GPU (config/agent-toolkit.json). Where the setup installs them they
// are required: a missing one fails the check and `npm run doctor` installs it.
// Not applicable to this PC (no NVIDIA driver, a Windows edition without the
// Sandbox) is shown as such; administrator tools switched off on purpose
// (FRIDAY_PREFETCH_TOOLKIT_ELEVATED=0) stay optional.
if (win) {
  const toolkit = require(path.join(root, "config", "agent-toolkit.json"));
  const expand = (text) =>
    String(text || "").replace(/%([^%]+)%/g, (_m, name) => process.env[name] || "");
  let managedDirs = [];
  try {
    const picked = require("./friday-root.cjs").workspaceRootOrDev();
    const file = path.join(picked.root, "runtime", "managed-path.json");
    managedDirs = JSON.parse(fs.readFileSync(file, "utf8")).dirs || [];
  } catch {
    managedDirs = [];
  }
  const gpu = !!capture("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"]);
  const edition = toolsRequired ? windowsEdition() : "";
  for (const entry of toolkit.prefetch) {
    if (entry.requires === "nvidia-gpu" && !gpu) continue;
    // FFmpeg and Tesseract have their own rows above.
    if (entry.id === "FFmpeg" || entry.id === "Tesseract OCR") continue;
    const probe = entry.probe || {};
    let found = null;
    if (probe.file) {
      found = fs.existsSync(expand(probe.file)) ? "present" : null;
    } else if (probe.cmd) {
      const dirs = [...(probe.dirs || []).map(expand), ...managedDirs];
      const out = captureCommand(probe.cmd, probe.args || ["--version"], dirs);
      found = out ? firstVersion(out) || "present" : null;
    }
    const sandboxMissing = entry.id.startsWith("Sandbox runner") && !found;
    const notApplicable = sandboxMissing && edition && !/pro|enterprise|education/i.test(edition);
    const mustHave = entry.elevated ? elevatedRequired : toolsRequired;
    add({
      name: entry.id,
      group: "agent-toolkit",
      hosts: toolHostsOf(entry.id),
      elevated: Boolean(entry.elevated),
      required: mustHave && !notApplicable && !entry.optional,
      ok: !!found || notApplicable,
      found: found
        ? found
        : notApplicable
          ? `not applicable: not available on this Windows edition (${edition.trim()})`
          : "not installed",
      want: mustHave ? `installed by setup — ${entry.why}` : entry.why,
      fix: "npm run doctor (installs what is missing; accept the Windows administrator prompt)",
      url: "https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT",
    });
  }
}

// ---------------------------------------------------------------- repair
// `--fix` repairs everything FRIDAY can install itself: the toolchain (Git,
// PowerShell, FFmpeg, Tesseract, the Visual C++ runtime) through
// scripts/setup-windows.ps1 -ToolchainOnly, the Electron binary, the pinned
// Python environment, the agent toolkit and the local chat engine. It is
// idempotent: every step reuses what is healthy, and the check simply re-runs
// afterwards. Node itself is never replaced from inside a running Node.
const wantsFix = process.argv.includes("--fix");
// Both Python groups are repairable by setup-python.cjs: it creates or reuses
// the live venv, bootstraps pip and installs the kernel requirement set.
const brokenPython = checks.filter(
  (c) => (c.group === "python-packages" || c.group === "python-runtime") && !c.ok,
);
const brokenElectron = checks.filter((c) => c.group === "electron-binary" && !c.ok);
const brokenNodeDeps = checks.filter((c) => c.group === "node-deps" && !c.ok);
const brokenToolchain = checks.filter((c) => c.group === "toolchain" && !c.ok && c.required);
const brokenToolkit = checks.filter((c) => c.group === "agent-toolkit" && !c.ok && c.required);
const brokenModels = checks.filter((c) => c.group === "local-models" && !c.ok && c.required);
if (
  wantsFix &&
  (brokenElectron.length ||
    brokenNodeDeps.length ||
    brokenPython.length ||
    (win && (brokenToolchain.length || brokenToolkit.length || brokenModels.length)))
) {
  console.log("");
  let failed = false;
  const step = (label, command, args) => {
    console.log(`[friday] --fix: ${label} ...`);
    const r = spawnSync(command, args, { stdio: "inherit", cwd: root });
    if (r.status !== 0) failed = true;
  };
  if (win && brokenToolchain.length) {
    step(
      `installing the toolchain (${brokenToolchain.map((c) => c.name).join(", ")})`,
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(root, "scripts", "setup-windows.ps1"),
        "-ToolchainOnly",
      ],
    );
  }
  if (brokenNodeDeps.length) {
    // A real install (not the "already current" skip) re-creates the package links in node_modules/.bin.
    step("installing the Node dependencies again (npm ci)", process.execPath, [
      "-e",
      "require(process.argv[1]).npmCi(process.cwd(), true)",
      path.join(root, "scripts", "build-pipeline.cjs"),
    ]);
  }
  if (brokenElectron.length) {
    step("installing the resolved Electron binary", process.execPath, [
      path.join(root, "scripts", "ensure-electron.cjs"),
    ]);
  }
  if (brokenPython.length || (win && brokenModels.length)) {
    step(
      `repairing the FRIDAY Python environment and local models (${brokenPython.length + brokenModels.length} issue(s))`,
      process.execPath,
      [path.join(root, "scripts", "setup-python.cjs")],
    );
  }
  if (win && brokenToolkit.length) {
    step(
      `installing the agent toolkit (${brokenToolkit.map((c) => c.name).join(", ")})`,
      process.execPath,
      [path.join(root, "scripts", "prefetch-toolkit.cjs"), "--no-update"],
    );
  }
  console.log("");
  console.log(
    !failed
      ? "[friday] repair finished — re-running the check ..."
      : "[friday] repair failed — see the output above.",
  );
  const again = spawnSync(
    process.execPath,
    [__filename, ...process.argv.slice(2).filter((a) => a !== "--fix")],
    {
      stdio: "inherit",
      cwd: root,
    },
  );
  // exitCode instead of an exit call: ending the process while the table is still draining to a pipe cuts its tail off.
  process.exitCode = again.status ?? 1;
  return;
}

// ---------------------------------------------------------------- report
const pad = (s, n) => String(s).padEnd(n);
// The table follows the width of the console (never narrower than 100, never wider than 160): a long value is cut with
// an ellipsis, and the whole text of a row that is not fine follows below it.
const STATUS_W = 10;
const tableWidth = Math.max(100, Math.min(Number(process.stdout.columns) || 120, 160));
// A path inside the FRIDAY folder is shown from the folder (`.\\runtime\\.venv`): the full folder is printed once at the top
// of every run, and repeating it cut the end off every long row.
const shortPath = (text) => {
  const value = String(text);
  const base = String(root || "");
  if (!base) return value;
  return value.split(`${base}${path.sep}`).join(`.${path.sep}`).split(base).join(".");
};
const longest = (pick) => checks.reduce((n, c) => Math.max(n, shortPath(pick(c)).length), 0);
const nameW = Math.min(40, Math.max(24, longest((c) => c.name) + 2));
const foundW = Math.min(38, Math.max(16, longest((c) => c.found) + 2));
const wantW = Math.max(24, tableWidth - STATUS_W - nameW - foundW);
// The heading already says that newer compatible releases pass, so the row does not repeat it.
const BOILERPLATE = / \(newer compatible releases pass\)$/;
const clip = (text, n) => {
  const value = shortPath(text).replace(BOILERPLATE, "");
  return value.length > n - 1 ? `${value.slice(0, n - 2)}…` : value;
};
const missing = checks.filter((c) => !c.ok && c.required);
const warned = checks.filter((c) => !c.ok && !c.required);
// Every download source of every row, in order, and which host answers now: one parallel probe per distinct host
// (offline: "not checked"). A row that is fine and shares its package or tool index with its group says it once, below.
const SHARED_SOURCES = { "python-packages": "package index", "agent-toolkit": "tool index" };
const reachOf = (list) => probes.reachSync([...new Set(list.flatMap((c) => c.hosts || []))]);

// --summary (the confirming pass inside `npm run setup`): a count, and the full table only when something is wrong.
const summaryOnly =
  process.argv.includes("--summary") && missing.length === 0 && warned.length === 0;
if (summaryOnly) {
  console.log(`[friday] environment check: all ${checks.length} components pass`);
} else {
  console.log("");
}
if (!summaryOnly) {
  console.log("FRIDAY — environment check");
  console.log("Minimum versions are compatibility floors; newer compatible releases PASS.");
  console.log("-".repeat(tableWidth));
  console.log(
    `${pad("STATUS", STATUS_W)}${pad("COMPONENT", nameW)}${pad("INSTALLED", foundW)}MINIMUM SUPPORTED`,
  );
  console.log("-".repeat(tableWidth));
}
const reach = summaryOnly ? {} : reachOf(checks);
const sourcesOf = (c) => probes.sourcesLine(c.hosts, reach, { missing: !c.ok && c.required });
for (const c of summaryOnly ? [] : checks) {
  const state = c.ok ? "PASS" : c.required ? "MISSING" : "SKIPPED";
  console.log(
    `${pad(state, STATUS_W)}${pad(clip(c.name, nameW), nameW)}${pad(clip(c.found, foundW), foundW)}${clip(c.want, wantW)}`,
  );
  if (c.note) console.log(`          note:   ${c.note}`);
  if (c.hosts && c.hosts.length && (!c.ok || !SHARED_SOURCES[c.group]))
    console.log(`          ${sourcesOf(c)}`);
  if (!c.ok) {
    if (shortPath(c.found).length > foundW - 1) console.log(`          found:  ${c.found}`);
    if (!c.required) console.log(`          skipped: ${c.skip || notRequiredBecause(c.elevated)}`);
    console.log(`          wanted: ${c.want}`);
    console.log(`          fix:    ${c.fix}`);
    console.log(`          source: ${c.url}`);
  }
}
if (!summaryOnly) console.log("-".repeat(tableWidth));
if (!summaryOnly) {
  for (const [group, label] of Object.entries(SHARED_SOURCES)) {
    const row = checks.find((c) => c.group === group && c.hosts && c.hosts.length);
    if (row)
      console.log(`${label}: ${probes.sourcesLine(row.hosts, reach).replace(/^sources: /, "")}`);
  }
}

if (missing.length) {
  // Never a generic failure: name every missing component and its exact fix.
  console.error("");
  console.error(`FAILED — ${missing.length} required component(s) missing:`);
  for (const c of missing) {
    console.error("");
    console.error(`  * ${c.name}`);
    console.error(`      installed: ${c.found}`);
    console.error(`      required:  ${c.want}`);
    console.error(`      install:   ${c.fix}`);
    console.error(`      source:    ${c.url}`);
    if (c.hosts && c.hosts.length) console.error(`      ${sourcesOf(c)}`);
  }
  const repairablePython = missing.filter(
    (c) => c.group === "python-packages" || c.group === "python-runtime",
  );
  const repairableElectron = missing.filter((c) => c.group === "electron-binary");
  const repairable = [...repairablePython, ...repairableElectron];
  console.error("");
  if (repairable.length === missing.length) {
    console.error("All of the above can be repaired automatically:");
    console.error("      npm run check:env:fix");
  } else {
    console.error("Run the idempotent official-source setup, then re-run the check:");
    console.error("      npm run setup");
    if (repairablePython.length) console.error("Python environment only:  npm run setup:python");
    if (repairableElectron.length)
      console.error("Electron binary only:     npm run setup:electron");
  }
  process.exitCode = 1;
  return;
}
if (warned.length && strict) {
  console.error(
    `FAILED (strict) — ${warned.length} component(s) not installed on this run: ${warned.map((c) => c.name).join(", ")}`,
  );
  process.exitCode = 1;
  return;
}
if (!summaryOnly)
  console.log(
    warned.length
      ? `Ready to build (${warned.length} tool(s) skipped on this run, installed by npm run setup on your PC: ${warned.map((c) => c.name).join(", ")}).`
      : "Ready to build.",
  );
