/**
 * FRIDAY · Sandbox engines (main process only).
 *
 * Every kind of isolation FRIDAY can use, in one catalog:
 *   process          guarded child process inside the project folder
 *   venv             per-project Python virtual environment
 *   deno             permissioned runtime (explicit --allow-* flags)
 *   docker / podman  OCI containers (rootless podman, docker engine)
 *   wsl              a real Linux user-mode kernel on Windows
 *   sandboxie        Sandboxie-Plus process isolation on Windows
 *   windows-sandbox  the disposable Windows Sandbox VM
 *   firejail / bwrap Linux namespace sandboxes
 *   qemu             full machine virtualisation
 *
 * Each engine is probed by really executing its binary, and installed from
 * open-source sources in order (the existing Install Manager job first, then
 * winget / choco / scoop / apt / dnf / brew / DISM), re-probing after every
 * attempt. Nothing here reports success it did not verify.
 *
 * This module owns detection, installation and command wrapping only; the
 * Sandbox Lab (electron/sandbox-lab.cjs) owns projects, files and history.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const toolchain = require("./toolchain.cjs");

const WIN = process.platform === "win32";
const MAC = process.platform === "darwin";
const LINUX = !WIN && !MAC;

/* ------------------------------------------------------------- primitives */

function exec(file, args, { timeoutMs = 120 * 60 * 1000, onLine = () => {} } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { windowsHide: true, shell: false });
    } catch (error) {
      return resolve({ ok: false, code: null, output: String(error.message || error) });
    }
    let output = "";
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish({ ok: false, code: null, output: `${output}\ntimed out` });
    }, timeoutMs);
    const consume = (chunk) => {
      const text = decodeOutput(chunk);
      output += text;
      if (output.length > 100_000) output = output.slice(-100_000);
      for (const line of text.split(/\r?\n/)) if (line.trim()) onLine(line.trim());
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    child.on("error", (error) => finish({ ok: false, code: null, output: String(error.message) }));
    child.on("close", (code) => finish({ ok: code === 0, code, output }));
  });
}

/**
 * wsl.exe writes UTF-16LE when stdout is a pipe. Reading that as UTF-8 turns
 * "Windows" into "W\\0i\\0n...". Callers keep the real text.
 */
function decodeOutput(chunk) {
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString("utf16le").replace(/^\uFEFF/, "");
  }
  if (buf.length >= 4 && buf.length % 2 === 0) {
    let zeros = 0;
    const pairs = buf.length / 2;
    for (let i = 1; i < buf.length; i += 2) if (buf[i] === 0) zeros += 1;
    if (zeros / pairs > 0.8) return buf.toString("utf16le").replace(/\u0000+$/g, "");
  }
  return buf.toString("utf8");
}

const firstLine = (text) =>
  String(text || "")
    .split(/\r?\n/)
    .find((l) => l.trim()) || "";

/** Shell-quote for the POSIX shells used inside containers/WSL. */
/** Quote a Windows path for the cmd shell only when it needs it. */
const winQuote = (text) => (/\s/.test(String(text)) ? `"${text}"` : String(text));

const sh = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;

/* ------------------------------------------------------- UAC elevation */

/**
 * Windows only. Some engine installs (WSL, Windows Sandbox) enable OS features
 * and therefore need Administrator rights. FRIDAY itself never runs elevated:
 * we elevate ONE command at a time through the standard shell verb, so Windows
 * shows the user its own UAC prompt for exactly that command.
 */
const UAC_CANCEL = 1223; // ERROR_CANCELLED — the user said no at the prompt.

/** True when the current process already has Administrator rights. */
async function isElevated() {
  if (!WIN) return true;
  const answer = await exec("net", ["session"], { timeoutMs: 10_000 });
  return answer.ok;
}

const psQuote = (text) => `'${String(text).replace(/'/g, "''")}'`;

/**
 * Runs a single command elevated via `Start-Process -Verb RunAs`.
 * Returns the usual exec shape plus `declined` when the UAC prompt was refused.
 */
async function execElevated(file, args, { timeoutMs = 60 * 60 * 1000, onLine = () => {} } = {}) {
  const argList = (args || []).map(psQuote).join(",");
  const start = `Start-Process -FilePath ${psQuote(file)}${
    argList ? ` -ArgumentList @(${argList})` : ""
  } -Verb RunAs -Wait -PassThru`;
  const script = [
    "$ErrorActionPreference='Stop'",
    "try {",
    `  $p = ${start}`,
    "  exit $p.ExitCode",
    "} catch {",
    `  Write-Output $_.Exception.Message; exit ${UAC_CANCEL}`,
    "}",
  ].join("\n");
  const answer = await exec(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { timeoutMs, onLine },
  );
  const declined =
    answer.code === UAC_CANCEL ||
    /canceled by the user|cancelled by the user|operation was canceled/i.test(answer.output);
  return { ...answer, ok: answer.ok && !declined, declined };
}

const DECLINED_MESSAGE =
  "Admin permission declined — enable manually via Windows Features, or approve the prompt to let FRIDAY do it.";

/* ------------------------------------------------ restart-pending memory */

/**
 * A Windows-feature engine (WSL, Windows Sandbox) is only finished after a
 * reboot. The install toast is easy to miss, so the fact is REMEMBERED here
 * and re-attached to the engine card on every detection, until the engine
 * finally probes clean. Persisted next to the app data when Electron is
 * available; in-memory only in tests, which is enough for one session.
 */
const restartPending = new Set();

function restartStateFile() {
  try {
    const { app } = require("electron");
    return path.join(app.getPath("userData"), "sandbox-engine-restart.json");
  } catch {
    return null;
  }
}

function loadRestartPending() {
  const file = restartStateFile();
  if (!file) return;
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(saved)) saved.forEach((id) => restartPending.add(String(id)));
  } catch {
    /* nothing remembered yet */
  }
}
loadRestartPending();

function saveRestartPending() {
  const file = restartStateFile();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify([...restartPending]), "utf8");
  } catch {
    /* best effort — the in-memory set still covers this session */
  }
}

function noteRestartPending(id) {
  if (restartPending.has(id)) return;
  restartPending.add(id);
  saveRestartPending();
}

function clearRestartPending(id) {
  if (!restartPending.delete(id)) return;
  saveRestartPending();
}

const RESTART_MESSAGE = "Restart Windows to finish enabling this";

/* --------------------------------------------------- background services */

/**
 * Some engines ship a binary that answers `--version` immediately while their
 * daemon is still down ("installed but not running"). Detecting that was never
 * the problem — nothing ever tried to START it. These are the real, official
 * ways to bring each one up; they reuse the same `exec`/absolute-path
 * detection every other command in this file uses.
 */
const SERVICES = {
  docker: WIN
    ? {
        label: "Docker Desktop",
        locations: [
          "%ProgramFiles%\\Docker\\Docker\\Docker Desktop.exe",
          "%ProgramFiles(x86)%\\Docker\\Docker\\Docker Desktop.exe",
        ],
        args: [],
      }
    : {
        label: "the Docker daemon",
        file: "/bin/sh",
        args: [
          "-lc",
          "open -a Docker >/dev/null 2>&1 || sudo systemctl start docker || systemctl --user start docker",
        ],
      },
  podman: {
    label: "the Podman machine",
    file: "podman",
    args: ["machine", "start"],
  },
};

/** How long a daemon is given to come up, and how often it is re-probed. */
const SERVICE_WAIT_MS = 90_000;
const SERVICE_POLL_MS = 5_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start an engine's background service and wait until its own `ready` probe
 * really succeeds. Never claims success it did not verify.
 */
async function startService(id, emit = () => {}) {
  const engine = byId.get(id);
  if (!engine) return { ok: false, error: `Unknown sandbox engine "${id}".` };
  const service = SERVICES[id];
  if (!service) return { ok: false, error: `${engine.label} has no background service to start.` };

  const probe = await probeEngine(engine);
  if (!probe.installed)
    return { ok: false, engine: probe, error: `${engine.label} is not installed.` };
  if (probe.ready)
    return { ok: true, engine: probe, detail: `${engine.label} is already running.` };

  const file = service.file || findOnDisk(id, (service.locations || []).map(expandEnv));
  if (!file) {
    return {
      ok: false,
      engine: probe,
      error: `${service.label} could not be found on this PC — start it yourself, then press Detect.`,
    };
  }
  emit({ id, phase: "Starting", line: `Starting ${service.label}…` });
  const launched = await exec(file, service.args || [], {
    timeoutMs: 120_000,
    onLine: (line) => emit({ id, phase: "Starting", line }),
  });
  // Docker Desktop returns immediately; the daemon comes up afterwards, so the
  // ready probe — not the launcher's exit code — is what decides.
  const deadline = Date.now() + SERVICE_WAIT_MS;
  let latest = probe;
  while (Date.now() < deadline) {
    await sleep(SERVICE_POLL_MS);
    latest = await probeEngine(engine);
    if (latest.ready) {
      emit({ id, phase: "Ready", line: `${engine.label} is running.`, ok: true });
      return { ok: true, engine: latest, detail: `${service.label} started.` };
    }
  }
  return {
    ok: false,
    engine: latest,
    error:
      `${service.label} did not come up within ${Math.round(SERVICE_WAIT_MS / 1000)}s — ` +
      (firstLine(launched.output) || latest.detail || "start it yourself, then press Detect."),
  };
}

/**
 * The one call the UI and the run path share: make this engine usable now.
 * Installed-but-not-running is repaired by really starting the service.
 */
async function ensureReady(id, emit = () => {}) {
  const engine = byId.get(id);
  if (!engine) return { ok: false, error: `Unknown sandbox engine "${id}".` };
  const probe = await probeEngine(engine);
  if (probe.ready) return { ok: true, engine: probe, detail: probe.detail };
  if (probe.installed && SERVICES[id]) return startService(id, emit);
  return { ok: false, engine: probe, error: probe.detail || `${engine.label} is not ready.` };
}

/** C:\FRIDAY\x → /mnt/c/FRIDAY/x, for WSL. */
function wslPath(target) {
  const full = path.resolve(target);
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(full);
  if (!m) return full.replace(/\\/g, "/");
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

/* ----------------------------------------------------------------- catalog */

/**
 * `install` is an ordered list of real, open-source sources. Each is tried in
 * order until a re-probe of the engine's own binary succeeds.
 *   { kind: "toolchain", tool }   → existing Install Manager job (winget/npm/pip)
 *   { kind: "command", file, args, label }
 */
const ENGINES = [
  {
    id: "process",
    label: "Guarded process",
    kind: "process",
    isolation: "folder",
    builtin: true,
    summary: "Runs inside the project folder with a scoped environment. Always available.",
    platforms: ["win32", "darwin", "linux"],
    url: "https://nodejs.org/api/child_process.html",
    install: [],
  },
  {
    id: "venv",
    label: "Python venv",
    kind: "runtime",
    isolation: "dependencies",
    summary: "Per-project Python environment — packages never touch the system interpreter.",
    platforms: ["win32", "darwin", "linux"],
    probe: { file: WIN ? "python" : "python3", args: ["--version"] },
    url: "https://docs.python.org/3/library/venv.html",
    install: [{ kind: "toolchain", tool: "Python" }],
  },
  {
    id: "deno",
    label: "Deno (permissioned)",
    kind: "runtime",
    isolation: "permissions",
    summary: "Secure-by-default runtime: no file, net or env access unless granted.",
    platforms: ["win32", "darwin", "linux"],
    probe: { file: "deno", args: ["-V"] },
    url: "https://deno.com/",
    install: [
      { kind: "toolchain", tool: "Deno" },
      WIN
        ? {
            kind: "command",
            label: "winget",
            file: "winget",
            args: [
              "install",
              "--id",
              "DenoLand.Deno",
              "--silent",
              "--accept-package-agreements",
              "--accept-source-agreements",
            ],
          }
        : {
            kind: "command",
            label: "brew/apt",
            file: "/bin/sh",
            args: ["-lc", "brew install deno || (curl -fsSL https://deno.land/install.sh | sh)"],
          },
    ],
  },
  {
    id: "docker",
    label: "Docker",
    kind: "container",
    isolation: "container",
    summary: "OCI containers — full filesystem, process and network isolation.",
    platforms: ["win32", "darwin", "linux"],
    probe: { file: "docker", args: ["--version"] },
    ready: { file: "docker", args: ["info", "--format", "{{.ServerVersion}}"] },
    image: "node:20-alpine",
    url: "https://www.docker.com/",
    install: [
      { kind: "toolchain", tool: "Docker Desktop" },
      WIN
        ? {
            kind: "command",
            label: "winget",
            file: "winget",
            args: [
              "install",
              "--id",
              "Docker.DockerDesktop",
              "--silent",
              "--accept-package-agreements",
              "--accept-source-agreements",
            ],
          }
        : {
            kind: "command",
            label: "get.docker.com",
            file: "/bin/sh",
            args: ["-lc", "curl -fsSL https://get.docker.com | sh"],
          },
    ],
  },
  {
    id: "podman",
    label: "Podman (rootless)",
    kind: "container",
    isolation: "container",
    summary: "Daemonless, rootless containers — the safest container option.",
    platforms: ["win32", "darwin", "linux"],
    probe: { file: "podman", args: ["--version"] },
    ready: { file: "podman", args: ["info", "--format", "{{.Host.Arch}}"] },
    image: "docker.io/library/node:20-alpine",
    url: "https://podman.io/",
    install: [
      { kind: "toolchain", tool: "Podman" },
      WIN
        ? {
            kind: "command",
            label: "winget",
            file: "winget",
            args: [
              "install",
              "--id",
              "RedHat.Podman",
              "--silent",
              "--accept-package-agreements",
              "--accept-source-agreements",
            ],
          }
        : {
            kind: "command",
            label: "system package manager",
            file: "/bin/sh",
            args: [
              "-lc",
              "brew install podman || sudo apt-get install -y podman || sudo dnf install -y podman",
            ],
          },
    ],
  },
  {
    id: "wsl",
    label: "WSL2 Linux",
    kind: "vm",
    isolation: "kernel",
    summary: "A real Linux kernel beside Windows — Linux tooling with no dual boot.",
    platforms: ["win32"],
    probe: { file: "wsl.exe", args: ["--status"] },
    // `--status` can succeed when the feature is present and no distribution
    // is installed. A command probe is the only proof WSL can run anything.
    ready: { file: "wsl.exe", args: ["-e", "echo", "friday-wsl-ready"] },
    url: "https://learn.microsoft.com/windows/wsl/",
    install: [
      {
        kind: "command",
        label: "wsl --install",
        file: "wsl.exe",
        args: ["--install", "--no-launch"],
        elevate: true,
      },
      {
        kind: "command",
        label: "enable feature",
        file: "dism.exe",
        elevate: true,
        args: [
          "/online",
          "/enable-feature",
          "/featurename:Microsoft-Windows-Subsystem-Linux",
          "/all",
          "/norestart",
        ],
      },
    ],
    restart: true,
  },
  {
    id: "sandboxie",
    label: "Sandboxie-Plus",
    kind: "process",
    isolation: "process",
    summary: "Open-source Windows process isolation — writes are redirected into a box.",
    platforms: ["win32"],
    probe: { file: "Start.exe", args: ["/box:DefaultBox", "/terminate_all"], accept: true },
    url: "https://sandboxie-plus.com/",
    install: [
      {
        kind: "command",
        label: "winget",
        file: "winget",
        args: [
          "install",
          "--id",
          "Sandboxie.Plus",
          "--silent",
          "--accept-package-agreements",
          "--accept-source-agreements",
        ],
      },
    ],
  },
  {
    id: "windows-sandbox",
    label: "Windows Sandbox",
    kind: "vm",
    isolation: "vm",
    summary: "Disposable Windows VM. Sessions are launched; the desktop is thrown away after.",
    platforms: ["win32"],
    probe: { file: "WindowsSandbox.exe", args: ["/?"], accept: true },
    launchOnly: true,
    url: "https://learn.microsoft.com/windows/security/application-security/application-isolation/windows-sandbox/",
    install: [
      {
        kind: "command",
        label: "enable feature",
        file: "dism.exe",
        elevate: true,
        args: [
          "/online",
          "/enable-feature",
          "/featurename:Containers-DisposableClientVM",
          "/all",
          "/norestart",
        ],
      },
    ],
    restart: true,
  },
  {
    id: "firejail",
    label: "Firejail",
    kind: "process",
    isolation: "namespace",
    summary: "Linux namespace sandbox — private filesystem view and optional no network.",
    platforms: ["linux"],
    probe: { file: "firejail", args: ["--version"] },
    url: "https://firejail.wordpress.com/",
    install: [
      {
        kind: "command",
        label: "apt/dnf",
        file: "/bin/sh",
        args: ["-lc", "sudo apt-get install -y firejail || sudo dnf install -y firejail"],
      },
    ],
  },
  {
    id: "bwrap",
    label: "Bubblewrap",
    kind: "process",
    isolation: "namespace",
    summary: "Unprivileged Linux container primitive used by Flatpak.",
    platforms: ["linux"],
    probe: { file: "bwrap", args: ["--version"] },
    url: "https://github.com/containers/bubblewrap",
    install: [
      {
        kind: "command",
        label: "apt/dnf",
        file: "/bin/sh",
        args: ["-lc", "sudo apt-get install -y bubblewrap || sudo dnf install -y bubblewrap"],
      },
    ],
  },
  {
    id: "qemu",
    label: "QEMU",
    kind: "vm",
    isolation: "vm",
    summary: "Full machine emulation for whole-OS experiments. Launch-only.",
    platforms: ["win32", "darwin", "linux"],
    probe: { file: WIN ? "qemu-system-x86_64.exe" : "qemu-system-x86_64", args: ["--version"] },
    launchOnly: true,
    url: "https://www.qemu.org/",
    install: [
      WIN
        ? {
            kind: "command",
            label: "winget",
            file: "winget",
            args: [
              "install",
              "--id",
              "SoftwareFreedomConservancy.QEMU",
              "--silent",
              "--accept-package-agreements",
              "--accept-source-agreements",
            ],
          }
        : {
            kind: "command",
            label: "brew/apt",
            file: "/bin/sh",
            args: [
              "-lc",
              "brew install qemu || sudo apt-get install -y qemu-system-x86 || sudo dnf install -y qemu",
            ],
          },
    ],
  },
];

const byId = new Map(ENGINES.map((engine) => [engine.id, engine]));

/** Engines that make sense on this machine. */
function catalog() {
  return ENGINES.filter((engine) => engine.platforms.includes(process.platform));
}

const publicShape = (engine, state = {}) => ({
  id: engine.id,
  label: engine.label,
  kind: engine.kind,
  isolation: engine.isolation,
  summary: engine.summary,
  url: engine.url,
  image: engine.image ?? null,
  builtin: Boolean(engine.builtin),
  launchOnly: Boolean(engine.launchOnly),
  needsRestart: Boolean(engine.restart),
  // True when this engine was installed successfully but Windows has not been
  // restarted yet — the UI shows the restart instruction instead of an error.
  awaitingRestart: restartPending.has(engine.id),
  canStartService: Boolean(SERVICES[engine.id]),

  // True when installing this engine enables a Windows feature and therefore
  // needs one-off Administrator approval (a UAC prompt) — never the whole app.
  needsElevation: (engine.install || []).some((s) => s.elevate),
  sources: (engine.install || []).map((s) => s.label || s.tool || s.kind),
  installed: false,
  ready: false,
  version: null,
  detail: "",
  // Absolute location when the engine was found off PATH; null when PATH served.
  path: null,
  eligible: true,
  excludedReason: null,
  ...state,
});

/* ------------------------------------------ Windows edition + ranking */

/**
 * Windows Sandbox is a Pro / Enterprise / Education feature. Home (EditionID
 * Core*) can never enable it. Same hive as system/registry (`ProductName`)
 * plus EditionID — the diagnosis task's helper was not in this tree, so this
 * is the one real check, reused by ranking, install, and detect.
 */
const WINDOWS_SANDBOX_HOME_MESSAGE =
  "Windows Sandbox is not available on Windows Home (Microsoft restricts it to Pro, Enterprise, and Education). FRIDAY will not attempt it on this PC.";

const CURRENT_VERSION_KEY = "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion";

/** Isolation strength. One table, reused everywhere engine choice matters. */
const ISOLATION_RANK = {
  "windows-sandbox": 100,
  qemu: 95,
  docker: 80,
  wsl: 70,
  firejail: 66,
  sandboxie: 60,
  podman: 55,
  bwrap: 50,
  deno: 25,
  venv: 20,
  process: 10,
};

function isolationRank(id) {
  return ISOLATION_RANK[id] ?? 0;
}

function parseWindowsEdition({ editionId = "", productName = "" } = {}) {
  const id = String(editionId || "").trim();
  const name = String(productName || "").trim();
  const home = /^Core/i.test(id) || /\bHome\b/i.test(name);
  const skuAllowsSandbox = /^(Professional|Enterprise|Education)/i.test(id);
  const nameAllowsSandbox =
    !id && /\b(Pro|Professional|Enterprise|Education)\b/i.test(name) && !/\bHome\b/i.test(name);
  return {
    editionId: id || null,
    productName: name || null,
    home,
    windowsSandboxEligible: Boolean(!home && (skuAllowsSandbox || nameAllowsSandbox)),
  };
}

function isWindowsHome(edition) {
  return Boolean(edition && edition.home);
}

function windowsSandboxSupported(edition, platform = process.platform) {
  if (platform !== "win32") return false;
  if (!edition) return false;
  if (typeof edition.windowsSandboxEligible === "boolean") return edition.windowsSandboxEligible;
  return parseWindowsEdition(edition).windowsSandboxEligible;
}

function engineEligible(engine, edition, platform = process.platform) {
  if (!engine || !engine.platforms.includes(platform)) return false;
  if (engine.id === "windows-sandbox") return windowsSandboxSupported(edition, platform);
  return true;
}

function isOsIsolated(engineOrId) {
  const engine = typeof engineOrId === "string" ? byId.get(engineOrId) : engineOrId;
  if (!engine || engine.id === "process" || engine.id === "venv") return false;
  return true;
}

/**
 * Single source of truth for engine order on this OS/edition.
 * `forCommands: true` drops launch-only engines (Windows Sandbox, QEMU) —
 * they cannot wrap project commands. Windows Home drops windows-sandbox
 * entirely, not merely deprioritised.
 */
function rankEngines({ platform = process.platform, edition = null, forCommands = true } = {}) {
  return ENGINES.filter((engine) => {
    if (!engineEligible(engine, edition, platform)) return false;
    if (forCommands && engine.launchOnly) return false;
    return true;
  }).sort((a, b) => {
    const delta = isolationRank(b.id) - isolationRank(a.id);
    return delta !== 0 ? delta : a.id.localeCompare(b.id);
  });
}

async function queryCurrentVersionValue(name) {
  const answer = await exec("reg.exe", ["query", CURRENT_VERSION_KEY, "/v", name], {
    timeoutMs: 8_000,
  });
  const match = String(answer.output || "").match(new RegExp(`${name}\\s+REG_\\w+\\s+(.*)`, "i"));
  return match?.[1] ? match[1].trim() : null;
}

let lastEditionRead = null;

async function readWindowsEdition() {
  if (!WIN) {
    lastEditionRead = {
      platform: process.platform,
      editionId: null,
      productName: null,
      home: false,
      windowsSandboxEligible: false,
      source: "not-windows",
    };
    return lastEditionRead;
  }
  const editionId = await queryCurrentVersionValue("EditionID");
  const productName = await queryCurrentVersionValue("ProductName");
  const parsed = parseWindowsEdition({ editionId, productName });
  lastEditionRead = {
    platform: "win32",
    ...parsed,
    source: editionId || productName ? "registry" : "registry-unreadable",
  };
  return lastEditionRead;
}

function lastEdition() {
  return lastEditionRead;
}

/* --------------------------------------------------------------- detection */

/**
 * PATH is not proof of absence. winget, the Windows feature installer and the
 * vendors' own MSIs frequently install an engine WITHOUT putting it on PATH
 * (and a PATH change never reaches an already-running process anyway), so a
 * failed spawn used to report "not installed" for engines that were sitting
 * right there on disk. Every non-PATH engine therefore also declares the real
 * absolute locations its installers use, and those are checked before FRIDAY
 * calls anything missing.
 *
 * A `*` in a candidate matches one directory level (winget's per-package
 * folders), and %VARS% are expanded from the environment.
 */
const WIN_ENGINE_LOCATIONS = {
  qemu: [
    "%ProgramFiles%\\qemu\\qemu-system-x86_64.exe",
    "%ProgramFiles(x86)%\\qemu\\qemu-system-x86_64.exe",
    "%LOCALAPPDATA%\\Microsoft\\WinGet\\Links\\qemu-system-x86_64.exe",
    "%LOCALAPPDATA%\\Microsoft\\WinGet\\Packages\\*\\qemu-system-x86_64.exe",
  ],
  sandboxie: [
    "%ProgramFiles%\\Sandboxie-Plus\\Start.exe",
    "%ProgramFiles%\\Sandboxie\\Start.exe",
    "%ProgramFiles(x86)%\\Sandboxie-Plus\\Start.exe",
    "%ProgramFiles(x86)%\\Sandboxie\\Start.exe",
    "%LOCALAPPDATA%\\Microsoft\\WinGet\\Packages\\*\\Start.exe",
  ],
  "windows-sandbox": [
    "%SystemRoot%\\System32\\WindowsSandbox.exe",
    "%SystemRoot%\\Sysnative\\WindowsSandbox.exe",
  ],
  wsl: ["%SystemRoot%\\System32\\wsl.exe", "%SystemRoot%\\Sysnative\\wsl.exe"],
  docker: [
    "%ProgramFiles%\\Docker\\Docker\\resources\\bin\\docker.exe",
    "%ProgramFiles%\\Docker\\Docker\\resources\\bin\\docker.cmd",
  ],
  podman: [
    "%ProgramFiles%\\RedHat\\Podman\\podman.exe",
    "%LOCALAPPDATA%\\Microsoft\\WinGet\\Links\\podman.exe",
  ],
  deno: [
    "%USERPROFILE%\\.deno\\bin\\deno.exe",
    "%LOCALAPPDATA%\\Microsoft\\WinGet\\Links\\deno.exe",
  ],
};

const POSIX_ENGINE_LOCATIONS = {
  qemu: [
    "/usr/bin/qemu-system-x86_64",
    "/usr/local/bin/qemu-system-x86_64",
    "/opt/homebrew/bin/qemu-system-x86_64",
  ],
  docker: ["/usr/bin/docker", "/usr/local/bin/docker", "/opt/homebrew/bin/docker"],
  podman: ["/usr/bin/podman", "/usr/local/bin/podman", "/opt/homebrew/bin/podman"],
  deno: ["/usr/local/bin/deno", "/opt/homebrew/bin/deno"],
  firejail: ["/usr/bin/firejail"],
  bwrap: ["/usr/bin/bwrap"],
};

function expandEnv(candidate) {
  return String(candidate).replace(/%([^%]+)%/g, (whole, name) => {
    const value = process.env[name] ?? process.env[name.toUpperCase()];
    return value ?? whole;
  });
}

/**
 * Relative paths of a Python that already ships with FRIDAY.
 * Windows embeddable CPython is `python.exe` in the runtime folder.
 * POSIX keeps the `bin/python3` layout. `platform` is explicit so a Linux
 * test can lock the Windows list.
 */
function bundledInterpreterRels(platform = process.platform) {
  return platform === "win32"
    ? ["python/python.exe", "python/python3.exe"]
    : ["python/bin/python3", "python/bin/python"];
}

/**
 * Python that already ships with FRIDAY, before any installer.
 * `root` is the runtime folder (tests pass a temp dir). Node stays the
 * built-in process engine, which is the runtime that launched FRIDAY.
 */
function bundledInterpreter(
  id,
  root = process.env.FRIDAY_RUNTIME || "",
  platform = process.platform,
) {
  if (!root || id !== "venv") return null;
  for (const rel of bundledInterpreterRels(platform)) {
    const file = path.join(root, rel);
    try {
      if (fs.existsSync(file)) return file;
    } catch {
      /* try the next layout */
    }
  }
  return null;
}

/** Candidate absolute paths for an engine on this platform, env expanded. */
function engineLocations(id) {
  const list = (WIN ? WIN_ENGINE_LOCATIONS[id] : POSIX_ENGINE_LOCATIONS[id]) || [];
  return list.map(expandEnv);
}

/**
 * First candidate that really exists on disk, expanding one `*` level.
 * `candidates` is injectable so the resolver itself can be tested against a
 * real temporary folder instead of the machine's installed engines.
 */
function findOnDisk(id, candidates = engineLocations(id)) {
  for (const candidate of candidates) {
    if (!candidate.includes("*")) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        /* unreadable — try the next one */
      }
      continue;
    }
    const [head, ...rest] = candidate.split(/[\\/]\*[\\/]/);
    const tail = rest.join(path.sep);
    let children = [];
    try {
      children = fs.readdirSync(head, { withFileTypes: true });
    } catch {
      children = [];
    }
    for (const child of children) {
      if (!child.isDirectory()) continue;
      const full = path.join(head, child.name, tail);
      try {
        if (fs.existsSync(full)) return full;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/** Resolved absolute binaries, so wrap()/launch() reuse what detection found. */
const resolvedPaths = new Map();
const resolvedPath = (id) => resolvedPaths.get(id) || null;
function clearProbedEngine(id) {
  if (id) resolvedPaths.delete(id);
  else resolvedPaths.clear();
}

const missingBinary = (output) => /ENOENT|not recognized|not found|no such file/i.test(output);

/**
 * Docker Desktop (and the GitHub windows-latest runner) can be in Windows
 * container mode. `docker info` still succeeds, but Linux images such as
 * node:20-alpine have no manifest. That is not a usable isolation engine
 * for FRIDAY commands — selection must keep walking.
 */
function containerOsBlocksLinuxImages(osType) {
  const type = String(osType || "")
    .trim()
    .toLowerCase()
    .replace(/^['"]+|['"]+$/g, "");
  return type === "windows" || type.startsWith("windows/") || type.startsWith("windows\\");
}

const LINUX_IMAGE_BLOCK_MS = 60_000;
const linuxImageBlocks = new Map();

async function containerLinuxImageBlock(engine, bin) {
  const cached = linuxImageBlocks.get(engine.id);
  if (cached && Date.now() - cached.at < LINUX_IMAGE_BLOCK_MS) return cached;
  const format = engine.id === "podman" ? "{{.Host.OS}}" : "{{.OSType}}";
  const answer = await exec(bin, ["info", "--format", format], { timeoutMs: 8_000 });
  const blocked = Boolean(answer.ok && containerOsBlocksLinuxImages(answer.output));
  const record = {
    at: Date.now(),
    blocked,
    detail: blocked
      ? `${engine.label} is in Windows container mode and cannot run Linux images such as ${engine.image}.`
      : "",
  };
  linuxImageBlocks.set(engine.id, record);
  return record;
}

/**
 * A Python venv does not isolate Node. Using it for every Node sandbox run
 * creates a throwaway venv per command. Node stays on the guarded process
 * unless a real OS isolation engine was selected.
 */
function engineForCommand(engineId, { python = false } = {}) {
  const id = engineId || "process";
  if (!python && id === "venv") return "process";
  return id;
}

async function probeEngine(engine) {
  if (engine.builtin) {
    return publicShape(engine, {
      installed: true,
      ready: true,
      version: process.versions.node,
      detail: "built in — always available",
    });
  }
  const probe = engine.probe;
  let usedPath = null;
  let answer = { ok: false, output: "" };
  const bundled = bundledInterpreter(engine.id);
  if (bundled) {
    const direct = await exec(bundled, probe.args, { timeoutMs: 20_000 });
    if (direct.ok || (probe.accept && !missingBinary(direct.output))) {
      answer = direct;
      usedPath = bundled;
    }
  }
  if (!usedPath) answer = await exec(probe.file, probe.args, { timeoutMs: 20_000 });
  // PATH said no: look where the installers actually put it before believing it.
  if (!answer.ok && missingBinary(answer.output)) {
    const onDisk = findOnDisk(engine.id);
    if (onDisk) {
      const direct = await exec(onDisk, probe.args, { timeoutMs: 20_000 });
      if (direct.ok || (probe.accept && !missingBinary(direct.output))) {
        answer = direct;
        usedPath = onDisk;
      }
    }
  }
  // Some CLIs answer usage text with a non-zero code; `accept` means the
  // binary answering at all proves it exists.
  const installed = answer.ok || (engine.probe.accept && !missingBinary(answer.output));
  if (!installed) {
    resolvedPaths.delete(engine.id);
    // A feature engine that installed fine but has not been rebooted looks
    // exactly like "missing binary" (ENOENT). Say the true thing instead.
    if (restartPending.has(engine.id)) {
      return publicShape(engine, { detail: `${RESTART_MESSAGE} — ${engine.label} is installed.` });
    }
    return publicShape(engine, { detail: firstLine(answer.output) || "not installed" });
  }

  if (usedPath) resolvedPaths.set(engine.id, usedPath);
  else resolvedPaths.delete(engine.id);
  if (engine.id === "wsl" && /no installed distributions/i.test(answer.output || "")) {
    return publicShape(engine, {
      installed: true,
      ready: false,
      detail: "WSL has no Linux distribution installed, so it cannot run commands.",
    });
  }
  const version = (/(\d+\.\d+(?:\.\d+)?)/.exec(firstLine(answer.output)) || [])[1] || null;
  let ready = true;
  let detail = firstLine(answer.output).slice(0, 160);
  if (usedPath) {
    detail = `${detail || "installed"} · found at ${usedPath} (not on PATH)`.slice(0, 300);
  }
  if (engine.ready) {
    const readyFile = usedPath && engine.ready.file === probe.file ? usedPath : engine.ready.file;
    const live = await exec(readyFile, engine.ready.args, { timeoutMs: 25_000 });
    ready = live.ok;
    if (!ready) {
      detail = restartPending.has(engine.id)
        ? `${RESTART_MESSAGE} — ${engine.label} is installed but its service is not running yet.`
        : `installed but not running — ${firstLine(live.output).slice(0, 140)}${
            SERVICES[engine.id] ? " · FRIDAY can start it for you" : ""
          }`;
    }
  }
  // A running Windows-container daemon cannot execute FRIDAY's Linux images.
  if (ready && (engine.id === "docker" || engine.id === "podman") && engine.image) {
    const bin = usedPath || engine.probe.file;
    const block = await containerLinuxImageBlock(engine, bin);
    if (block.blocked) {
      ready = false;
      detail = block.detail;
    }
  }

  // Working proves the reboot happened (or was never needed).
  if (ready) clearRestartPending(engine.id);

  return publicShape(engine, { installed: true, ready, version, detail, path: usedPath });
}

async function detect() {
  const edition = await readWindowsEdition();
  const engines = [];
  for (const engine of catalog()) {
    if (!engineEligible(engine, edition)) {
      const reason =
        engine.id === "windows-sandbox"
          ? WINDOWS_SANDBOX_HOME_MESSAGE
          : `${engine.label} is not available on this PC.`;
      engines.push(
        publicShape(engine, {
          eligible: false,
          excludedReason: reason,
          detail: reason,
        }),
      );
      continue;
    }
    engines.push(await probeEngine(engine));
  }
  const probes = Object.fromEntries(engines.map((entry) => [entry.id, entry]));
  const selected = await selectBestEngine({
    allowInstall: false,
    edition,
    probes,
    platform: process.platform,
  });
  return {
    ok: true,
    platform: process.platform,
    arch: process.arch,
    engines,
    usable: engines
      .filter((entry) => entry.ready && !entry.launchOnly && entry.eligible !== false)
      .map((entry) => entry.id),
    selected,
    edition,
  };
}

/* ------------------------------------------ auto-select + cache */

const selectionMemory = { value: null };
const selectionMemo = { key: "", at: 0, value: null };
const SELECTION_MEMO_MS = 60_000;

function selectionMemoKey(options, platform) {
  if (
    options.probes ||
    options.probe ||
    options.installEngine ||
    options.skipCache ||
    options.cacheFile
  ) {
    return null;
  }
  const allowInstall = options.allowInstall === true;
  return `${platform}|${allowInstall ? "install" : "probe"}`;
}

function selectionCacheFile(override) {
  if (override) return override;
  try {
    const { app } = require("electron");
    return path.join(app.getPath("userData"), "sandbox-engine-selected.json");
  } catch {
    return null;
  }
}

function loadSelectionCache(file) {
  const target = selectionCacheFile(file);
  if (!target) return selectionMemory.value;
  try {
    return JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    return null;
  }
}

function saveSelectionCache(record, file) {
  selectionMemory.value = record;
  const target = selectionCacheFile(file);
  if (!target) return;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(record), "utf8");
  } catch {
    /* best effort — in-memory still covers this session */
  }
}

function clearSelectionCache(file) {
  selectionMemory.value = null;
  selectionMemo.key = "";
  selectionMemo.at = 0;
  selectionMemo.value = null;
  linuxImageBlocks.clear();
  const target = selectionCacheFile(file);
  if (!target) return;
  try {
    fs.unlinkSync(target);
  } catch {
    /* nothing cached */
  }
}

function selectionResult({ engine, probe, source, isolated, warning, attempts, edition, cached }) {
  return {
    ok: true,
    id: engine.id,
    label: engine.label,
    isolated,
    source,
    cached: Boolean(cached),
    detail: (probe && probe.detail) || engine.summary,
    warning: warning || null,
    attempts: attempts || [],
    edition,
  };
}

function unisolatedWarning(attempts, picked) {
  const tried = (attempts || [])
    .map((row) => `${row.id}: ${row.error || (row.ok ? "ok" : "failed")}`)
    .join(" · ");
  const pick = picked ? `${picked.label} (${picked.id})` : "the guarded process";
  return (
    `No OS isolation engine is available on this machine. Commands will use ${pick} ` +
    `without OS isolation.` +
    (tried ? ` Tried: ${tried}` : "")
  );
}

/**
 * Probe engines in rank order using each engine's existing probe. First ready
 * win. Optional install walks the same order and re-probes before trusting.
 */
async function selectBestEngine(options = {}) {
  const platform = options.platform || process.platform;
  const edition = options.edition !== undefined ? options.edition : await readWindowsEdition();
  const allowInstall = options.allowInstall === true;
  const memoKey = selectionMemoKey(options, platform);
  if (
    memoKey &&
    selectionMemo.key === memoKey &&
    selectionMemo.value &&
    Date.now() - selectionMemo.at < SELECTION_MEMO_MS
  ) {
    return selectionMemo.value;
  }
  const finish = (result) => {
    if (memoKey) {
      selectionMemo.key = memoKey;
      selectionMemo.at = Date.now();
      selectionMemo.value = result;
    }
    return result;
  };
  const attempts = [];
  const ranked = rankEngines({ platform, edition, forCommands: true });
  const probeOf = async (engine, { fresh = false } = {}) => {
    if (!fresh && options.probes && options.probes[engine.id]) return options.probes[engine.id];
    if (typeof options.probe === "function") return options.probe(engine);
    return probeEngine(engine);
  };
  const persist = (engine, probe, isolated) => {
    saveSelectionCache(
      {
        id: engine.id,
        platform,
        isolated,
        at: Date.now(),
        detail: (probe && probe.detail) || "",
      },
      options.cacheFile,
    );
  };

  const cached = options.skipCache ? null : loadSelectionCache(options.cacheFile);
  if (cached && cached.id && cached.platform === platform) {
    const engine = byId.get(cached.id);
    if (engine && engineEligible(engine, edition, platform) && !engine.launchOnly) {
      const probe = await probeOf(engine, { fresh: true });
      if (probe.ready && isOsIsolated(engine)) {
        persist(engine, probe, true);
        return finish(
          selectionResult({
            engine,
            probe,
            source: "cache",
            isolated: true,
            attempts,
            edition,
            cached: true,
          }),
        );
      }
      attempts.push({
        id: engine.id,
        ok: false,
        error: probe.detail || "cached engine probe failed — selecting again",
      });
    }
  }

  const isolatedRanked = ranked.filter((engine) => isOsIsolated(engine));
  const fallbackRanked = ranked.filter((engine) => !isOsIsolated(engine));

  for (const engine of isolatedRanked) {
    const probe = await probeOf(engine);
    if (probe.ready) {
      persist(engine, probe, true);
      return finish(
        selectionResult({
          engine,
          probe,
          source: "probe",
          isolated: true,
          attempts,
          edition,
          cached: false,
        }),
      );
    }
    attempts.push({
      id: engine.id,
      ok: false,
      error: probe.detail || probe.error || "not ready",
    });
  }

  if (allowInstall) {
    const installer = options.installEngine || install;
    for (const engine of isolatedRanked) {
      if (!engine.install || engine.install.length === 0) continue;
      const installed = await installer(engine.id, options.emit || (() => {}), { edition });
      if (!installed.ok) {
        attempts.push({
          id: engine.id,
          ok: false,
          error: installed.error || "install failed",
        });
        continue;
      }
      const probe = await probeOf(engine, { fresh: true });
      if (probe.ready) {
        persist(engine, probe, true);
        return finish(
          selectionResult({
            engine,
            probe,
            source: "install",
            isolated: true,
            attempts,
            edition,
            cached: false,
          }),
        );
      }
      attempts.push({
        id: engine.id,
        ok: false,
        error: `install finished but re-probe failed: ${probe.detail || "not ready"}`,
      });
    }
  }

  for (const engine of fallbackRanked) {
    const probe = await probeOf(engine);
    if (probe.ready) {
      persist(engine, probe, false);
      return finish(
        selectionResult({
          engine,
          probe,
          source: "fallback",
          isolated: false,
          warning: unisolatedWarning(attempts, engine),
          attempts,
          edition,
          cached: false,
        }),
      );
    }
    attempts.push({
      id: engine.id,
      ok: false,
      error: probe.detail || probe.error || "not ready",
    });
  }

  const processEngine = byId.get("process");
  const probe = await probeOf(processEngine);
  persist(processEngine, probe, false);
  return finish(
    selectionResult({
      engine: processEngine,
      probe,
      source: "fallback",
      isolated: false,
      warning: unisolatedWarning(attempts, processEngine),
      attempts,
      edition,
      cached: false,
    }),
  );
}

async function ensureSelected(options = {}) {
  const allowInstall =
    options.allowInstall !== undefined ? options.allowInstall : !process.env.VITEST;
  return selectBestEngine({ ...options, allowInstall });
}

/* ------------------------------------------------------------ installation */

/** Install one engine, trying every open-source source in order. */
async function install(id, emit = () => {}, options = {}) {
  const engine = byId.get(id);
  if (!engine) return { ok: false, error: `Unknown sandbox engine "${id}".` };
  if (!engine.platforms.includes(process.platform)) {
    return { ok: false, error: `${engine.label} is not available on ${process.platform}.` };
  }
  const edition = options.edition || (await readWindowsEdition());
  if (engine.id === "windows-sandbox" && !windowsSandboxSupported(edition)) {
    return {
      ok: false,
      error: WINDOWS_SANDBOX_HOME_MESSAGE,
      engine: publicShape(engine, {
        eligible: false,
        excludedReason: WINDOWS_SANDBOX_HOME_MESSAGE,
        detail: WINDOWS_SANDBOX_HOME_MESSAGE,
      }),
    };
  }
  const already = await probeEngine(engine);
  if (already.installed) {
    emit({ id, phase: "Verified", line: already.detail, ok: true });
    return { ok: true, skipped: true, engine: already };
  }

  const attempts = [];
  let declined = false;
  // Only asked once, and only for engines that really enable a Windows feature.
  const alreadyAdmin = engine.install.some((s) => s.elevate) ? await isElevated() : true;

  for (const source of engine.install) {
    const label = source.label || source.tool || source.kind;
    const elevate = Boolean(source.elevate) && WIN && !alreadyAdmin;
    if (elevate) {
      emit({
        id,
        phase: "Permission",
        line: `${engine.label} enables a Windows feature, so Windows will now show a UAC prompt asking for Administrator approval for "${source.file}" only. FRIDAY itself keeps running normally.`,
      });
    }
    emit({ id, phase: "Installing", line: `${engine.label} — trying ${label}` });
    let result;
    try {
      if (source.kind === "toolchain") {
        result = await toolchain.runJob({ id: source.tool, action: "install" }, (event) =>
          emit({ id, phase: event.phase, line: event.line, ok: event.ok }),
        );
      } else {
        const run = elevate ? execElevated : exec;
        result = await run(source.file, source.args, {
          timeoutMs: 60 * 60 * 1000,
          onLine: (line) => emit({ id, phase: "Installing", line }),
        });
      }
    } catch (error) {
      result = { ok: false, output: String(error.message || error) };
    }
    if (result?.declined) {
      declined = true;
      emit({ id, phase: "Declined", line: DECLINED_MESSAGE, ok: false });
    }
    attempts.push(
      `${label}: ${result?.declined ? "admin approval declined" : result?.ok ? "ran" : firstLine(result?.output || result?.error) || "failed"}`,
    );

    const probe = await probeEngine(engine);
    if (probe.installed) {
      if (engine.restart) noteRestartPending(id);
      emit({ id, phase: "Verified", line: probe.detail, ok: true });
      return {
        ok: true,
        engine: await probeEngine(engine),
        source: label,
        restartRequired: Boolean(engine.restart),
      };
    }
    // A Windows feature only appears after a reboot: the enable command
    // succeeded, so this is a pending restart, NOT a failed install.
    if (result?.ok && engine.restart) {
      noteRestartPending(id);
      emit({ id, phase: "Restart required", line: RESTART_MESSAGE, ok: true });
      return {
        ok: true,
        engine: await probeEngine(engine),
        source: label,
        restartRequired: true,
        detail: `${engine.label} is enabled. ${RESTART_MESSAGE} to start using it.`,
      };
    }
  }

  const probe = await probeEngine(engine);
  if (declined) {
    return { ok: false, declined: true, engine: probe, error: DECLINED_MESSAGE };
  }
  return {
    ok: false,
    engine: probe,
    error: `${engine.label} could not be installed from any source (${attempts.join(" · ") || "no source available"}). Install it from ${engine.url}.`,
  };
}

/* ------------------------------------------------------------- command wrap */

/**
 * Wraps a shell command so it executes inside the chosen engine.
 * Returns `{ ok, line, note }` — the line is handed to the same guarded
 * shell the Sandbox Lab already uses, so there is one execution path.
 */
function wrap(engineId, { command, dir, image, network = false, extraBinds = [] } = {}) {
  const engine = byId.get(engineId) || byId.get("process");
  const line = String(command || "").trim();
  if (!line) return { ok: false, error: "No command given.", isolated: false };
  if (engine.launchOnly) {
    return {
      ok: false,
      error: `${engine.label} runs full sessions, not project commands.`,
      isolated: false,
    };
  }
  const done = (payload) => ({
    ...payload,
    isolated: isOsIsolated(byId.get(payload.engine) || engine),
  });

  switch (engine.id) {
    case "process":
      return done({
        ok: true,
        line,
        engine: engine.id,
        note: "guarded process in the project folder",
      });

    case "venv": {
      const py = WIN ? "python" : "python3";
      // If ensurepip is missing the venv cannot be created — still run the
      // command rather than fail every Node sandbox run on that machine.
      const activate = WIN
        ? `(if not exist .venv\\Scripts\\python.exe ${py} -m venv .venv) & (if exist .venv\\Scripts\\activate.bat call .venv\\Scripts\\activate.bat) & ${line}`
        : `{ [ -x .venv/bin/python ] || ${py} -m venv .venv; } >/dev/null 2>&1 || true; if [ -f .venv/bin/activate ]; then . .venv/bin/activate; fi; ${line}`;
      return done({
        ok: true,
        line: activate,
        engine: engine.id,
        note: "project virtual environment",
      });
    }

    case "deno": {
      const grants = `--allow-read=. --allow-write=. --allow-env${network ? " --allow-net" : ""}`;
      return done({
        ok: true,
        line: /^deno\b/.test(line) ? line : `deno run ${grants} ${line}`,
        engine: engine.id,
        note: `permissions: ${grants}`,
      });
    }

    case "docker":
    case "podman": {
      const bin = engine.id;
      const useImage = image || engine.image;
      const net = network ? "" : " --network none";
      return done({
        ok: true,
        line: `${bin} run --rm -v ${sh(`${path.resolve(dir)}:/work`)} -w /work${net} ${useImage} sh -lc ${sh(line)}`,
        engine: engine.id,
        note: `${useImage}${network ? "" : " · no network"}`,
      });
    }

    case "wsl":
      return done({
        ok: true,
        line: `wsl.exe -e bash -lc ${sh(`cd ${sh(wslPath(dir))} && ${line}`)}`,
        engine: engine.id,
        note: "Linux user-mode kernel",
      });

    case "sandboxie":
      return done({
        ok: true,
        // Sandboxie installs to Program Files without touching PATH, so the
        // absolute Start.exe detection found is used when there is one.
        line: `${winQuote(resolvedPath("sandboxie") || "Start.exe")} /box:FRIDAY /hide_window /wait cmd /c ${sh(line)}`,
        engine: engine.id,
        note: "Sandboxie box FRIDAY",
      });

    case "firejail":
      return done({
        ok: true,
        line: `firejail --quiet --private=${sh(path.resolve(dir))}${network ? "" : " --net=none"} sh -lc ${sh(line)}`,
        engine: engine.id,
        note: network ? "private filesystem" : "private filesystem · no network",
      });

    case "bwrap": {
      const target = path.resolve(dir);
      const binds = ["--ro-bind /usr /usr", "--ro-bind /etc /etc", "--dev /dev", "--proc /proc"];
      if (fs.existsSync("/usr/local")) binds.push("--ro-bind /usr/local /usr/local");
      // nvm Node and other host runtimes live outside /usr; hide the rest of $HOME.
      const seen = new Set(["/usr", "/etc", "/usr/local", "/bin", "/lib", "/lib64", target]);
      for (const dirPath of String(process.env.PATH || "").split(path.delimiter)) {
        if (!dirPath || seen.has(dirPath)) continue;
        try {
          if (!fs.existsSync(dirPath)) continue;
        } catch {
          continue;
        }
        seen.add(dirPath);
        binds.push(`--ro-bind ${sh(dirPath)} ${sh(dirPath)}`);
      }
      for (const extra of extraBinds) {
        const resolved = path.resolve(extra);
        if (!resolved || seen.has(resolved)) continue;
        try {
          if (!fs.existsSync(resolved)) continue;
        } catch {
          continue;
        }
        seen.add(resolved);
        binds.push(`--bind ${sh(resolved)} ${sh(resolved)}`);
      }
      const links = [
        "--symlink usr/bin /bin",
        "--symlink usr/lib /lib",
        "--symlink usr/lib64 /lib64",
      ];
      return done({
        ok: true,
        line: `bwrap ${binds.join(" ")} ${links.join(" ")} --bind ${sh(target)} ${sh(target)} --chdir ${sh(target)}${network ? "" : " --unshare-net"} sh -lc ${sh(line)}`,
        engine: engine.id,
        note: network ? "namespaced" : "namespaced · no network",
      });
    }

    default:
      return done({ ok: true, line, engine: "process", note: "fallback: guarded process" });
  }
}

/** Launch a disposable full session for the launch-only engines. */
async function launch(engineId, { dir } = {}) {
  const engine = byId.get(engineId);
  if (!engine?.launchOnly) return { ok: false, error: "That engine has no session to launch." };
  if (engine.id === "windows-sandbox") {
    const answer = await exec(resolvedPath("windows-sandbox") || "WindowsSandbox.exe", [], {
      timeoutMs: 15_000,
    });
    return answer.ok
      ? { ok: true, detail: "Windows Sandbox session started." }
      : { ok: false, error: firstLine(answer.output) || "Windows Sandbox could not start." };
  }
  if (engine.id === "qemu") {
    return {
      ok: false,
      error: `QEMU needs a disk image. Create one in ${dir || "the project folder"} and start it from the runner with a qemu-system command.`,
    };
  }
  return { ok: false, error: "Unsupported engine." };
}

module.exports = {
  ENGINES,
  WIN_ENGINE_LOCATIONS,
  POSIX_ENGINE_LOCATIONS,
  engineLocations,
  findOnDisk,
  bundledInterpreter,
  bundledInterpreterRels,
  clearProbedEngine,
  resolvedPath,
  catalog,
  detect,
  install,
  wrap,
  launch,
  probeEngine,
  wslPath,
  isElevated,
  execElevated,
  startService,
  ensureReady,
  SERVICES,
  RESTART_MESSAGE,
  noteRestartPending,
  clearRestartPending,
  restartPending,
  DECLINED_MESSAGE,
  WINDOWS_SANDBOX_HOME_MESSAGE,
  ISOLATION_RANK,
  isolationRank,
  parseWindowsEdition,
  isWindowsHome,
  windowsSandboxSupported,
  engineEligible,
  isOsIsolated,
  rankEngines,
  readWindowsEdition,
  lastEdition,
  selectBestEngine,
  ensureSelected,
  clearSelectionCache,
  loadSelectionCache,
  containerOsBlocksLinuxImages,
  engineForCommand,
  decodeOutput,
};
