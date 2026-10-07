/**
 * FRIDAY toolchain manager (main process only).
 *
 * Real detection + real installation of runtimes and developer tools.
 *  - detection: probes the local machine with `where/which` + `--version`
 *  - latest versions: official registries only (npm, PyPI, GitHub releases)
 *  - install/update/repair/uninstall: winget / npm / pip / cargo, streamed
 *
 * Nothing here downloads from a mirror, and every job is de-duplicated so the
 * same package can never be installed twice at the same time.
 */
const { execFile, spawn } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { resolvePython } = require("./python.cjs");
const fridayPaths = require("./friday-paths.cjs");

const WIN = process.platform === "win32";
const PY = WIN ? "python" : "python3";

// Commands that open a window instead of printing to stdout. Executing one of
// these pops a native modal dialog that steals focus from FRIDAY and makes the
// whole app look frozen, so detection must never spawn them.
const GUI_COMMANDS = new Set([
  "wt",
  "wt.exe",
  "explorer",
  "explorer.exe",
  "notepad",
  "notepad.exe",
]);

const run = (cmd, args, timeout = 6000) =>
  new Promise((resolve) => {
    if (GUI_COMMANDS.has(String(cmd || "").toLowerCase())) return resolve(null);
    try {
      execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
        const out = `${stdout || ""}${stderr || ""}`.trim();
        resolve(err && !out ? null : out);
      });
    } catch {
      resolve(null);
    }
  });

const which = async (cmd) => {
  const out = await run(WIN ? "where" : "which", [cmd], 4000);
  if (!out) return null;
  const first = out.split(/\r?\n/).find((l) => l.trim() && !/^INFO:/i.test(l));
  return first ? first.trim() : null;
};

/**
 * Re-read PATH from the Windows registry into this process.
 *
 * A package manager writes the new PATH to the registry, but our already
 * running Electron process keeps the PATH it inherited at launch — so a tool
 * that installed perfectly still probes as "Missing" until FRIDAY restarts.
 * Pulling the machine + user PATH back in makes the post-install re-probe
 * honest without asking the owner to restart anything.
 */
const refreshPathFromRegistry = async () => {
  if (!WIN) return false;
  const out = await run(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')",
    ],
    8000,
  );
  const fresh = (out || "").trim();
  if (!fresh) return false;
  const seen = new Set();
  const merged = [];
  for (const part of `${process.env.PATH || ""};${fresh}`.split(";")) {
    const dir = part.trim().replace(/[\\/]+$/, "");
    if (!dir) continue;
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(dir);
  }
  const next = merged.join(";");
  const changed = next !== process.env.PATH;
  process.env.PATH = next;
  return changed;
};

const semver = (text) => {
  if (!text) return null;
  const m = /(\d+\.\d+(?:\.\d+)?(?:[-.\w]*)?)/.exec(text.split(/\r?\n/)[0] || text);
  return m ? m[1].replace(/[.,]$/, "") : null;
};

/* ------------------------------------------------- real Windows detectors */

/** Read one registry value across both registry views, per-machine and per-user. */
async function regValue(key, name) {
  if (!WIN) return null;
  const views = ["64", "32"];
  for (const view of views) {
    const out = await run("reg", ["query", key, "/v", name, `/reg:${view}`], 6000);
    if (!out) continue;
    const m = new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`, "i").exec(out);
    if (m) return m[1].trim();
  }
  return null;
}

const WEBVIEW2_CLIENT = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

/**
 * WebView2 is registered by Edge Update, per-machine (usually in the 32-bit
 * view) or per-user. Probing a single hard-coded key reports a perfectly
 * healthy runtime as missing, which is what made this row fail forever.
 */
async function detectWebView2() {
  const keys = [
    `HKLM\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_CLIENT}`,
    `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_CLIENT}`,
    `HKCU\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_CLIENT}`,
  ];
  for (const key of keys) {
    const version = await regValue(key, "pv");
    if (version && version !== "0.0.0.0") {
      return {
        installed: true,
        version: semver(version) || version,
        path: key.startsWith("HKCU") ? "per-user runtime" : "per-machine runtime",
        status: "Ready",
      };
    }
  }
  return { installed: false, version: null, path: null, status: "Missing" };
}

/**
 * Windows Sandbox is an optional Windows feature, not a downloadable package.
 * Report its real state instead of a failure the owner cannot act on.
 */
async function detectWindowsSandbox() {
  if (!WIN) {
    return { installed: false, status: "Manual", manual: "Windows-only feature" };
  }
  const exe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsSandbox.exe");
  if (fs.existsSync(exe)) {
    return { installed: true, version: null, path: exe, status: "Ready" };
  }
  const caption =
    (await run(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-CimInstance Win32_OperatingSystem).Caption",
      ],
      10_000,
    )) || "";
  const supported = /pro|enterprise|education/i.test(caption);
  return {
    installed: false,
    version: null,
    path: null,
    status: "Manual",
    manual: supported
      ? "supported on this Windows edition — enable the “Windows Sandbox” optional feature, then reboot"
      : `not available on this Windows edition${caption ? ` (${caption.trim()})` : ""} — Pro, Enterprise or Education is required`,
  };
}

/** Global npm bin directory, used to verify npm-installed CLIs for real. */
let npmPrefix = { at: 0, dir: null };
async function npmBinDir() {
  if (Date.now() - npmPrefix.at < 60_000) return npmPrefix.dir;
  const out = await run(WIN ? "npm.cmd" : "npm", ["prefix", "-g"], 12_000);
  const dir = (out || "").split(/\r?\n/).find((l) => l.trim()) || null;
  npmPrefix = { at: Date.now(), dir: dir ? dir.trim() : null };
  return npmPrefix.dir;
}

/**
 * rcedit ships an .exe inside its npm package; the `rcedit` shim is not always
 * on PATH. Verify the real executable rather than trusting an npm exit code.
 */
async function detectRcedit() {
  const onPath = await which(WIN ? "rcedit" : "rcedit");
  if (onPath) return { installed: true, version: null, path: onPath, status: "Ready" };
  const prefix = await npmBinDir();
  // `npm prefix -g` and `npm root -g` do not always agree (nvm, Volta, a
  // custom prefix), and the package has no CLI shim — so ask npm where the
  // module really landed instead of trusting the install exit code.
  const roots = [];
  if (prefix)
    roots.push(path.join(prefix, "node_modules"), path.join(prefix, "lib", "node_modules"));
  const globalRoot = (await run(WIN ? "npm.cmd" : "npm", ["root", "-g"], 12_000)) || "";
  const globalDir = globalRoot.split(/\r?\n/).find((line) => line.trim());
  if (globalDir) roots.push(globalDir.trim());
  roots.push(path.join(__dirname, "..", "node_modules"));
  const candidates = [];
  for (const base of roots) {
    candidates.push(
      path.join(base, "rcedit", "bin", "rcedit-x64.exe"),
      path.join(base, "rcedit", "bin", "rcedit.exe"),
    );
  }
  for (const file of candidates) {
    if (fs.existsSync(file)) return { installed: true, version: null, path: file, status: "Ready" };
  }
  return { installed: false, version: null, path: null, status: "Missing" };
}

/**
 * Hugging Face Hub renamed its CLI from `huggingface-cli` to `hf`. Detect the
 * current command, the legacy one, and the Python package inside FRIDAY's own
 * managed interpreter — the same one pip installs into.
 */
async function detectHuggingFace() {
  for (const cmd of ["hf", "huggingface-cli"]) {
    const bin = await which(cmd);
    if (!bin) continue;
    const out = await run(cmd, ["version"], 10_000);
    return {
      installed: true,
      version: semver(out) || null,
      path: bin,
      status: "Ready",
    };
  }
  const python = await resolvePython(path.join(__dirname, ".."));
  if (python) {
    const out = await run(
      python.exe,
      [...python.prefix, "-c", "import huggingface_hub as h;print(h.__version__)"],
      12_000,
    );
    if (out && semver(out)) {
      return {
        installed: true,
        version: semver(out),
        path: `${python.exe} (huggingface_hub)`,
        status: "Ready",
      };
    }
  }
  return { installed: false, version: null, path: null, status: "Missing" };
}

/**
 * A FRIDAY-managed Python 3.12 runtime, created on demand.
 *
 * Some AI wheels (llama-cpp-python today) are simply not published for the
 * newest Python. Instead of telling the owner to downgrade the machine, FRIDAY
 * builds an isolated 3.12 virtual environment inside her own runtime folder
 * and installs the package there. Returns { exe, prefix } or null.
 */
async function ensureManagedPython(series = "3.12", onLine = () => {}) {
  const base = fridayPaths.hasRoot()
    ? fridayPaths.dir("runtime")
    : path.join(__dirname, "..", "runtime");
  const envDir = path.join(base, `py${series.replace(".", "")}`);
  const exe = WIN ? path.join(envDir, "Scripts", "python.exe") : path.join(envDir, "bin", "python");
  if (fs.existsSync(exe)) return { exe, prefix: [] };

  // Find a real 3.12 interpreter to build the environment from.
  const bases = WIN
    ? [
        { exe: "py", prefix: [`-${series}`] },
        { exe: `python${series}`, prefix: [] },
      ]
    : [{ exe: `python${series}`, prefix: [] }];
  let chosen = null;
  for (const candidate of bases) {
    const out = await run(
      candidate.exe,
      [...candidate.prefix, "-c", "import sys;print('%d.%d' % sys.version_info[:2])"],
      10_000,
    );
    if ((out || "").trim() === series) {
      chosen = candidate;
      break;
    }
  }
  if (!chosen && WIN) {
    onLine(`installing Python ${series} from the official winget package…`);
    await run(
      "winget",
      [
        "install",
        "--id",
        `Python.Python.${series}`,
        "--silent",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--disable-interactivity",
      ],
      30 * 60 * 1000,
    );
    const out = await run(
      "py",
      [`-${series}`, "-c", "import sys;print('%d.%d' % sys.version_info[:2])"],
      10_000,
    );
    if ((out || "").trim() === series) chosen = { exe: "py", prefix: [`-${series}`] };
  }
  if (!chosen) return null;

  fs.mkdirSync(base, { recursive: true });
  onLine(`creating a managed Python ${series} runtime at ${envDir}`);
  await run(chosen.exe, [...chosen.prefix, "-m", "venv", envDir], 10 * 60 * 1000);
  if (!fs.existsSync(exe)) return null;
  await run(exe, ["-m", "pip", "install", "--upgrade", "pip"], 10 * 60 * 1000);
  return { exe, prefix: [] };
}

/**
 * llama-cpp-python compatibility. A blind `pip install` fails on a Python
 * version with no published wheel and, worse, a CPU wheel silently pretends to
 * be CUDA support. Decide the strategy from the real machine first.
 */
async function llamaCppStrategy() {
  const python = await resolvePython(path.join(__dirname, ".."));
  if (!python) {
    return { ok: false, reason: "FRIDAY's managed Python runtime was not found — run Setup first" };
  }
  const raw = await run(
    python.exe,
    [...python.prefix, "-c", "import sys;print('%d.%d' % sys.version_info[:2])"],
    8000,
  );
  const version = (raw || "").trim();
  const minor = Number(version.split(".")[1] || 0);
  if (!version.startsWith("3.") || minor < 9) {
    return {
      ok: false,
      reason: `Python ${version || "unknown"} is not supported by llama-cpp-python`,
    };
  }
  let managed = null;
  if (minor > 13) {
    // No wheel for this Python yet: build/reuse FRIDAY's own 3.12 runtime and
    // install into that, instead of stopping at a manual instruction.
    managed = await ensureManagedPython("3.12");
    if (!managed) {
      return {
        ok: false,
        reason:
          `no llama-cpp-python wheel is published for Python ${version} yet, and a managed ` +
          `Python 3.12 runtime could not be created — install Python 3.12 and retry.`,
      };
    }
  }
  const smi = await run(
    "nvidia-smi",
    ["--query-gpu=name,driver_version", "--format=csv,noheader"],
    8000,
  );
  if (smi && smi.trim()) {
    return {
      ok: true,
      ...(managed ? { python: managed } : {}),
      backend: "cuda",
      extraIndex: "https://abetlen.github.io/llama-cpp-python/whl/cu124",
      note:
        `NVIDIA GPU detected (${smi.split(/\r?\n/)[0].trim()}) — using the CUDA wheel index` +
        (managed ? ` in FRIDAY's managed Python 3.12 runtime (${managed.exe})` : ""),
      verify: "import llama_cpp;print(llama_cpp.__version__)",
    };
  }
  return {
    ok: true,
    ...(managed ? { python: managed } : {}),
    backend: "cpu",
    note:
      "no NVIDIA GPU detected — installing the CPU build (CUDA will NOT be available)" +
      (managed ? ` in FRIDAY's managed Python 3.12 runtime (${managed.exe})` : ""),
    verify: "import llama_cpp;print(llama_cpp.__version__)",
  };
}

/**
 * WinGet health. A broken WinGet source returns package-style failures
 * (0x8A150049, 0x8A15002B) that have nothing to do with the package, so the
 * install manager must not blame the package for them.
 */
const WINGET_SOURCE_CODES = new Map([
  [0x8a150049, "WinGet source agreements were not accepted"],
  [0x8a15002b, "no applicable installer found in the WinGet source"],
  [0x8a150044, "the WinGet source could not be updated"],
]);

function wingetSourceFailure(code) {
  if (code === null || code === undefined) return null;
  const unsigned = code < 0 ? code >>> 0 : code;
  return WINGET_SOURCE_CODES.get(unsigned) || null;
}

async function wingetHealth() {
  if (!WIN) return { available: false, reason: "WinGet is Windows-only" };
  const bin = await which("winget");
  if (!bin) {
    return {
      available: false,
      reason:
        "WinGet (App Installer) is not installed — install “App Installer” from the Microsoft Store",
    };
  }
  const version = await run("winget", ["--version"], 8000);
  const sources = await run("winget", ["source", "list", "--disable-interactivity"], 15_000);
  if (!sources || !/winget/i.test(sources)) {
    return {
      available: false,
      version: semver(version),
      reason:
        "the WinGet package source is unavailable — run `winget source reset --force` in an administrator terminal",
    };
  }
  return { available: true, version: semver(version) };
}

/* ------------------------------------------------------------------ catalog */
/**
 * `id` matches the package name used by the renderer catalog so the UI can
 * overlay real data on the existing rows without renaming anything.
 * latest: { kind: "npm"|"pypi"|"github", ref } — official registries only.
 */
const T = (id, category, opts) => ({ id, category, ...opts });

const TOOLS = [
  // --- languages & runtimes -------------------------------------------------
  T("Node.js LTS", "Languages & Runtimes", {
    cmd: "node",
    args: ["-v"],
    winget: "OpenJS.NodeJS.LTS",
    url: "https://nodejs.org/",
    source: "nodejs.org",
    required: true,
  }),
  T("npm", "Languages & Runtimes", {
    cmd: "npm",
    args: ["-v"],
    url: "https://www.npmjs.com/",
    source: "npmjs.com",
    latest: { kind: "npm", ref: "npm" },
    required: true,
    manual: "ships with Node.js",
  }),
  T("Python", "Languages & Runtimes", {
    cmd: PY,
    args: ["--version"],
    winget: "Python.Python.3.12",
    url: "https://www.python.org/downloads/",
    source: "python.org",
    required: true,
  }),
  T("pip", "Python AI Libraries", {
    cmd: PY,
    args: ["-m", "pip", "--version"],
    url: "https://pip.pypa.io/",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "pip" },
    pip: "pip",
    required: true,
  }),
  T("Bun", "Languages & Runtimes", {
    cmd: "bun",
    args: ["-v"],
    winget: "Oven-sh.Bun",
    url: "https://bun.sh/",
    source: "bun.sh",
    latest: { kind: "github", ref: "oven-sh/bun" },
  }),
  T("pnpm", "Languages & Runtimes", {
    cmd: "pnpm",
    args: ["-v"],
    npm: "pnpm",
    url: "https://pnpm.io/",
    source: "pnpm.io",
    latest: { kind: "npm", ref: "pnpm" },
  }),
  T("Yarn", "Languages & Runtimes", {
    cmd: "yarn",
    args: ["-v"],
    npm: "yarn",
    url: "https://yarnpkg.com/",
    source: "yarnpkg.com",
    latest: { kind: "npm", ref: "yarn" },
  }),
  T("Rust", "Languages & Runtimes", {
    cmd: "rustc",
    args: ["--version"],
    winget: "Rustlang.Rustup",
    url: "https://www.rust-lang.org/tools/install",
    source: "rust-lang.org",
  }),
  T("Go", "Languages & Runtimes", {
    cmd: "go",
    args: ["version"],
    winget: "GoLang.Go",
    url: "https://go.dev/dl/",
    source: "go.dev",
  }),
  T("OpenJDK (Temurin)", "Languages & Runtimes", {
    cmd: "java",
    args: ["-version"],
    winget: "EclipseAdoptium.Temurin.21.JDK",
    url: "https://adoptium.net/",
    source: "adoptium.net",
  }),
  T("Gradle", "Languages & Runtimes", {
    cmd: "gradle",
    args: ["-v"],
    winget: "Gradle.Gradle",
    url: "https://gradle.org/install/",
    source: "gradle.org",
  }),
  T(".NET SDK", "Languages & Runtimes", {
    cmd: "dotnet",
    args: ["--version"],
    winget: "Microsoft.DotNet.SDK.8",
    url: "https://dotnet.microsoft.com/download",
    source: "microsoft.com",
  }),
  T("CMake", "Developer Tools", {
    cmd: "cmake",
    args: ["--version"],
    winget: "Kitware.CMake",
    url: "https://cmake.org/download/",
    source: "cmake.org",
    latest: { kind: "github", ref: "Kitware/CMake" },
  }),
  T("Ninja", "Developer Tools", {
    cmd: "ninja",
    args: ["--version"],
    winget: "Ninja-build.Ninja",
    url: "https://ninja-build.org/",
    source: "ninja-build.org",
    latest: { kind: "github", ref: "ninja-build/ninja" },
  }),
  T("LLVM / Clang", "Developer Tools", {
    cmd: "clang",
    args: ["--version"],
    winget: "LLVM.LLVM",
    url: "https://releases.llvm.org/",
    source: "llvm.org",
  }),
  T("MSYS2", "Developer Tools", {
    cmd: "gcc",
    args: ["--version"],
    winget: "MSYS2.MSYS2",
    url: "https://www.msys2.org/",
    source: "msys2.org",
  }),
  T("VS Build Tools", "Developer Tools", {
    cmd: "cl",
    args: [],
    winget: "Microsoft.VisualStudio.2022.BuildTools",
    // The Visual Studio installer always needs an elevated process.
    elevate: true,
    noVersionProbe: true,
    wingetArgs: [
      "--override",
      "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended",
    ],
    url: "https://visualstudio.microsoft.com/downloads/",
    source: "microsoft.com",
  }),
  T("VC++ Redistributable", "Developer Tools", {
    // Detected by the runtime DLL Windows installs into System32.
    file: WIN
      ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "vcruntime140.dll")
      : null,
    winget: "Microsoft.VCRedist.2015+.x64",
    elevate: true,
    url: "https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist",
    source: "microsoft.com",
  }),

  // --- vcs / shells ---------------------------------------------------------
  T("Git", "Developer Tools", {
    cmd: "git",
    args: ["--version"],
    winget: "Git.Git",
    url: "https://git-scm.com/downloads",
    source: "git-scm.com",
    required: true,
  }),
  T("Git LFS", "Developer Tools", {
    cmd: "git-lfs",
    args: ["--version"],
    winget: "GitHub.GitLFS",
    url: "https://git-lfs.com/",
    source: "git-lfs.com",
    latest: { kind: "github", ref: "git-lfs/git-lfs" },
  }),
  T("GitHub CLI", "Developer Tools", {
    cmd: "gh",
    args: ["--version"],
    winget: "GitHub.cli",
    url: "https://cli.github.com/",
    source: "cli.github.com",
    latest: { kind: "github", ref: "cli/cli" },
  }),
  T("PowerShell 7", "Automation", {
    cmd: "pwsh",
    args: ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"],
    winget: "Microsoft.PowerShell",
    url: "https://github.com/PowerShell/PowerShell",
    source: "microsoft.com",
    latest: { kind: "github", ref: "PowerShell/PowerShell" },
  }),
  T("Windows Terminal", "Developer Tools", {
    // `wt --version` is a GUI app alias: running it pops a native modal dialog
    // that steals focus from FRIDAY. Presence-only detection instead.
    cmd: "wt",
    noVersionProbe: true,
    winget: "Microsoft.WindowsTerminal",
    url: "https://aka.ms/terminal",
    source: "microsoft.com",
  }),
  T("Visual Studio Code", "Developer Tools", {
    cmd: "code",
    args: ["--version"],
    winget: "Microsoft.VisualStudioCode",
    url: "https://code.visualstudio.com/",
    source: "code.visualstudio.com",
  }),

  // --- AI runtimes ----------------------------------------------------------
  T("Ollama", "AI Runtimes", {
    cmd: "ollama",
    args: ["--version"],
    winget: "Ollama.Ollama",
    url: "https://ollama.com/download",
    source: "ollama.com",
    latest: { kind: "github", ref: "ollama/ollama" },
    service: "http://127.0.0.1:11434/api/tags",
  }),
  T("llama.cpp", "AI Runtimes", {
    cmd: "llama-server",
    args: ["--version"],
    winget: "ggml.llamacpp",
    url: "https://github.com/ggml-org/llama.cpp",
    source: "github.com/ggml-org",
    latest: { kind: "github", ref: "ggml-org/llama.cpp" },
  }),

  T("LM Studio", "AI Runtimes", {
    cmd: "lms",
    args: ["version"],
    winget: "ElementLabs.LMStudio",
    url: "https://lmstudio.ai/",
    source: "lmstudio.ai",
    // The desktop app registers `lms` only after its first launch, so a fresh
    // winget install is verified through the winget package list instead.
    noVersionProbe: false,
  }),
  T("LocalAI", "AI Runtimes", {
    cmd: "local-ai",
    args: ["--help"],
    url: "https://localai.io/docs/getting-started/",
    source: "localai.io",
    latest: { kind: "github", ref: "mudler/LocalAI" },
    service: "http://127.0.0.1:8081/v1/models",
    // Native Windows EXE is not in vendor docs (Docker is). Linux/macOS have
    // `local-ai run`. Never report a fake winget install.
    ...(WIN
      ? {
          manual:
            "LocalAI has no native Windows EXE in the vendor docs (Docker or a local-ai binary on PATH). FRIDAY starts `local-ai run --address 127.0.0.1:8081` when that binary exists.",
        }
      : {}),
  }),
  T("Jan", "AI Runtimes", {
    cmd: "jan",
    args: ["help"],
    winget: "Jan.Jan",
    url: "https://jan.ai/",
    source: "jan.ai",
    latest: { kind: "github", ref: "janhq/jan" },
    service: "http://127.0.0.1:1337/v1/models",
  }),
  ...(process.platform === "darwin"
    ? [
        T("MLX-LM", "AI Runtimes", {
          cmd: "mlx_lm.server",
          args: ["--help"],
          pipDist: "mlx-lm",
          pip: "mlx-lm",
          pipImport: "mlx_lm",
          url: "https://pypi.org/project/mlx-lm/",
          source: "pypi.org",
          latest: { kind: "pypi", ref: "mlx-lm" },
        }),
      ]
    : []),

  // --- GPU ------------------------------------------------------------------
  T("NVIDIA Driver", "GPU Support", {
    cmd: "nvidia-smi",
    args: ["--query-gpu=driver_version", "--format=csv,noheader"],
    url: "https://www.nvidia.com/Download/index.aspx",
    source: "nvidia.com",
    manual: "install via GeForce Experience or the NVIDIA driver package",
  }),
  T("CUDA Toolkit", "GPU Support", {
    cmd: "nvcc",
    args: ["--version"],
    winget: "Nvidia.CUDA",
    elevate: true,
    url: "https://developer.nvidia.com/cuda-downloads",
    source: "developer.nvidia.com",
  }),
  T("PyTorch (CUDA)", "GPU Support", {
    // Real CUDA wheels come from the official PyTorch index, not plain PyPI.
    pipDist: "torch",
    pip: "torch",
    pipIndex: "https://download.pytorch.org/whl/cu121",
    url: "https://pytorch.org/get-started/locally/",
    source: "download.pytorch.org",
    latest: { kind: "pypi", ref: "torch" },
  }),

  // --- python libraries -----------------------------------------------------
  ...[
    ["PyYAML (YAML)", "PyYAML"],
    ["Whisper", "openai-whisper"],
    ["OpenCV (Python)", "opencv-python"],
    ["Playwright", "playwright"],
  ].map(([id, dist]) =>
    T(id, "Python AI Libraries", {
      pipDist: dist,
      pip: dist,
      url: `https://pypi.org/project/${dist}/`,
      source: "pypi.org",
      latest: { kind: "pypi", ref: dist },
    }),
  ),

  // --- device control (cable / Bluetooth / WiFi) ---------------------------
  T("Android Platform Tools (adb)", "Device Control", {
    cmd: "adb",
    args: ["version"],
    winget: "Google.PlatformTools",
    url: "https://developer.android.com/tools/releases/platform-tools",
    source: "developer.android.com",
  }),
  T("Android SDK cmdline-tools", "Languages & Runtimes", {
    cmd: "sdkmanager",
    args: ["--version"],
    url: "https://developer.android.com/studio#command-line-tools-only",
    source: "developer.android.com",
    manual: "Official command-line tools only — not a second Android Studio inside FRIDAY.",
  }),
  T("scrcpy (phone screen mirroring)", "Device Control", {
    cmd: "scrcpy",
    args: ["--version"],
    winget: "Genymobile.scrcpy",
    url: "https://github.com/Genymobile/scrcpy",
    source: "github.com/Genymobile",
    latest: { kind: "github", ref: "Genymobile/scrcpy" },
  }),
  // electron/remote-access.cjs probes for this binary to offer the phone
  // companion off-LAN; without a catalog row the owner could see "Tailscale is
  // not installed" with no way to install it from inside FRIDAY.
  T("Tailscale", "Device Control", {
    cmd: "tailscale",
    args: ["version"],
    winget: "tailscale.tailscale",
    url: "https://tailscale.com/download/windows",
    source: "tailscale.com",
    latest: { kind: "github", ref: "tailscale/tailscale" },
  }),
  T("bleak (Bluetooth LE)", "Device Control", {
    pipDist: "bleak",
    pip: "bleak",
    url: "https://github.com/hbldh/bleak",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "bleak" },
  }),
  T("zeroconf (mDNS discovery)", "Device Control", {
    pipDist: "zeroconf",
    pip: "zeroconf",
    url: "https://github.com/python-zeroconf/python-zeroconf",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "zeroconf" },
  }),

  // --- media / containers / db ---------------------------------------------
  T("FFmpeg", "Media Tools", {
    cmd: "ffmpeg",
    args: ["-version"],
    winget: "Gyan.FFmpeg",
    url: "https://ffmpeg.org/download.html",
    source: "ffmpeg.org",
  }),
  T("7-Zip", "Media Tools", {
    cmd: "7z",
    args: ["i"],
    winget: "7zip.7zip",
    url: "https://www.7-zip.org/",
    source: "7-zip.org",
  }),
  T("Tesseract OCR", "Computer Vision", {
    cmd: "tesseract",
    args: ["--version"],
    winget: "UB-Mannheim.TesseractOCR",
    url: "https://github.com/UB-Mannheim/tesseract/wiki",
    source: "github.com/UB-Mannheim",
    installerUrl:
      "https://github.com/UB-Mannheim/tesseract/releases/download/v5.4.0.20240606/tesseract-ocr-w64-setup-5.4.0.20240606.exe",
    sha256: "c885fff6998e0608ba4bb8ab51436e1c6775c2bafc2559a19b423e18678b60c9",
    needBytes: 50175248,
  }),
  T("Docker Desktop", "Developer Tools", {
    cmd: "docker",
    args: ["--version"],
    winget: "Docker.DockerDesktop",
    url: "https://www.docker.com/products/docker-desktop/",
    source: "docker.com",
  }),
  T("Podman", "Developer Tools", {
    cmd: "podman",
    args: ["--version"],
    winget: "RedHat.Podman",
    url: "https://podman.io/",
    source: "podman.io",
    latest: { kind: "github", ref: "containers/podman" },
  }),
  T("Sandboxie-Plus", "Developer Tools", {
    cmd: "Start.exe",
    args: ["/box:DefaultBox", "/terminate_all"],
    winget: "Sandboxie.Plus",
    url: "https://sandboxie-plus.com/",
    source: "sandboxie-plus.com",
    latest: { kind: "github", ref: "sandboxie-plus/Sandboxie" },
  }),
  T("QEMU", "Developer Tools", {
    cmd: "qemu-system-x86_64",
    args: ["--version"],
    winget: "SoftwareFreedomConservancy.QEMU",
    url: "https://www.qemu.org/",
    source: "qemu.org",
  }),
  T("Docker Compose", "Developer Tools", {
    cmd: "docker",
    args: ["compose", "version"],
    url: "https://docs.docker.com/compose/",
    source: "docker.com",
    manual: "bundled with Docker Desktop",
  }),
  T("SQLite", "Databases", {
    cmd: "sqlite3",
    args: ["--version"],
    winget: "SQLite.SQLite",
    url: "https://www.sqlite.org/download.html",
    source: "sqlite.org",
  }),
  T("SQLite (engine)", "Databases", {
    pythonStdlib: "sqlite3",
    builtin: true,
    url: "https://docs.python.org/3/library/sqlite3.html",
    source: "Python standard library",
    manual: "bundled with Python",
  }),
  T("JSON workflow engine", "Automation", {
    pythonStdlib: "json",
    builtin: true,
    url: "https://docs.python.org/3/library/json.html",
    source: "FRIDAY kernel",
    manual: "bundled with Python",
  }),
  T("YAML workflow engine", "Automation", {
    pipDist: "PyYAML",
    pip: "PyYAML",
    url: "https://pyyaml.org/",
    source: "FRIDAY kernel",
  }),
  T("Cron scheduler", "Automation", {
    // FRIDAY schedules work through the operating system scheduler, which is
    // always present — there is nothing to download.
    cmd: WIN ? "schtasks" : "crontab",
    noVersionProbe: true,
    builtin: true,
    url: WIN
      ? "https://learn.microsoft.com/windows-server/administration/windows-commands/schtasks"
      : "https://man7.org/linux/man-pages/man5/crontab.5.html",
    source: WIN ? "Windows Task Scheduler" : "cron",
    manual: "built into the operating system — no install required",
  }),

  T("n8n", "Automation", {
    cmd: "n8n",
    args: ["--version"],
    npm: "n8n",
    url: "https://n8n.io/",
    source: "npmjs.com",
    latest: { kind: "npm", ref: "n8n" },
  }),
  T("WSL 2", "Developer Tools", {
    cmd: "wsl",
    args: ["--version"],
    url: "https://learn.microsoft.com/windows/wsl/install",
    source: "microsoft.com",
    manual: "run `wsl --install` in an elevated terminal",
  }),

  // --- FRIDAY build & packaging toolchain -----------------------------------
  T("Electron", "Languages & Runtimes", {
    cmd: "electron",
    args: ["--version"],
    npm: "electron",
    url: "https://www.electronjs.org/",
    source: "npmjs.com",
    latest: { kind: "npm", ref: "electron" },
    manual: "bundled with FRIDAY — install globally only for development",
  }),
  T("Windows SDK", "Developer Tools", {
    cmd: "signtool",
    args: [],
    winget: "Microsoft.WindowsSDK.10.0.22621",
    url: "https://developer.microsoft.com/windows/downloads/windows-sdk/",
    source: "microsoft.com",
    noVersionProbe: true,
  }),
  T("jq (JSON)", "Developer Tools", {
    cmd: "jq",
    args: ["--version"],
    winget: "jqlang.jq",
    url: "https://jqlang.github.io/jq/",
    source: "jqlang.github.io",
    latest: { kind: "github", ref: "jqlang/jq" },
  }),
  T("yq (YAML)", "Developer Tools", {
    cmd: "yq",
    args: ["--version"],
    winget: "MikeFarah.yq",
    url: "https://github.com/mikefarah/yq",
    source: "github.com/mikefarah",
    latest: { kind: "github", ref: "mikefarah/yq" },
  }),

  // --- additional runtimes, engines, databases and sandboxing ---------------
  T("Deno", "Languages & Runtimes", {
    cmd: "deno",
    args: ["-V"],
    winget: "DenoLand.Deno",
    url: "https://deno.com/",
    source: "deno.com",
    latest: { kind: "github", ref: "denoland/deno" },
  }),
  T("uv (Python)", "Languages & Runtimes", {
    cmd: "uv",
    args: ["--version"],
    winget: "astral-sh.uv",
    url: "https://docs.astral.sh/uv/",
    source: "astral.sh",
    latest: { kind: "github", ref: "astral-sh/uv" },
  }),
  T("vLLM", "AI Runtimes", {
    pipDist: "vllm",
    pip: "vllm",
    url: "https://docs.vllm.ai/",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "vllm" },
  }),
  T("Text Generation WebUI (llama-cpp-python)", "AI Runtimes", {
    pipDist: "llama-cpp-python",
    pip: "llama-cpp-python",
    pipImport: "llama_cpp",
    strategy: llamaCppStrategy,
    url: "https://github.com/abetlen/llama-cpp-python",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "llama-cpp-python" },
  }),
  T("Hugging Face CLI", "AI Runtimes", {
    cmd: "hf",
    args: ["version"],
    detect: detectHuggingFace,
    pipDist: "huggingface-hub",
    pip: "huggingface_hub",
    pipImport: "huggingface_hub",
    url: "https://huggingface.co/docs/huggingface_hub",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "huggingface-hub" },
  }),

  T("cuDNN", "GPU Support", {
    pipDist: "nvidia-cudnn-cu12",
    pip: "nvidia-cudnn-cu12",
    url: "https://developer.nvidia.com/cudnn",
    source: "developer.nvidia.com",
    latest: { kind: "pypi", ref: "nvidia-cudnn-cu12" },
  }),
  T("ONNX Runtime (GPU)", "GPU Support", {
    pipDist: "onnxruntime-gpu",
    pip: "onnxruntime-gpu",
    url: "https://onnxruntime.ai/",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "onnxruntime-gpu" },
  }),
  // n8n is defined once, above, in the Automation group.

  T("PostgreSQL", "Databases", {
    cmd: "psql",
    args: ["--version"],
    winget: "PostgreSQL.PostgreSQL.16",
    url: "https://www.postgresql.org/download/windows/",
    source: "postgresql.org",
  }),
  T("Redis (Memurai)", "Databases", {
    cmd: "redis-cli",
    args: ["--version"],
    winget: "Memurai.MemuraiDeveloper",
    url: "https://www.memurai.com/",
    source: "memurai.com",
  }),
  T("DuckDB", "Databases", {
    cmd: "duckdb",
    args: ["--version"],
    winget: "DuckDB.cli",
    url: "https://duckdb.org/",
    source: "duckdb.org",
    latest: { kind: "github", ref: "duckdb/duckdb" },
  }),
  T("Qdrant (client)", "Vector Databases", {
    pipDist: "qdrant-client",
    pip: "qdrant-client",
    url: "https://qdrant.tech/",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "qdrant-client" },
  }),
  T("FAISS", "Vector Databases", {
    pipDist: "faiss-cpu",
    pip: "faiss-cpu",
    url: "https://faiss.ai/",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "faiss-cpu" },
  }),
  T("LanceDB", "Vector Databases", {
    pipDist: "lancedb",
    pip: "lancedb",
    url: "https://lancedb.com/",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "lancedb" },
  }),
  T("Piper TTS", "Voice", {
    pipDist: "piper-tts",
    pip: "piper-tts",
    url: "https://github.com/rhasspy/piper",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "piper-tts" },
    manual:
      "Current PyPI piper-tts is GPL-3.0-or-later. FRIDAY does not install it for the voice runtime.",
  }),
  T("faster-whisper", "Voice", {
    pipDist: "faster-whisper",
    pip: "faster-whisper",
    url: "https://github.com/SYSTRAN/faster-whisper",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "faster-whisper" },
  }),
  T("supertonic", "Voice", {
    pipDist: "supertonic",
    pip: "supertonic",
    url: "https://pypi.org/project/supertonic/",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "supertonic" },
    manual:
      "Code is MIT. Supertonic 3 weights are OpenRAIL-M and download on demand. They are not bundled in the EXE.",
  }),
  T("moonshine-voice", "Voice", {
    pipDist: "moonshine-voice",
    pip: "moonshine-voice",
    url: "https://pypi.org/project/moonshine-voice/",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "moonshine-voice" },
    manual:
      "MIT package. Only the English streaming weights are downloaded. Non-English Moonshine weights are not used.",
  }),
  T("pyrnnoise", "Voice", {
    pipDist: "pyrnnoise",
    pip: "pyrnnoise",
    url: "https://pypi.org/project/pyrnnoise/",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "pyrnnoise" },
  }),
  T("ONNX DirectML", "Voice", {
    url: "https://pypi.org/project/onnxruntime-directml/",
    source: "pypi.org",
    manual:
      "Windows only. Installing onnxruntime-directml replaces the CPU onnxruntime wheel, so FRIDAY does not install it from requirements. CPUExecutionProvider stays the fallback.",
  }),
  T("Playwright browsers", "Web Automation", {
    cmd: PY,
    args: ["-m", "playwright", "--version"],
    url: "https://playwright.dev/python/",
    source: "pypi.org",
    manual: "run `python -m playwright install chromium` after installing Playwright",
  }),
  T("Sandbox runner (Windows Sandbox)", "Developer Tools", {
    cmd: "WindowsSandbox",
    detect: detectWindowsSandbox,
    optionalFeature: true,
    // The Isolation Engines panel already knows how to enable this feature
    // (DISM + elevation + restart tracking); the Install Queue reuses it
    // instead of falling back to a misleading "open the vendor page".
    engineId: "windows-sandbox",
    noVersionProbe: true,
    url: "https://learn.microsoft.com/windows/security/application-security/application-isolation/windows-sandbox/",
    source: "microsoft.com",
    manual: "enable the Windows Sandbox optional feature (Windows Pro/Enterprise)",
  }),

  // --- packaging & release (what "Build EXE" actually needs) ----------------
  T("NSIS", "Build & Packaging", {
    cmd: "makensis",
    args: ["/VERSION"],
    winget: "NSIS.NSIS",
    url: "https://nsis.sourceforge.io/",
    source: "nsis.sourceforge.io",
    manual: "electron-builder downloads its own copy; install this for offline builds",
  }),
  T("electron-builder", "Build & Packaging", {
    cmd: "electron-builder",
    args: ["--version"],
    npm: "electron-builder",
    url: "https://www.electron.build/",
    source: "npmjs.com",
    latest: { kind: "npm", ref: "electron-builder" },
  }),
  T("rcedit", "Build & Packaging", {
    cmd: "rcedit",
    args: ["--help"],
    npm: "rcedit",
    detect: detectRcedit,
    noVersionProbe: true,
    url: "https://github.com/electron/rcedit",
    source: "npmjs.com",
    latest: { kind: "npm", ref: "rcedit" },
  }),

  T("TypeScript", "Build & Packaging", {
    cmd: "tsc",
    args: ["-v"],
    npm: "typescript",
    url: "https://www.typescriptlang.org/",
    source: "npmjs.com",
    latest: { kind: "npm", ref: "typescript" },
  }),
  T("WebView2 Runtime", "Windows Integration", {
    winget: "Microsoft.EdgeWebView2Runtime",
    detect: detectWebView2,
    // Official Microsoft bootstrapper — the docs page is not an installer.
    installerUrl: "https://go.microsoft.com/fwlink/p/?LinkId=2124703",
    installerArgs: ["/silent", "/install"],
    noVersionProbe: true,
    url: "https://developer.microsoft.com/microsoft-edge/webview2/",
    source: "microsoft.com",
  }),

  T("aria2", "Developer Tools", {
    cmd: "aria2c",
    args: ["--version"],
    winget: "aria2.aria2",
    url: "https://aria2.github.io/",
    source: "aria2.github.io",
    manual: "used for fast, resumable model downloads",
  }),
  T("ripgrep", "Developer Tools", {
    cmd: "rg",
    args: ["--version"],
    winget: "BurntSushi.ripgrep.MSVC",
    url: "https://github.com/BurntSushi/ripgrep",
    source: "github.com",
    latest: { kind: "github", ref: "BurntSushi/ripgrep" },
  }),
  // --- code quality: what the self-development pipeline needs to lint, format,
  // type-check and test real code before it is ever applied -------------------
  T("ESLint", "Developer Tools", {
    cmd: "eslint",
    args: ["--version"],
    npm: "eslint",
    url: "https://eslint.org/",
    source: "npmjs.com",
    latest: { kind: "npm", ref: "eslint" },
    manual: "used by the self-development pipeline to lint JS/TS before applying a change",
  }),
  T("Prettier", "Developer Tools", {
    cmd: "prettier",
    args: ["--version"],
    npm: "prettier",
    url: "https://prettier.io/",
    source: "npmjs.com",
    latest: { kind: "npm", ref: "prettier" },
  }),
  T("Vitest", "Developer Tools", {
    cmd: "vitest",
    args: ["--version"],
    npm: "vitest",
    url: "https://vitest.dev/",
    source: "npmjs.com",
    latest: { kind: "npm", ref: "vitest" },
    manual: "the test runner this repository already uses for its own suite",
  }),
  T("Ruff", "Developer Tools", {
    cmd: "ruff",
    args: ["--version"],
    pipDist: "ruff",
    pip: "ruff",
    url: "https://docs.astral.sh/ruff/",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "ruff" },
    manual: "Python linter used to check the kernel before a change is applied",
  }),
  T("Black", "Developer Tools", {
    cmd: "black",
    args: ["--version"],
    pipDist: "black",
    pip: "black",
    url: "https://black.readthedocs.io/",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "black" },
  }),
  T("mypy", "Developer Tools", {
    cmd: "mypy",
    args: ["--version"],
    pipDist: "mypy",
    pip: "mypy",
    url: "https://mypy-lang.org/",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "mypy" },
  }),
  T("pytest", "Developer Tools", {
    cmd: "pytest",
    args: ["--version"],
    pipDist: "pytest",
    pip: "pytest",
    url: "https://docs.pytest.org/",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "pytest" },
    manual: "runs kernel/tests — the Python half of FRIDAY's own verification",
  }),
  T("git-delta (diff viewer)", "Developer Tools", {
    cmd: "delta",
    args: ["--version"],
    winget: "dandavison.delta",
    url: "https://github.com/dandavison/delta",
    source: "github.com",
    latest: { kind: "github", ref: "dandavison/delta" },
    manual: "readable diffs for self-development reviews; patches are applied with `git apply`",
  }),

  T("Pandoc", "Developer Tools", {
    cmd: "pandoc",
    args: ["--version"],
    winget: "JohnMacFarlane.Pandoc",
    url: "https://pandoc.org/",
    source: "pandoc.org",
  }),
  T("Graphviz", "Developer Tools", {
    cmd: "dot",
    args: ["-V"],
    winget: "Graphviz.Graphviz",
    url: "https://graphviz.org/",
    source: "graphviz.org",
    installerUrl:
      "https://gitlab.com/api/v4/projects/4207231/packages/generic/graphviz-releases/16.1.0/windows_10_cmake_Release_graphviz-install-16.1.0-win64.exe",
    sha256: "46f3b8b412a79915cf8e08bdce6542401bd9efca98ce282f3c5c5b56211e1761",
    needBytes: 8070590,
    installerArgs: ["/S"],
  }),
  T("D2", "Developer Tools", {
    cmd: "d2",
    args: ["--version"],
    url: "https://github.com/terrastruct/d2",
    source: "github.com",
    installerUrl:
      "https://github.com/terrastruct/d2/releases/download/v0.9.0/d2-v0.9.0-windows-amd64.msi",
    sha256: "dbac13edaec26878d36c79c2bcd91d57927cae8878204e3b9816e6c0f32aae1b",
    needBytes: 15527936,
  }),

  // --- Windows control & awareness (agents, tools, screen vision) -----------
  T("pywin32", "Windows Integration", {
    pipDist: "pywin32",
    pip: "pywin32",
    url: "https://github.com/mhammond/pywin32",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "pywin32" },
  }),
  T("psutil", "Windows Integration", {
    pipDist: "psutil",
    pip: "psutil",
    url: "https://github.com/giampaolo/psutil",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "psutil" },
  }),
  T("PyAutoGUI", "Windows Integration", {
    pipDist: "PyAutoGUI",
    pip: "pyautogui",
    url: "https://pyautogui.readthedocs.io/",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "pyautogui" },
  }),
  T("mss (screen capture)", "Windows Integration", {
    pipDist: "mss",
    pip: "mss",
    url: "https://python-mss.readthedocs.io/",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "mss" },
  }),
  T("watchdog (file watcher)", "Windows Integration", {
    pipDist: "watchdog",
    pip: "watchdog",
    url: "https://github.com/gorakhargosh/watchdog",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "watchdog" },
  }),
  T("pytesseract", "Windows Integration", {
    pipDist: "pytesseract",
    pip: "pytesseract",
    url: "https://github.com/madmaze/pytesseract",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "pytesseract" },
    manual: "needs the Tesseract OCR engine as well",
  }),

  // --- voice ----------------------------------------------------------------
  T("edge-tts", "Voice", {
    pipDist: "edge-tts",
    pip: "edge-tts",
    url: "https://github.com/rany2/edge-tts",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "edge-tts" },
  }),
  T("Azure Speech SDK", "Voice", {
    pipDist: "azure-cognitiveservices-speech",
    pip: "azure-cognitiveservices-speech",
    url: "https://learn.microsoft.com/azure/ai-services/speech-service/",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "azure-cognitiveservices-speech" },
    manual: "required for the hi-IN Swara neural voice",
  }),
  T("sounddevice", "Voice", {
    pipDist: "sounddevice",
    pip: "sounddevice",
    url: "https://python-sounddevice.readthedocs.io/",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "sounddevice" },
  }),
  T("openWakeWord", "Voice", {
    pipDist: "openwakeword",
    pip: "openwakeword",
    url: "https://github.com/dscripka/openWakeWord",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "openwakeword" },
  }),

  // --- brain, memory & models ----------------------------------------------
  T("transformers", "Python AI Libraries", {
    pipDist: "transformers",
    pip: "transformers",
    url: "https://huggingface.co/docs/transformers",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "transformers" },
  }),
  T("sentence-transformers", "Python AI Libraries", {
    pipDist: "sentence-transformers",
    pip: "sentence-transformers",
    url: "https://www.sbert.net/",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "sentence-transformers" },
    manual: "powers FRIDAY's local memory embeddings",
  }),
  T("accelerate", "Python AI Libraries", {
    pipDist: "accelerate",
    pip: "accelerate",
    url: "https://huggingface.co/docs/accelerate",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "accelerate" },
  }),
  T("chromadb", "Databases & Memory", {
    pipDist: "chromadb",
    pip: "chromadb",
    url: "https://www.trychroma.com/",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "chromadb" },
  }),
  T("openai (SDK)", "Python AI Libraries", {
    pipDist: "openai",
    pip: "openai",
    url: "https://github.com/openai/openai-python",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "openai" },
  }),
  T("anthropic (SDK)", "Python AI Libraries", {
    pipDist: "anthropic",
    pip: "anthropic",
    url: "https://github.com/anthropics/anthropic-sdk-python",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "anthropic" },
  }),

  /* ---------------------------------------------------------------------
   * Catalog-backed components. Every row the Install Manager catalog offers
   * needs a real detector and a real install command here, otherwise the row
   * can only ever report "Unknown" and its buttons fail with "unknown
   * package". These use the same pip/npm/winget pattern as everything above.
   * ------------------------------------------------------------------- */
  ...[
    ["FastAPI", "fastapi", "fastapi"],
    ["Uvicorn", "uvicorn", "uvicorn"],
    ["Pydantic", "pydantic", "pydantic"],
    ["NumPy", "numpy", "numpy"],
    ["SciPy", "scipy", "scipy"],
    ["Pandas", "pandas", "pandas"],
    ["Pillow", "pillow", "pillow"],
    ["LangChain", "langchain", "langchain"],
    ["Requests", "requests", "requests"],
    ["HTTPX", "httpx", "httpx"],
    ["BeautifulSoup", "beautifulsoup4", "beautifulsoup4"],
    ["lxml (XML/HTML)", "lxml", "lxml"],
    ["PyMuPDF (PDF)", "pymupdf", "pymupdf"],
    ["openpyxl (XLSX)", "openpyxl", "openpyxl"],
    ["python-docx (DOCX)", "python-docx", "python-docx"],
    ["python-pptx (PPTX)", "python-pptx", "python-pptx"],
    ["Scrapy", "scrapy", "scrapy"],
    ["GGUF", "gguf", "gguf"],
    ["virtualenv", "virtualenv", "virtualenv"],
    ["Diffusers", "diffusers", "diffusers"],
    // Required by kernel/finetune_lora.py — LoRA/QLoRA training set loader.
    ["datasets", "datasets", "datasets"],
    ["PEFT", "peft", "peft"],
    ["BitsAndBytes", "bitsandbytes", "bitsandbytes"],
    ["AutoGPTQ", "auto-gptq", "auto-gptq"],
    ["TensorFlow", "tensorflow", "tensorflow"],
    ["LlamaIndex", "llama-index", "llama-index"],
    ["Milvus", "pymilvus", "pymilvus"],
    ["PyAV", "av", "av"],
    ["markitdown (MD/HTML)", "markitdown", "markitdown"],
    ["py7zr (7Z)", "py7zr", "py7zr"],
    ["pyzbar (barcodes)", "pyzbar", "pyzbar"],
    ["qrcode", "qrcode", "qrcode"],
    ["rarfile (RAR)", "rarfile", "rarfile"],
    ["ffmpeg-python", "ffmpeg-python", "ffmpeg-python"],
  ].map(([id, dist, pip]) =>
    T(id, "Python AI Libraries", {
      pipDist: dist,
      pip,
      url: `https://pypi.org/project/${dist}/`,
      source: "pypi.org",
      latest: { kind: "pypi", ref: dist },
    }),
  ),
  T("ONNX Runtime", "AI Runtimes", {
    pipDist: "onnxruntime",
    pip: "onnxruntime",
    url: "https://onnxruntime.ai/",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "onnxruntime" },
  }),
  T("Intel OpenVINO", "GPU Support", {
    pipDist: "openvino",
    pip: "openvino",
    url: "https://docs.openvino.ai/",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "openvino" },
  }),
  T("DirectML", "GPU Support", {
    pipDist: "torch-directml",
    pip: "torch-directml",
    url: "https://learn.microsoft.com/windows/ai/directml/dml",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "torch-directml" },
  }),
  T("YOLO (Ultralytics)", "Computer Vision", {
    pipDist: "ultralytics",
    pip: "ultralytics",
    url: "https://docs.ultralytics.com/",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "ultralytics" },
  }),
  T("Vosk", "Voice", {
    pipDist: "vosk",
    pip: "vosk",
    url: "https://alphacephei.com/vosk/",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "vosk" },
  }),
  T("Coqui TTS", "Voice", {
    pipDist: "coqui-tts",
    pip: "coqui-tts",
    url: "https://pypi.org/project/coqui-tts/",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "coqui-tts" },
  }),
  T("SpeechRecognition", "Voice", {
    pipDist: "SpeechRecognition",
    pip: "SpeechRecognition",
    url: "https://pypi.org/project/SpeechRecognition/",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "SpeechRecognition" },
  }),
  T("Selenium", "Web Automation", {
    pipDist: "selenium",
    pip: "selenium",
    url: "https://www.selenium.dev/",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "selenium" },
  }),
  T("Node-RED", "Automation", {
    cmd: "node-red",
    npm: "node-red",
    url: "https://nodered.org/",
    source: "npmjs.com",
    latest: { kind: "npm", ref: "node-red" },
  }),
  T("ImageMagick", "Media Tools", {
    cmd: "magick",
    winget: "ImageMagick.ImageMagick",
    url: "https://imagemagick.org/",
    source: "imagemagick.org",
  }),
  T("Android Studio", "Developer Tools", {
    winget: "Google.AndroidStudio",
    url: "https://developer.android.com/studio",
    source: "developer.android.com",
  }),
  T("Visual Studio", "Developer Tools", {
    winget: "Microsoft.VisualStudio.2022.Community",
    url: "https://visualstudio.microsoft.com/downloads/",
    source: "visualstudio.microsoft.com",
  }),
  T("MongoDB", "Databases", {
    cmd: "mongod",
    winget: "MongoDB.Server",
    url: "https://www.mongodb.com/try/download/community",
    source: "mongodb.com",
  }),
  T("MySQL", "Databases", {
    cmd: "mysql",
    winget: "Oracle.MySQL",
    url: "https://dev.mysql.com/downloads/",
    source: "mysql.com",
  }),
  T("MariaDB", "Databases", {
    cmd: "mariadb",
    winget: "MariaDB.Server",
    url: "https://mariadb.org/download/",
    source: "mariadb.org",
  }),
  T("Whisper.cpp", "AI Runtimes", {
    cmd: "whisper-cli",
    url: "https://github.com/ggml-org/whisper.cpp",
    source: "github.com/ggml-org",
    latest: { kind: "github", ref: "ggml-org/whisper.cpp" },
    manual: "build from the whisper.cpp repository — no unattended Windows package",
  }),
  T("AMD ROCm", "GPU Support", {
    cmd: "rocminfo",
    url: "https://www.amd.com/en/products/software/rocm.html",
    source: "amd.com",
    manual: "ROCm ships as an AMD vendor installer for supported hardware only",
  }),
  T("OpenCL Runtime", "GPU Support", {
    file: WIN ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "OpenCL.dll") : null,
    builtin: true,
    url: "https://www.khronos.org/opencl/",
    source: "GPU driver",
  }),
  T("TensorRT", "GPU Support", {
    pipDist: "tensorrt",
    pip: "tensorrt",
    url: "https://developer.nvidia.com/tensorrt",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "tensorrt" },
  }),
  T("Segment Anything", "Computer Vision", {
    pipDist: "segment-anything-py",
    pip: "segment-anything-py",
    url: "https://github.com/facebookresearch/segment-anything",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "segment-anything-py" },
  }),
  T("MCP server/client", "Automation", {
    pipDist: "mcp",
    pip: "mcp",
    url: "https://modelcontextprotocol.io/",
    source: "pypi.org",
    latest: { kind: "pypi", ref: "mcp" },
  }),
];

/**
 * Catalog rows whose display name differs from the real component id above.
 * One component, one installer — the alias keeps the UI name working without
 * a second, duplicate tool definition.
 */
const CATALOG_ALIAS = new Map([
  ["OpenCV", "OpenCV (Python)"],
  ["Accelerate", "accelerate"],
  ["Transformers", "transformers"],
  ["SentenceTransformers", "sentence-transformers"],
  ["ChromaDB", "chromadb"],
  ["uv", "uv (Python)"],
  ["Qdrant", "Qdrant (client)"],
  ["Redis", "Redis (Memurai)"],
  ["Redis (server)", "Redis (Memurai)"],
  ["PostgreSQL + pgvector", "PostgreSQL"],
  ["Android SDK + ADB", "Android Platform Tools (adb)"],
  ["Tesseract OCR engine", "Tesseract OCR"],
]);

/** Catalog names a real component answers for (one component, many rows). */
const DISPLAY_IDS = new Map();
for (const [shown, real] of CATALOG_ALIAS) {
  DISPLAY_IDS.set(real, [...(DISPLAY_IDS.get(real) || []), shown]);
}

const TOOL_BY_ID = new Map(TOOLS.map((t) => [t.id, t]));

/** Resolve either the real component id or the catalog display name. */
function toolById(id) {
  return TOOL_BY_ID.get(id) || TOOL_BY_ID.get(CATALOG_ALIAS.get(id)) || null;
}

/* ---------------------------------------------------------------- detection */

let pipFreeze = { at: 0, map: new Map() };
let wingetList = { at: 0, text: "" };

async function loadWingetList(force = false) {
  if (!WIN) return "";
  if (!force && Date.now() - wingetList.at < 30_000) return wingetList.text;
  const text =
    (await run(
      "winget",
      ["list", "--accept-source-agreements", "--disable-interactivity"],
      30_000,
    )) || "";
  wingetList = { at: Date.now(), text };
  return text;
}

function wingetPackage(tool, text) {
  if (!tool.winget || !text) return null;
  const line = text.split(/\r?\n/).find((candidate) => {
    const at = candidate.indexOf(tool.winget);
    if (at < 0) return false;
    const next = candidate[at + tool.winget.length];
    return !next || /\s/.test(next);
  });
  if (!line) return null;
  const tail = line.slice(line.indexOf(tool.winget) + tool.winget.length).trim();
  return { version: semver(tail) || null, path: "installed Windows package" };
}

async function loadPipFreeze(force = false) {
  if (!force && Date.now() - pipFreeze.at < 30_000) return pipFreeze.map;
  const python = await resolvePython(path.join(__dirname, ".."));
  const out = python
    ? await run(python.exe, [...python.prefix, "-m", "pip", "list", "--format=freeze"], 25_000)
    : null;
  const map = new Map();
  if (out) {
    out.split(/\r?\n/).forEach((line) => {
      const [name, version] = line.split("==");
      if (name && version) map.set(name.trim().toLowerCase(), version.trim());
    });
  }
  pipFreeze = { at: Date.now(), map };
  return map;
}

async function probeTool(tool, freeze, installedPackages = "") {
  // Components with a real machine-level detector (registry, optional Windows
  // feature, packaged executable) decide their own state.
  if (typeof tool.detect === "function") {
    let found = null;
    try {
      found = await tool.detect();
    } catch (err) {
      found = { installed: false, status: "Error", note: String(err && err.message) };
    }
    return {
      id: tool.id,
      category: tool.category,
      installed: Boolean(found.installed),
      version: found.version || null,
      path: found.path || null,
      source: tool.source,
      url: tool.url,
      manager: tool.winget ? "winget" : tool.npm ? "npm" : tool.pip ? "pip" : "vendor",
      required: Boolean(tool.required),
      manual: found.manual || tool.manual || null,
      status: found.status || (found.installed ? "Ready" : "Missing"),
      ...(found.note ? { note: found.note } : {}),
    };
  }
  if (tool.pythonStdlib) {
    const python = await resolvePython(path.join(__dirname, ".."));
    const out = python
      ? await run(
          python.exe,
          [
            ...python.prefix,
            "-c",
            `import ${tool.pythonStdlib};print(getattr(${tool.pythonStdlib}, '__version__', '1.0'))`,
          ],
          8000,
        )
      : null;
    return {
      id: tool.id,
      category: tool.category,
      installed: Boolean(out),
      version: semver(out) || (out ? "1.0" : null),
      path: out ? python.executable : null,
      source: tool.source,
      url: tool.url,
      manager: "builtin",
      required: Boolean(tool.required),
      manual: tool.manual || null,
      status: out ? "Ready" : "Missing",
    };
  }
  if (tool.pipDist) {
    const version = freeze.get(tool.pipDist.toLowerCase()) || null;
    return {
      id: tool.id,
      category: tool.category,
      installed: Boolean(version),
      version,
      path: version ? "site-packages" : null,
      source: tool.source,
      url: tool.url,
      manager: "pip",
      required: Boolean(tool.required),
      manual: tool.manual || null,
      status: version ? "Ready" : "Missing",
    };
  }
  // Some components are files Windows installs rather than commands on PATH.
  if (tool.file) {
    const present = Boolean(tool.file) && fs.existsSync(tool.file);
    return {
      id: tool.id,
      category: tool.category,
      installed: present,
      version: null,
      path: present ? tool.file : null,
      source: tool.source,
      url: tool.url,
      manager: tool.winget ? "winget" : "vendor",
      required: Boolean(tool.required),
      manual: tool.manual || null,
      status: present ? "Ready" : "Missing",
    };
  }
  const bin = tool.cmd ? await which(tool.cmd) : null;
  const packageHit = !bin ? wingetPackage(tool, installedPackages) : null;
  let version = packageHit?.version || null;
  let status = bin || packageHit ? "Ready" : "Missing";

  if (bin && !tool.noVersionProbe) {
    const out = await run(tool.cmd, tool.args || ["--version"], 8000);
    version = semver(out);
    if (!version && !out) status = "Error";
  }

  if (bin && tool.service) {
    const alive = await ping(tool.service);
    status = alive ? "Running" : "Ready";
  }
  return {
    id: tool.id,
    category: tool.category,
    installed: Boolean(bin || packageHit),
    version,
    path: bin || packageHit?.path || null,
    source: tool.source,
    url: tool.url,
    manager: tool.winget ? "winget" : tool.npm ? "npm" : tool.pip ? "pip" : "vendor",
    required: Boolean(tool.required),
    manual: tool.manual || null,
    status,
  };
}

async function ping(url, timeout = 1200) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeout);
    const res = await fetch(url, { signal: c.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

async function pool(items, size, worker) {
  const out = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return out;
}

let detectInflight = null;
let lastDetect = { at: 0, tools: [] };

/** Detect every catalog tool. Concurrent, de-duplicated, never blocks twice. */
async function detectTools({ force = false } = {}) {
  if (!force && Date.now() - lastDetect.at < 15_000) return lastDetect;
  if (detectInflight) return detectInflight;
  detectInflight = (async () => {
    const [freeze, installedPackages] = await Promise.all([
      loadPipFreeze(force),
      loadWingetList(force),
    ]);
    const probed = await pool(TOOLS, 6, (t) => probeTool(t, freeze, installedPackages));
    // A component that several catalog rows share is reported once per row, so
    // every row carries the same real machine state instead of "Unknown".
    const tools = probed.flatMap((p) => {
      const shown = DISPLAY_IDS.get(p.id) || [];
      const aliases = shown.map((id) => ({ ...p, id, aliasOf: p.id }));
      return [{ ...p, alsoKnownAs: shown }, ...aliases];
    });

    lastDetect = { at: Date.now(), tools };
    return lastDetect;
  })().finally(() => {
    detectInflight = null;
  });
  return detectInflight;
}

/* --------------------------------------------------------- latest versions */

const latestCache = new Map(); // id -> { at, version }
const LATEST_TTL = 30 * 60 * 1000;

async function latestFor(tool) {
  const spec = tool.latest;
  if (!spec) return null;
  const hit = latestCache.get(tool.id);
  if (hit && Date.now() - hit.at < LATEST_TTL) return hit.version;
  let version = null;
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 6000);
    if (spec.kind === "npm") {
      const r = await fetch(`https://registry.npmjs.org/${spec.ref}/latest`, { signal: c.signal });
      if (r.ok) version = (await r.json()).version || null;
    } else if (spec.kind === "pypi") {
      const r = await fetch(`https://pypi.org/pypi/${spec.ref}/json`, { signal: c.signal });
      if (r.ok) version = (await r.json())?.info?.version || null;
    } else if (spec.kind === "github") {
      const r = await fetch(`https://api.github.com/repos/${spec.ref}/releases/latest`, {
        signal: c.signal,
        headers: { "user-agent": "FRIDAY-InstallManager" },
      });
      if (r.ok) version = semver((await r.json()).tag_name || "");
    }
    clearTimeout(t);
  } catch {
    version = null;
  }
  if (version) latestCache.set(tool.id, { at: Date.now(), version });
  return version;
}

async function latestVersions() {
  const withSpec = TOOLS.filter((t) => t.latest);
  const results = await pool(withSpec, 5, async (t) => [t.id, await latestFor(t)]);
  const map = Object.fromEntries(results.filter(([, v]) => v));
  // Shared components publish their version under every catalog row name too.
  for (const [real, shown] of DISPLAY_IDS) {
    if (map[real]) shown.forEach((id) => (map[id] = map[real]));
  }
  return map;
}

/**
 * Repair the WinGet source in place.
 *
 * `winget source reset --force` + `winget source update` is exactly what the
 * error text used to ask the OWNER to type. FRIDAY runs it herself (elevated
 * when needed) so an install like Redis/Memurai does not stop on a manual step.
 */
async function repairedWingetSource(id, action, emit) {
  if (!WIN) return false;
  emit({ id, action, phase: "Running", line: "repairing the WinGet source (reset + update)" });
  try {
    const elevate = !(await isElevated());
    const runOne = async (args) => {
      const [cmd, cmdArgs] = elevate ? elevatedCommand("winget", args) : ["winget", args];
      return run(cmd, cmdArgs, 180_000);
    };
    await runOne(["source", "reset", "--force"]);
    await runOne(["source", "update"]);
    const health = await wingetHealth();
    emit({
      id,
      action,
      phase: "Running",
      line: health.available
        ? "WinGet source repaired — retrying the install"
        : `WinGet source still unavailable — ${health.reason}`,
    });
    return health.available;
  } catch (error) {
    emit({
      id,
      action,
      phase: "Running",
      line: `WinGet source repair failed: ${String(error.message || error)}`,
    });
    return false;
  }
}

/* ------------------------------------------------------------------- jobs */

const jobs = new Map(); // key `${id}:${action}` -> child process

async function commandFor(tool, action, opts = {}) {
  const winget = tool.winget;
  if (action === "uninstall") {
    if (winget)
      return ["winget", ["uninstall", "--id", winget, "--silent", "--accept-source-agreements"]];
    if (tool.npm) return [WIN ? "npm.cmd" : "npm", ["uninstall", "-g", tool.npm]];
    if (tool.pip) {
      const python = await resolvePython(path.join(__dirname, ".."));
      return python
        ? [python.exe, [...python.prefix, "-m", "pip", "uninstall", "-y", tool.pip]]
        : null;
    }
    return null;
  }
  if (winget) {
    const base = [
      "install",
      "--id",
      winget,
      "--silent",
      "--accept-package-agreements",
      "--accept-source-agreements",
      "--disable-interactivity",
    ];
    base.push(...(tool.wingetArgs || []));
    if (action === "update")
      return [
        "winget",
        [
          "upgrade",
          "--id",
          winget,
          "--silent",
          "--accept-package-agreements",
          "--accept-source-agreements",
          "--disable-interactivity",
        ],
      ];
    if (action === "repair") return ["winget", [...base, "--force"]];
    return ["winget", base];
  }
  if (tool.npm)
    return [
      WIN ? "npm.cmd" : "npm",
      ["install", "-g", action === "update" ? `${tool.npm}@latest` : tool.npm],
    ];
  if (tool.pip) {
    const python = opts.python || (await resolvePython(path.join(__dirname, "..")));
    if (!python) return null;
    const args = [...python.prefix, "-m", "pip", "install", "--prefer-binary"];
    if (action === "update") args.push("--upgrade");
    if (action === "repair") args.push("--force-reinstall");
    // Wheels that only exist on a vendor index (CUDA PyTorch, for example).
    if (tool.pipIndex) args.push("--index-url", tool.pipIndex);
    // Hardware-specific wheel index chosen by the tool's own strategy
    // (llama-cpp-python CUDA builds, for example).
    if (opts.extraIndex) args.push("--extra-index-url", opts.extraIndex);
    args.push(tool.pip);
    return [python.exe, args];
  }

  return null;
}

/* ------------------------------------------------------------- elevation */
let elevated = null;

/** True when FRIDAY already runs with administrator rights. */
async function isElevated() {
  if (elevated !== null) return elevated;
  if (!WIN) {
    elevated = typeof process.getuid === "function" ? process.getuid() === 0 : false;
    return elevated;
  }
  const out = await run("net", ["session"], 4000);
  elevated = Boolean(out !== null && !/access is denied/i.test(out));
  return elevated;
}

/**
 * Re-issue a command through a UAC prompt. FRIDAY itself stays a normal
 * (asInvoker) process; only the installers that genuinely need administrator
 * rights ask for them, one at a time.
 */
/**
 * Windows batch launchers (`npm.cmd`, `yarn.cmd`, …) are not executables:
 * since Node 20 `spawn` refuses them without a shell (EINVAL), which is why
 * npm-based installs such as n8n failed instantly with no output. Route those
 * through the command processor while every real .exe still spawns directly.
 */
function spawnCommand(cmd, args) {
  if (WIN && /\.(cmd|bat)$/i.test(cmd)) {
    const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a);
    const line = [quote(cmd), ...args.map(quote)].join(" ");
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", line], {
      windowsHide: true,
      windowsVerbatimArguments: true,
      shell: false,
    });
  }
  return spawn(cmd, args, { windowsHide: true, shell: false });
}

function elevatedCommand(cmd, args) {
  const list = args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(",");
  const script =
    `$ErrorActionPreference='Stop';` +
    `$p=Start-Process -FilePath '${cmd.replace(/'/g, "''")}'` +
    (args.length ? ` -ArgumentList @(${list})` : "") +
    ` -Verb RunAs -Wait -PassThru; exit $p.ExitCode`;
  return ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]];
}

/** The verified machine state is authoritative; winget uses non-zero codes for
 * benign states such as "already installed" and "no upgrade available". */
function jobSucceeded(code, action, probe) {
  const desiredState = action === "uninstall" ? !probe.installed : probe.installed;
  const benignWingetCodes = new Set([2316632107, 2316632084]);
  return Boolean(desiredState && (code === 0 || benignWingetCodes.has(code)));
}

/**
 * Run an install/update/repair/uninstall/verify job.
 * `emit(event)` streams { id, action, phase, line, ok }.
 */
/** Human label for the package-manager method a tool declares. */
function pmMethodLabel(tool) {
  if (tool.winget) return "winget";
  if (tool.npm) return "npm";
  if (tool.pip) return "pip";
  if (tool.cargo) return "cargo";
  return "package manager";
}

/**
 * Second install method: the vendor's own installer, taken from the `url`
 * field the tool list already records. Only direct installer downloads
 * qualify — a documentation page is not something we can run.
 */
function directInstaller(tool) {
  // An explicit installerUrl is a vendor bootstrapper we trust even when the
  // link carries no file extension (Microsoft fwlink, for example).
  if (tool.installerUrl && /^https:\/\//i.test(tool.installerUrl)) {
    return { url: tool.installerUrl };
  }
  const url = tool.url;
  if (!url || !/^https:\/\//i.test(url)) return null;
  if (!/\.(exe|msi|msixbundle|zip)(\?|$)/i.test(url)) return null;
  return { url };
}

function diskRoom(dir) {
  try {
    const stat = fs.statfsSync(dir || os.tmpdir());
    const free = Number(stat.bavail) * Number(stat.bsize);
    return Number.isFinite(free) ? free : null;
  } catch {
    return null;
  }
}

function fileSha256(file) {
  return require("crypto").createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Keep a downloaded installer only when its SHA-256 matches the pin. */
function acceptPinnedFile(file, tool, options = {}) {
  const expected = String(tool?.sha256 || "").toLowerCase();
  if (!expected) return { ok: true, reason: "" };
  if (options.checkDisk !== false) {
    const need = Number(tool.needBytes || 0);
    const room = diskRoom(path.dirname(file));
    if (room === null)
      return { ok: false, reason: "Disk space is unknown. The installer was not kept." };
    if (need > 0 && room < need + 64 * 1024 * 1024) {
      return { ok: false, reason: "Not enough free disk for this installer." };
    }
  }
  let hash = "";
  try {
    hash = fileSha256(file);
  } catch {
    return { ok: false, reason: "The installer could not be read." };
  }
  if (hash !== expected) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
    return { ok: false, reason: "The installer hash did not match the pin." };
  }
  return { ok: true, reason: "" };
}

function cachedInstaller(url, root) {
  const name = decodeURIComponent(
    String(url || "")
      .split("?")[0]
      .split("/")
      .pop() || "",
  );
  if (!name) return "";
  return path.join(installerDir(root), name);
}

/** Download an installer into the FRIDAY root's downloads folder. */
function downloadInstaller(url, root, log, depth = 0) {
  const https = require("https");
  const dir = installerDir(root);
  const name = decodeURIComponent(url.split("?")[0].split("/").pop() || "installer.exe");
  const target = path.join(dir, name);
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error("too many redirects"));
    https
      .get(url, { headers: { "user-agent": "FRIDAY-installer" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          downloadInstaller(next, root, log, depth + 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          return;
        }
        const total = Number(res.headers["content-length"] || 0);
        let done = 0;
        let lastPct = -1;
        const out = fs.createWriteStream(target);
        res.on("data", (chunk) => {
          done += chunk.length;
          if (!total || !log) return;
          const pct = Math.floor((done / total) * 100);
          if (pct >= lastPct + 10) {
            lastPct = pct;
            log(`downloading ${name} — ${pct}%`);
          }
        });
        res.pipe(out);
        out.on("finish", () => out.close(() => resolve(target)));
        out.on("error", reject);
      })
      .on("error", reject);
  });
}

/** Silent-run command for a downloaded installer. */
function installerCommand(file, tool, root) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".msi") {
    return ["msiexec", ["/i", file, "/qn", "/norestart"]];
  }
  const args = Array.isArray(tool.installerArgs) ? [...tool.installerArgs] : ["/S"];
  // Only tools that document a target-path switch get one, pointed at the
  // FRIDAY root the owner selected.
  if (tool.installerPathArg && root) {
    args.push(`${tool.installerPathArg}${path.join(root, "runtime", tool.id || "tool")}`);
  }
  return [file, args];
}

function runJob({ id, action, root }, emit) {
  const tool = toolById(id);
  const key = `${id}:${action}`;
  if (!tool) {
    emit({ id, action, phase: "Failed", error: `unknown package "${id}"` });
    return Promise.resolve({ ok: false });
  }
  if (jobs.has(key)) {
    emit({ id, action, phase: "Running", line: "job already running — reusing it" });
    return Promise.resolve({ ok: true, reused: true });
  }

  // Components that ship with the operating system or with FRIDAY itself have
  // nothing to download: report their real presence instead of a fake failure.
  if (tool.builtin && action !== "uninstall") {
    return (async () => {
      const probe = await probeTool(tool, await loadPipFreeze(false));
      emit({
        id,
        action,
        ok: probe.installed,
        phase: probe.installed ? "Done" : "Failed",
        line: probe.installed
          ? `provided by ${tool.source} — nothing to install`
          : `${tool.source} is not available on this machine`,
        ...(probe.installed ? {} : { error: `${tool.source} not found` }),
      });
      return { ok: probe.installed };
    })();
  }

  if (action === "verify") {
    return (async () => {
      const freeze = await loadPipFreeze(true);
      const probe = await probeTool(tool, freeze, await loadWingetList(true));
      emit({
        id,
        action,
        phase: probe.installed ? "Done" : "Failed",
        line: probe.installed
          ? `verified ${probe.version || "installed"} at ${probe.path || "site-packages"}`
          : "not present on this machine",
        version: probe.version,
        ok: probe.installed,
      });
      return { ok: probe.installed, version: probe.version };
    })();
  }

  return (async () => {
    // Optional Windows features have no unattended installer: state the real
    // machine state instead of running a doomed package install.
    if (tool.optionalFeature && action !== "uninstall") {
      const probe = await probeTool(tool, await loadPipFreeze(false));
      // A Windows optional feature that the sandbox engine manager can enable
      // is enabled here for real — DISM, elevation and the restart banner —
      // rather than reported as a manual step the owner has to perform.
      if (!probe.installed && tool.engineId && WIN) {
        const engines = require("./sandbox-engines.cjs");
        const result = await engines.install(tool.engineId, (event) =>
          emit({ id, action, phase: event.phase || "Installing", line: event.line }),
        );
        if (result?.ok) {
          const after = await probeTool(tool, await loadPipFreeze(false));
          emit({
            id,
            action,
            ok: true,
            restartRequired: Boolean(result.restartRequired),
            phase: result.restartRequired ? "Restart required" : "Done",
            line: result.restartRequired
              ? `enabled — ${engines.RESTART_MESSAGE} to finish enabling ${tool.name || id}`
              : after.path
                ? `enabled — ${after.path}`
                : "enabled",
          });
          return { ok: true, restartRequired: Boolean(result.restartRequired) };
        }
        if (result?.declined) {
          emit({ id, action, ok: false, phase: "Declined", line: engines.DECLINED_MESSAGE });
          return { ok: false, error: engines.DECLINED_MESSAGE };
        }
        emit({
          id,
          action,
          ok: false,
          phase: "Failed",
          error: result?.error || `could not enable ${tool.name || id}`,
        });
        return { ok: false, error: result?.error || `could not enable ${tool.name || id}` };
      }
      emit({
        id,
        action,
        ok: probe.installed,
        manual: !probe.installed,
        phase: probe.installed ? "Done" : "Manual",
        line: probe.installed
          ? `already enabled — ${probe.path}`
          : probe.manual || "enable this Windows optional feature from Windows Features",
      });
      return { ok: probe.installed, manual: !probe.installed };
    }

    // Packages whose installability depends on the real machine (Python
    // version, GPU, available wheels) decide their strategy before we spend a
    // download on an install that cannot succeed.
    let installOpts = {};
    if (typeof tool.strategy === "function" && action !== "uninstall") {
      const plan = await tool.strategy();
      if (!plan.ok) {
        emit({ id, action, ok: false, manual: true, phase: "Manual", line: plan.reason });
        return { ok: false, manual: true, error: plan.reason };
      }
      if (plan.note) emit({ id, action, phase: "Running", line: plan.note });
      if (plan.extraIndex) installOpts = { ...installOpts, extraIndex: plan.extraIndex };
      // A strategy may hand back a dedicated interpreter (a managed Python
      // 3.12 runtime for wheels that are not published for a newer Python).
      if (plan.python) installOpts = { ...installOpts, python: plan.python };
    }

    // A broken WinGet source is not a package failure; say so before trying.
    if (tool.winget && action !== "uninstall") {
      const health = await wingetHealth();
      if (!health.available) {
        emit({
          id,
          action,
          phase: "Running",
          line: `package manager unavailable — ${health.reason}`,
        });
      }
    }

    const pmCmd = await commandFor(tool, action, installOpts);
    const fallback = action === "uninstall" ? null : directInstaller(tool);

    if (!pmCmd && !fallback) {
      // Nothing here is broken: the component simply has no unattended installer
      // on this platform. Reporting it as "Manual" keeps the row honest instead
      // of showing a failure the user cannot act on.
      const manual = Boolean(tool.manual) || !tool.pip;
      const message = tool.manual
        ? `manual step required — ${tool.manual} (${tool.url})`
        : tool.pip
          ? `FRIDAY's isolated Python 3.12 runtime was not found — run Setup, then retry`
          : `no automated ${action} available — download ${tool.name || id} yourself from ${tool.url}`;
      emit({
        id,
        action,
        manual,
        ok: false,
        phase: manual ? "Manual" : "Failed",
        ...(manual ? { line: message } : { error: message }),
      });
      return { ok: false, manual, error: manual ? undefined : message };
    }

    /** Run one attempt to completion and report its raw exit code. */
    const attempt = async (label, cmd) => {
      let command = cmd;
      // Installers that write to Program Files need administrator rights. FRIDAY
      // stays a normal process and asks for elevation only for those jobs.
      if (WIN && tool.elevate && !(await isElevated())) {
        emit({ id, action, phase: "Running", line: "requesting administrator rights (UAC)…" });
        command = elevatedCommand(command[0], command[1]);
      }
      emit({
        id,
        action,
        phase: "Running",
        line: `[${label}] ${command[0]} ${command[1].join(" ")}`,
      });
      const code = await new Promise((resolve) => {
        let child;
        try {
          child = spawnCommand(command[0], command[1]);
        } catch (err) {
          emit({ id, action, phase: "Running", line: `[${label}] ${String(err && err.message)}` });
          resolve(-1);
          return;
        }
        jobs.set(key, child);
        const feed = (chunk) => {
          String(chunk)
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(-4)
            .forEach((line) => emit({ id, action, phase: "Running", line }));
        };
        child.stdout?.on("data", feed);
        child.stderr?.on("data", feed);
        child.on("error", (err) => {
          jobs.delete(key);
          emit({ id, action, phase: "Running", line: `[${label}] ${String(err.message)}` });
          resolve(-1);
        });
        child.on("close", (code) => {
          jobs.delete(key);
          resolve(code);
        });
      });
      // Pick up any PATH entries the installer just wrote before verifying,
      // otherwise a successful install can still report "Missing".
      if (await refreshPathFromRegistry()) {
        emit({ id, action, phase: "Running", line: `[${label}] PATH refreshed` });
      }
      const freeze = await loadPipFreeze(true);
      const probe = await probeTool(tool, freeze, await loadWingetList(true));
      let ok = jobSucceeded(code, action, probe);
      // A pip exit code of 0 is not proof: import the module with the SAME
      // interpreter pip installed into before calling it installed.
      if (ok && tool.pipImport && action !== "uninstall") {
        const python = await resolvePython(path.join(__dirname, ".."));
        const out = python
          ? await run(
              python.exe,
              [
                ...python.prefix,
                "-c",
                `import ${tool.pipImport};print(getattr(${tool.pipImport}, '__version__', 'ok'))`,
              ],
              30_000,
            )
          : null;
        if (!out) {
          ok = false;
          probe.status = "Failed";
          emit({
            id,
            action,
            phase: "Running",
            line: `[${label}] verification failed — \`import ${tool.pipImport}\` did not succeed in ${python ? python.exe : "the managed Python runtime"}`,
          });
        } else {
          probe.version = semver(out) || probe.version;
          emit({
            id,
            action,
            phase: "Running",
            line: `[${label}] verified \`import ${tool.pipImport}\` → ${out.trim()}`,
          });
        }
      }
      const sourceProblem = !ok ? wingetSourceFailure(code) : null;
      return { code, probe, ok, ...(sourceProblem ? { sourceProblem } : {}) };
    };

    const tried = [];
    let last = null;

    if (pmCmd) {
      last = await attempt(pmMethodLabel(tool), pmCmd);
      tried.push(`${pmMethodLabel(tool)} (exit ${last.code})`);
      // A refused/stale WinGet source is a package-manager problem FRIDAY can
      // repair herself: reset + update the source once, then retry the same
      // install instead of telling the owner to open a terminal.
      if (!last.ok && last.sourceProblem && tool.winget) {
        const repaired = await repairedWingetSource(id, action, emit);
        if (repaired) {
          last = await attempt(`${pmMethodLabel(tool)} (after source reset)`, pmCmd);
          tried.push(`${pmMethodLabel(tool)} retry (exit ${last.code})`);
        }
      }
      if (last.ok) {
        emit({
          id,
          action,
          ok: true,
          phase: "Done",
          version: last.probe.version,
          line: `exit code ${last.code} · health check: ${last.probe.status}`,
        });
        return { ok: true, code: last.code, version: last.probe.version };
      }
    }

    // Fallback: download the vendor's own installer and run it silently.
    if (fallback) {
      emit({
        id,
        action,
        phase: "Running",
        line: pmCmd
          ? `${pmMethodLabel(tool)} failed — falling back to the vendor installer at ${fallback.url}`
          : `downloading the vendor installer from ${fallback.url}`,
      });
      let file = null;
      const cached = cachedInstaller(fallback.url, root);
      if (tool.sha256 && cached && fs.existsSync(cached)) {
        const ready = acceptPinnedFile(cached, tool, { checkDisk: false });
        if (ready.ok) file = cached;
      }
      if (!file && tool.sha256) {
        const room = diskRoom(installerDir(root));
        const need = Number(tool.needBytes || 0);
        if (room === null || (need > 0 && room < need + 64 * 1024 * 1024)) {
          emit({
            id,
            action,
            phase: "Running",
            line:
              room === null
                ? "Disk space is unknown. The download did not start."
                : "Not enough free disk for this installer.",
          });
          tried.push("disk check (failed)");
        }
      }
      if (!file && !tried.includes("disk check (failed)")) {
        try {
          file = await downloadInstaller(fallback.url, root, (line) =>
            emit({ id, action, phase: "Running", line }),
          );
        } catch (err) {
          emit({ id, action, phase: "Running", line: `download failed: ${String(err.message)}` });
          tried.push(`download from ${fallback.url} (failed)`);
        }
      }
      if (file && tool.sha256) {
        const pinned = acceptPinnedFile(file, tool, { checkDisk: false });
        if (!pinned.ok) {
          emit({ id, action, phase: "Running", line: pinned.reason });
          tried.push("sha256 (failed)");
          file = null;
        }
      }
      if (file) {
        const cmd = installerCommand(file, tool, root);
        last = await attempt("vendor installer", cmd);
        tried.push(`vendor installer (exit ${last.code})`);
        if (last.ok) {
          emit({
            id,
            action,
            ok: true,
            phase: "Done",
            version: last.probe.version,
            line: `installed from ${fallback.url} · health check: ${last.probe.status}`,
          });
          return { ok: true, code: last.code, version: last.probe.version, via: "url" };
        }
      }
    }

    // Everything failed: name the tool and give the owner a real next step.
    // A WinGet source problem is reported as such, not as a package failure.
    const pmProblem = last?.sourceProblem || null;
    const error = pmProblem
      ? `Windows package manager unavailable — ${pmProblem}. ` +
        `Run \`winget source reset --force\` in an administrator terminal, then retry, ` +
        `or install ${tool.name || id} manually from ${tool.url}.`
      : `${tool.name || id} could not be ${action === "update" ? "updated" : `${action}ed`}. ` +
        `Tried: ${tried.join(", ") || "no method available"}. ` +
        `Install it manually from ${tool.url}` +
        (tool.manual ? ` — ${tool.manual}` : "") +
        `.`;
    // A broken/absent Windows package manager is an environment limitation on
    // this machine, not a failed install of the tool. It is reported as the
    // manual step it really is, with the vendor page, so it stops sitting in
    // the queue as a red failure the owner cannot retry into success.
    emit({
      id,
      action,
      ok: false,
      phase: pmProblem ? "Manual" : "Failed",
      version: last?.probe?.version,
      ...(pmProblem ? { manual: true, line: error } : { error }),
      ...(pmProblem ? { reason: "package-manager-unavailable" } : {}),
      manualUrl: tool.url,
      tool: tool.name || id,
    });
    return {
      ok: false,
      error,
      ...(pmProblem ? { manual: true, reason: "package-manager-unavailable" } : {}),
      manualUrl: tool.url,
      tool: tool.name || id,
    };
  })();
}

function cancelJob({ id, action }) {
  const child = jobs.get(`${id}:${action}`);
  if (!child) return false;
  try {
    if (WIN) execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], () => {});
    else child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  jobs.delete(`${id}:${action}`);
  return true;
}

function activeJobs() {
  return [...jobs.keys()];
}

/** Where the installer keeps its own metadata inside the FRIDAY workspace. */
function installerDir(root) {
  const dir = path.join(root || os.tmpdir(), "temporary", "downloads");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* non-fatal */
  }
  return dir;
}

module.exports = {
  TOOLS,
  toolById,
  CATALOG_ALIAS,
  detectTools,
  latestVersions,
  runJob,
  cancelJob,
  activeJobs,
  installerDir,
  probeTool,
  which,
  run,
  ping,
  pool,
  semver,
  jobSucceeded,
  wingetSourceFailure,
  wingetHealth,
  detectWebView2,
  detectWindowsSandbox,
  detectRcedit,
  detectHuggingFace,
  llamaCppStrategy,
  repairedWingetSource,
  ensureManagedPython,
  acceptPinnedFile,
  diskRoom,
  fileSha256,
};
