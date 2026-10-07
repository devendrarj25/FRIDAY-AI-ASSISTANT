/**
 * FRIDAY — environment check for a fresh Windows PC.
 *
 * Read-only. Detects every runtime FRIDAY needs to build and run, prints the
 * exact official installation command for anything missing, and exits non-zero
 * only when a REQUIRED component is absent.
 *
 *   node scripts/check-environment.cjs          report
 *   node scripts/check-environment.cjs --strict report + fail on warnings
 *
 * Nothing is installed or modified here; repairs are performed by `npm run setup`.
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { spawnCaptured, spawnNpm } = require("./win-spawn.cjs");

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
    return `${r.stdout || ""}${r.stderr || ""}`.trim();
  } catch {
    return null;
  }
};

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
  const capabilityNames = new Set(runtime.CAPABILITY_PACKAGES);

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
      required: capability ? false : !voice || win,
      group: "python-packages",
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
    ok: supported(v, versions.powershellMinimum),
    found: v ? `v${v}` : "not found",
    want: SUPPORTED.powershell,
    fix: "npm run setup",
    url: "https://learn.microsoft.com/powershell/",
  });
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
}

{
  const ollama = firstVersion(capture("ollama", ["--version"]));
  add({
    name: "Ollama (local models)",
    required: false,
    ok: !!ollama,
    found: ollama ? `v${ollama}` : "not installed",
    want: "optional — only for local LLMs",
    fix: "winget install -e --id Ollama.Ollama",
    url: "https://ollama.com/download",
  });
  const ffmpeg = capture("ffmpeg", ["-version"]);
  add({
    name: "FFmpeg",
    required: false,
    ok: !!ffmpeg,
    found: ffmpeg ? firstVersion(ffmpeg) || "present" : "not installed",
    want: "optional — media convert/trim tools",
    fix: "winget install -e --id Gyan.FFmpeg",
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
    required: false,
    ok: !!tesseract,
    found: tesseract ? firstVersion(tesseract) || "present" : "not installed",
    want: "optional — screen and PDF OCR",
    fix: "winget install -e --id UB-Mannheim.TesseractOCR",
    url: "https://github.com/UB-Mannheim/tesseract/wiki",
  });
}
if (win) {
  const vc = fs.existsSync(
    path.join(process.env.SystemRoot || "C:\\Windows", "System32", "vcruntime140.dll"),
  );
  add({
    name: "Visual C++ 2015-2022 Redistributable",
    required: false,
    ok: vc,
    found: vc ? "present" : "not detected",
    want: "optional — needed by some native model runtimes",
    fix: "winget install -e --id Microsoft.VCRedist.2015+.x64",
    url: "https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist",
  });
  const cuda = !!capture("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"]);
  add({
    name: "NVIDIA GPU / CUDA",
    required: false,
    ok: cuda,
    found: cuda ? "GPU detected" : "no NVIDIA GPU detected (CPU inference is used)",
    want: "optional — GPU acceleration only",
    fix: "Install the NVIDIA driver, then CUDA from the official site",
    url: "https://developer.nvidia.com/cuda-downloads",
  });
}

// ---------------------------------------------------------------- repair
// `--fix` repairs everything FRIDAY can install itself (the pinned Python
// kernel packages). It is idempotent: pip re-installs the same pinned set and
// the check simply re-runs afterwards. Truly external components (Node,
// Python itself, Git) are never installed silently — they are reported.
const wantsFix = process.argv.includes("--fix");
// Both Python groups are repairable by setup-python.cjs: it creates or reuses
// the live venv, bootstraps pip and installs the kernel requirement set.
const brokenPython = checks.filter(
  (c) => (c.group === "python-packages" || c.group === "python-runtime") && !c.ok,
);
const brokenElectron = checks.filter((c) => c.group === "electron-binary" && !c.ok);
if (wantsFix && (brokenElectron.length || brokenPython.length)) {
  console.log("");
  let failed = false;
  if (brokenElectron.length) {
    console.log("[friday] --fix: installing the resolved Electron binary ...");
    const e = spawnSync(process.execPath, [path.join(root, "scripts", "ensure-electron.cjs")], {
      stdio: "inherit",
      cwd: root,
    });
    if (e.status !== 0) failed = true;
  }
  if (brokenPython.length) {
    console.log(
      `[friday] --fix: repairing the FRIDAY Python environment (${brokenPython.length} issue(s)) ...`,
    );

    const r = spawnSync(process.execPath, [path.join(root, "scripts", "setup-python.cjs")], {
      stdio: "inherit",
      cwd: root,
    });
    if (r.status !== 0) failed = true;
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
  process.exit(again.status ?? 1);
}

// ---------------------------------------------------------------- report
const pad = (s, n) => String(s).padEnd(n);
const missing = checks.filter((c) => !c.ok && c.required);
const warned = checks.filter((c) => !c.ok && !c.required);

console.log("");
console.log("FRIDAY — environment check");
console.log("Minimum versions are compatibility floors; newer compatible releases PASS.");
console.log("-".repeat(78));
console.log(`${pad("STATUS", 10)}${pad("COMPONENT", 34)}${pad("INSTALLED", 22)}MINIMUM SUPPORTED`);
console.log("-".repeat(78));
for (const c of checks) {
  const state = c.ok ? "PASS" : c.required ? "MISSING" : "WARN";
  console.log(`${pad(state, 10)}${pad(c.name, 34)}${pad(c.found, 22)}${c.want}`);
  if (!c.ok) {
    console.log(`          wanted: ${c.want}`);
    console.log(`          fix:    ${c.fix}`);
    console.log(`          source: ${c.url}`);
  }
}
console.log("-".repeat(78));

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
  process.exit(1);
}
if (warned.length && strict) {
  console.error(
    `FAILED (strict) — ${warned.length} optional component(s) missing: ${warned.map((c) => c.name).join(", ")}`,
  );
  process.exit(1);
}
console.log(
  warned.length
    ? `Ready to build (optional, not installed: ${warned.map((c) => c.name).join(", ")}).`
    : "Ready to build.",
);
