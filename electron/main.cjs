// FRIDAY — Electron main process.
// Locates the existing FRIDAY workspace, scans it, detects runtimes and AI
// providers, spawns the local Python kernel, then loads the React UI and keeps
// watching the workspace for changes.
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, screen, session } = require("electron");
const { spawn, execFile } = require("child_process");
const net = require("node:net");

// WebSocket client for the local kernel bridge. Resolved lazily: newer runtimes
// expose a standards WebSocket globally, older ones need undici. A missing
// implementation must surface as a chat error, never as a start-up crash.
let cachedWebSocket;
function getWebSocket() {
  if (cachedWebSocket !== undefined) return cachedWebSocket;
  if (typeof globalThis.WebSocket === "function") {
    cachedWebSocket = globalThis.WebSocket;
    return cachedWebSocket;
  }
  try {
    cachedWebSocket = require("undici").WebSocket ?? null;
  } catch {
    cachedWebSocket = null;
  }
  return cachedWebSocket;
}
const { Worker } = require("worker_threads");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const {
  verifyWorkspace,
  repairWorkspace,
  ensureRootFiles,
  scanWorkspace,
  resolveFolder,
} = require("./workspace.cjs");
const paths = require("./friday-paths.cjs");
const fridayVersion = require("./friday-version.cjs");
const productVersion = () => fridayVersion.displayVersion();
const { createStallWatchdog } = require("./stream-watchdog.cjs");
const kernelAutoRestart = require("./kernel-auto-restart.cjs");
const rootRegistry = require("./root-registry.cjs");
const projectPaths = require("./project.cjs");
const connectivityGraph = require("./connectivity.cjs");
const modelRouter = require("./model-router.cjs");
const modelAccess = require("./model-access.cjs");
const netStatus = require("./net-status.cjs");
const billingPolicy = require("./billing-policy.cjs");
const billingFirewall = require("./billing-firewall.cjs");
const privacyFirewall = require("./privacy-firewall.cjs");
const toolAuthority = require("./tool-authority.cjs");
const kernelMethods = require("./kernel-methods.cjs");

/** Live model health/cooldown state (rate limits, quota, bad keys). */
const providerHealth = new modelRouter.ProviderHealthManager();
// Bootstrap location for the very first launch, before a folder is selected.
try {
  paths.setFallbackRoot(app.getPath("userData"));
} catch {
  /* userData is unavailable in some test harnesses; the tmp fallback stands */
}
const { WorkspaceWatcher } = require("./watcher.cjs");
const { checkAllUpdates } = require("./updater.cjs");
const { detectComponents, detectProviders, listOllamaModels } = require("./providers.cjs");
const providerRegistry = require("./provider-registry.cjs");
const { detectHardware } = require("./hardware.cjs");
const systemMonitor = require("./system-monitor.cjs");
const serviceHealth = require("./service-health.cjs");
const { applyUpdate, rollbackUpdate } = require("./updater.cjs");
const importer = require("./importer.cjs");
const buildRunner = require("./builder-run.cjs");
const importFactory = require("./import-factory.cjs");
const sandbox = require("./sandbox.cjs");
const capabilityIndex = require("./capabilities.cjs");
const capabilityVerify = require("./capability-verify.cjs");
const skillPack = require("./skill-pack.cjs");
const toolPack = require("./tool-pack.cjs");
const agentPack = require("./agent-pack.cjs");
const modulePack = require("./module-pack.cjs");
const workflowPack = require("./workflow-pack.cjs");
const fridayTools = require("./tools.cjs");
const fridayModules = require("./modules.cjs");
const connectors = require("./connectors.cjs");
const startupFlow = require("./startup.cjs");
const fridayBrowser = require("./browser.cjs");
const liveBrowser = require("./browser-live.cjs");
const screenVision = require("./screen-vision.cjs");
const diagramOcr = require("./diagram-ocr.cjs");
const camera = require("./camera.cjs");
const fridaySkills = require("./skills.cjs");
const fridayAgents = require("./agents.cjs");
// 2D desktop companion (additive; inert until the user enables it).
const characterRuntime = require("./character/runtime.cjs");
const { CharacterController } = require("./character/index.cjs");
// One authoritative renderer loader. The privileged scheme must be declared
// before the app is ready, so this runs at module scope.
const renderer = require("./renderer.cjs");
renderer.registerScheme();

const selfMaintenance = require("./self-maintenance.cjs");
const finetune = require("./finetune.cjs");
const sourceAccess = require("./source-access.cjs");
const plugins = require("./plugins.cjs");
const telemetry = require("./telemetry.cjs");
const modelsApi = require("./models.cjs");
const modelDownload = require("./model-download.cjs");
const { resolvePython, invalidatePython } = require("./python.cjs");
const tray = require("./tray.cjs");
const neuralVoice = require("./neural-voice.cjs");
const audioDuck = require("./audio-duck.cjs");
const meetingWatch = require("./meeting-watch.cjs");
const voiceprint = require("./voiceprint.cjs");
const stt = require("./stt.cjs");
const wakeEngine = require("./wake-engine.cjs");
const voiceVerify = require("./voice-verify.cjs");
const remoteAccess = require("./remote-access.cjs");
const fridayLibrary = require("./library.cjs");
const fridayProjects = require("./project-workspaces.cjs");

const { runReadiness } = require("./readiness.cjs");
// Single owner of "what already exists in this root and what may be deleted".
const storageManager = require("./storage-manager.cjs");
// Production EXE vs portable branch test EXE. Resolved and applied to the path
// service before ANY FRIDAY path is read, so a test build isolates its mutable
// state while still sharing the models/runtime/assets already on this PC.
const buildChannel = require("./build-channel.cjs");
const BUILD_CHANNEL = buildChannel.init({ app, paths });
// Shared with the setup scripts and the readiness test: ONE environment truth.
// In development it lives in the project; in the packaged app it ships as a
// resource, so both builds load exactly the same implementation.
const envRegistry = (() => {
  const candidates = [
    path.join(__dirname, "..", "scripts", "env-registry.cjs"),
    path.join(process.resourcesPath || "", "scripts", "env-registry.cjs"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return require(candidate);
    } catch (error) {
      console.error(`[friday] environment registry unavailable: ${error.message}`);
    }
  }
  // Never let a missing registry stop FRIDAY from starting.
  const empty = { version: 1, updatedAt: null, ready: false, blocking: [], components: [] };
  return {
    readRegistry: () => empty,
    refreshRegistry: () => empty,
    repairComponent: (id) => ({ ok: false, id, error: "registry unavailable in this build" }),
    repairAll: () => ({ registry: empty, results: [] }),
  };
})();

// Every IPC handler is instrumented once, here, so the Diagnostics page can
// show real call counts, durations and failures without each handler
// repeating the same bookkeeping.
const rawHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) =>
  rawHandle(channel, async (event, ...args) => {
    const started = Date.now();
    try {
      const result = await handler(event, ...args);
      telemetry.recordIpc({
        channel,
        ok: true,
        ms: Date.now() - started,
        bytes: telemetry.sizeOf(result),
      });
      return result;
    } catch (error) {
      telemetry.recordIpc({
        channel,
        ok: false,
        ms: Date.now() - started,
        error: String(error?.message || error),
      });
      throw error;
    }
  });

// One FRIDAY per machine: a second launch focuses the running window instead of
// spawning a duplicate kernel against the same workspace.
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

// Native spellchecking can block Chromium's UI thread while Windows language
// services initialise. Keep only the browser spellchecker disabled. Do not
// disable TSFImeSupport: Chromium needs its Text Services Framework path for
// reliable keyboard focus, composition and typing across Windows layouts. When
// it is disabled, every editable control can stop accepting input together.
app.commandLine.appendSwitch(
  "disable-features",
  "CalculateNativeWinOcclusion,WinUseBrowserSpellChecker,HardwareMediaKeyHandling",
);

// Boot self-test (scripts/verify-boot.cjs, scripts/windows-installer-smoke.ps1)
// runs FRIDAY on machines that have no real GPU and no interactive desktop
// session (CI runners, Windows Server images, RDP-detached sessions). Chromium's
// GPU/ANGLE stack faults with an access violation (0xC0000005 / exit -1073741819)
// there long before the window exists, which looks like an application crash but
// is a driver-surface problem. The self-test therefore renders through the
// software compositor: the SAME application, the SAME renderer bundle, only
// without a GPU device that does not exist. Normal launches keep full hardware
// acceleration.
if (process.env.FRIDAY_BOOT_SELFTEST) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("no-sandbox");
}

// Windows groups the taskbar icon and the installed shortcut by this id — with
// the default id the app is filed under "Electron" instead of FRIDAY.
app.setAppUserModelId("dev.friday.desk");

// ---- Diagnostics -----------------------------------------------------------
// A packaged app that throws before its first window would otherwise exit with
// no window and no message. Everything is written to a log next to the data.
function logFile() {
  try {
    // Canonical: <FRIDAY_ROOT>\logs\main.log. Before a folder is picked the
    // service falls back to userData so first-launch failures are still logged.
    return paths.logFile();
  } catch {
    return path.join(require("os").tmpdir(), "friday-main.log");
  }
}

function logRaw(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  process.stdout.write(line);
  try {
    const file = logFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line);
  } catch {
    // Logging must never take the app down.
  }
}

function log(message, level = "info") {
  try {
    telemetry.recordLog(level, "main", message);
  } catch {
    logRaw(message);
  }
}

process.on("uncaughtException", (err) => {
  const text = String(err?.stack || err);
  if (
    /Object has been destroyed|Render frame was disposed|closed or released|WebContents is not available/i.test(
      text,
    )
  ) {
    log(`ignored late shutdown exception: ${text.split("\n")[0]}`);
    return;
  }
  log(`uncaught exception: ${err?.stack || err}`, "error");
  if (win && !win.isDestroyed()) showLoadFailure(String(err?.stack || err));
  else if (app.isReady()) dialog.showErrorBox("FRIDAY failed to start", String(err?.stack || err));
});

process.on("unhandledRejection", (reason) => {
  const text = String((reason && reason.stack) || reason);
  // A window that closes while an async job is still finishing is normal
  // shutdown behaviour, not a fault — never surface it as an error.
  if (
    /Object has been destroyed|Render frame was disposed|closed or released|WebContents is not available/i.test(
      text,
    )
  ) {
    return;
  }
  log(`unhandled rejection: ${text}`);
});

const KERNEL_HOST = "127.0.0.1";
const KERNEL_PORT = 8765;
// Per-launch token: the kernel rejects any bridge client that does not present it.
const BRIDGE_TOKEN = crypto.randomBytes(32).toString("hex");
// Per-launch signing secret for tool authorizations. Only this process and the
// kernel it spawned know it, so nothing else can approve a risky tool call.
const TOOL_AUTHORITY_SECRET = crypto.randomBytes(32).toString("hex");
const REGISTRY_KEY = "HKCU\\Software\\FRIDAY";

let kernel = null;
let win = null;
let watcher = null;
let stayHiddenOnLaunch = false;
let forceVisible = false;
let lastScan = null;
let lastProviders = null;
let lastComponents = null;
let lastHardware = null;
const bootSteps = [];
const activeChats = new Map();
let kernelReady = false;
let kernelStartPromise = null;
// Why the kernel is unavailable, so chat can say something actionable.
let kernelFailure = "";
let kernelStderr = "";
let shutdownStarted = false;
/** Filled in after restartKernel() exists so the exit handler can recover. */
let kernelAuto = null;

// ---- Primary folder (chosen by the installer, persisted here) --------------
/** Packaged builds read the icon from resources/, dev reads it from the repo. */
function appIconPath() {
  const candidates = [
    path.join(process.resourcesPath || "", "resources", "icons", "friday.ico"),
    path.join(__dirname, "..", "resources", "icons", "friday.ico"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Unreadable path — try the next candidate.
    }
  }
  return undefined;
}

// Two settings files, one meaning. The copy in userData is only a bootstrap
// pointer (it is how we find the chosen folder at all); once a folder exists
// the authoritative copy lives in <workspace>/config, next to
// friday-preferences.json, so it survives reinstalls with the rest of the data.
const bootstrapSettingsFile = () => path.join(app.getPath("userData"), "friday-settings.json");

const workspaceSettingsFile = (root) =>
  root ? path.join(root, "config", "friday-settings.json") : null;

/**
 * Read a FRIDAY config file. A file that is present but unreadable (truncated
 * by a crash, edited by hand) is quarantined next to itself instead of being
 * silently ignored: the owner keeps the old bytes, FRIDAY starts from a valid
 * record, and the same repair never has to run twice. Nothing here ever opens
 * a file with the OS shell — config is only ever read and written in-process.
 */
function readJsonFile(file, { repair = false } = {}) {
  let raw = null;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return {}; // absent is normal, not a fault
  }
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value : {};
  } catch (error) {
    if (repair) {
      try {
        const backup = `${file}.corrupt-${Date.now()}`;
        fs.writeFileSync(backup, raw);
        fs.rmSync(file, { force: true });
        log(`config repaired: ${file} was not valid JSON — kept a copy at ${backup}`);
      } catch (writeError) {
        log(`config repair failed for ${file}: ${writeError?.message || writeError}`);
      }
    } else {
      log(`config unreadable: ${file} (${error?.message || error})`);
    }
    return {};
  }
}

function readSettings() {
  const bootstrap = readJsonFile(bootstrapSettingsFile());
  const file = workspaceSettingsFile(bootstrap.workspaceRoot);
  if (!file || !fs.existsSync(file)) return bootstrap;
  return { ...bootstrap, ...readJsonFile(file) };
}

/**
 * Validate the ONE canonical config location (<FRIDAY_ROOT>/config) before any
 * subsystem reads it. Idempotent: a healthy config is left untouched, a corrupt
 * one is quarantined and rewritten from the values FRIDAY already knows, and no
 * user data is lost. Returns the repairs that were actually made.
 */
function ensureCanonicalConfig(root) {
  if (!root) return { root: null, repaired: [] };
  const repaired = [];
  const dir = path.join(root, "config");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    log(`config folder could not be created in ${root}: ${error?.message || error}`);
    return { root, repaired };
  }
  const bootstrap = readJsonFile(bootstrapSettingsFile(), { repair: true });
  const file = path.join(dir, "friday-settings.json");
  if (fs.existsSync(file)) {
    const before = fs.existsSync(file);
    const value = readJsonFile(file, { repair: true });
    if (before && !fs.existsSync(file)) {
      repaired.push("friday-settings.json");
      try {
        fs.writeFileSync(file, JSON.stringify({ ...bootstrap, workspaceRoot: root }, null, 2));
      } catch (error) {
        log(`config could not be rewritten: ${error?.message || error}`);
      }
    } else if (value.workspaceRoot && path.resolve(value.workspaceRoot) !== path.resolve(root)) {
      // A folder that was copied or renamed still points at its old location.
      // Rewriting the pointer keeps ONE root instead of resurrecting a second.
      try {
        fs.writeFileSync(file, JSON.stringify({ ...value, workspaceRoot: root }, null, 2));
        repaired.push("workspaceRoot");
      } catch (error) {
        log(`config pointer could not be updated: ${error?.message || error}`);
      }
    }
  } else {
    try {
      fs.writeFileSync(file, JSON.stringify({ ...bootstrap, workspaceRoot: root }, null, 2));
      repaired.push("friday-settings.json");
    } catch (error) {
      log(`config could not be created: ${error?.message || error}`);
    }
  }
  return { root, repaired };
}

// The persisted pointer is the earliest moment the real root is known, so the
// path service is primed here — before any subsystem asks for a folder.
try {
  paths.setRoot(readJsonFile(bootstrapSettingsFile()).workspaceRoot || null);
} catch {
  /* no pointer yet: the fallback root stays in effect until setup runs */
}
try {
  telemetry.hydrate();
} catch {
  /* empty or unreadable log file is fine */
}

/** Kept for diagnostics/back-compat: the path settings are read from today. */
const settingsFile = () =>
  workspaceSettingsFile(readSettings().workspaceRoot) || bootstrapSettingsFile();

function writeSettings(next) {
  const bootstrap = bootstrapSettingsFile();
  fs.mkdirSync(path.dirname(bootstrap), { recursive: true });
  // The pointer must always be readable before any folder is known.
  fs.writeFileSync(
    bootstrap,
    JSON.stringify({ workspaceRoot: next.workspaceRoot || null }, null, 2),
  );
  const file = workspaceSettingsFile(next.workspaceRoot);
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2));
  } catch (error) {
    log(`settings could not be written to the workspace: ${error?.message || error}`);
  }
}

// The installer writes the chosen workspace to HKCU\Software\FRIDAY.
function readRegistryWorkspace() {
  if (process.platform !== "win32") return null;
  return new Promise((resolve) => {
    execFile(
      "reg",
      ["query", REGISTRY_KEY, "/v", "WorkspacePath"],
      // windowsHide keeps the console window of `reg` off the screen; without
      // it every launch flashes a black window over FRIDAY.
      { windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const match = /WorkspacePath\s+REG_SZ\s+(.+)/i.exec(stdout);
        resolve(match ? match[1].trim() : null);
      },
    );
  });
}

function writeRegistryWorkspace(root) {
  if (process.platform !== "win32") return;
  execFile(
    "reg",
    ["add", REGISTRY_KEY, "/v", "WorkspacePath", "/t", "REG_SZ", "/d", root, "/f"],
    { windowsHide: true },
    () => {},
  );
}

async function resolveWorkspaceRoot() {
  const publish = (value) => {
    paths.setRoot(value || null);
    return value || null;
  };
  // A pointer to a folder that no longer exists (the user moved or deleted it)
  // must never be published: FRIDAY stops and asks for a folder again instead
  // of quietly recreating a second home at the stale path.
  const usable = (value) => {
    if (!value) return null;
    try {
      if (fs.statSync(value).isDirectory()) return path.resolve(value);
    } catch {
      /* not on disk any more */
    }
    log(`the recorded FRIDAY folder is not available: ${value} — asking for a folder`);
    return null;
  };
  const fromEnv = usable(process.env.FRIDAY_WORKSPACE_ROOT);
  if (fromEnv) {
    // An explicitly selected folder is recorded like any other selection, so
    // the next launch rediscovers exactly the same root on its own.
    writeSettings({ ...readSettings(), workspaceRoot: fromEnv });
    return publish(fromEnv);
  }

  // Setup is the authoritative workspace selector. This must be checked before
  // the cached renderer setting so reinstall/repair can intentionally select a
  // different existing FRIDAY folder without deleting any user data.
  const fromRegistry = usable(await readRegistryWorkspace());
  if (fromRegistry) {
    writeSettings({ ...readSettings(), workspaceRoot: fromRegistry });
    return publish(fromRegistry);
  }
  const stored = usable(readSettings().workspaceRoot);
  if (stored) return publish(stored);
  // No invented default: first run must ask for a folder.
  return publish(null);
}

function getWorkspaceRoot() {
  return readSettings().workspaceRoot || null;
}

/**
 * Where FRIDAY's own runtime data lives. Workspace first — the folder the user
 * picked owns the database, memory, conversations and state — with userData as
 * the fallback only before setup has chosen a folder.
 */
function dataDir() {
  return paths.dir("data");
}

/**
 * Storage root for encrypted provider keys: the selected FRIDAY folder and
 * nothing else. Before setup there is no credential store — keys are never
 * parked in userData or a temp folder where they would outlive an uninstall.
 */
function keyStoreRoot() {
  return paths.root();
}

function setWorkspaceRoot(root) {
  // Every subsystem reads its folders from the path service, so the root must
  // be published here before anything else touches disk.
  paths.setRoot(root);
  writeSettings({ ...readSettings(), workspaceRoot: root });
  writeRegistryWorkspace(root);
  // Legacy credential files (root-level, or the pre-setup bootstrap folder)
  // are folded into <root>/config exactly once, then the canonical store is
  // the only authority. Nothing about the key values is logged.
  try {
    const bootstrap = [];
    try {
      bootstrap.push(app.getPath("userData"));
    } catch {
      /* not available in tests */
    }
    require("./models.cjs").migrateCredentials(root, bootstrap);
  } catch (error) {
    log(`credential migration skipped: ${error?.message || error}`);
  }
  try {
    telemetry.hydrate();
  } catch {
    /* new folder may not have a log yet */
  }
  return root;
}

// ---- Startup sequence ------------------------------------------------------
function send(channel, payload) {
  try {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send(channel, payload);
  } catch (error) {
    logRaw(`renderer event dropped (${channel}): ${error?.message || error}`);
  }
}

// One canonical live telemetry sampler for the whole app (CPU/RAM/GPU/disk).
systemMonitor.init(send);
telemetry.init(send);
// One canonical live prober for FRIDAY's own services (kernel/db/engines).
serviceHealth.init(send, {
  kernelUrl: `http://${KERNEL_HOST}:${KERNEL_PORT}`,
  userData: keyStoreRoot,
});

/** Boot progress: buffered so the UI gets the full sequence once it loads. */
function boot(label, status = "ok", detail = "") {
  const step = { label, status, detail, at: Date.now() };
  bootSteps.push(step);
  send("boot:step", step);
  return step;
}

// A full scan walks the whole workspace, so it is never run twice for the same
// question: the UI gets the cached result unless it explicitly asks to refresh.
let rescanTimer = null;
let scanGeneration = 0;

function rescan(root) {
  if (!root) return null;
  const generation = ++scanGeneration;
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "scan-worker.cjs"), { workerData: { root } });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(result);
    };
    worker.once("message", (message) => {
      if (!message?.ok) {
        finish(new Error(message?.error || "Workspace scan failed"));
        return;
      }
      if (generation === scanGeneration) {
        lastScan = message.result;
        send("workspace:scanned", lastScan);
      }
      finish(null, message.result);
    });
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) => {
      if (code !== 0) finish(new Error(`Workspace scan worker stopped (${code})`));
    });
  });
}

let connectivityTimer = null;

/** Debounced connectivity recompute + broadcast (watcher and imports use it). */
function scheduleConnectivityRefresh(delay = 2000) {
  if (connectivityTimer) return;
  connectivityTimer = setTimeout(() => {
    connectivityTimer = null;
    try {
      const graph = connectivityGraph.connectivity(
        projectPaths.resolveProjectRoot({ appPath: app.getAppPath() }),
        { refresh: true },
      );
      send("connectivity:changed", { at: graph.at, ok: graph.ok, summary: graph.summary });
    } catch (error) {
      log(`connectivity refresh failed: ${error.message}`);
    }
  }, delay);
}

/** Coalesced rescan used by the watcher — bursts of edits cost one scan. */
function scheduleRescan(root, delay = 1200) {
  if (rescanTimer) return;
  if (ownerPrefToggle("autoIndex", true) === false) return;
  rescanTimer = setTimeout(() => {
    rescanTimer = null;
    void rescan(root || getWorkspaceRoot()).catch((error) =>
      log(`workspace rescan failed: ${error.message}`),
    );
  }, delay);
}

function startWatching(root) {
  if (ownerPrefToggle("repoWatch", true) === false) {
    if (watcher) {
      watcher.stop();
      watcher = null;
    }
    return;
  }
  watcher ??= new WorkspaceWatcher((change) => {
    // Classify with the same rules the importer uses so hot-reloadable areas
    // are reported exactly like an applied import.
    const { area, hot } = importer.classify(`${change.component}/${change.file || ""}`);
    // Tell the UI immediately; the expensive rescan is coalesced behind it.
    // A change only requires a restart when the file is genuinely read once at
    // process start (watcher.RESTART_FILES). Hot areas reload in place, and
    // FRIDAY's own runtime writes never ask the user to restart.
    const restartRequired = Boolean(change.restartRequired);
    if (restartRequired) noteRestartRequired(change.relative || change.component);
    send("workspace:changed", { ...change, area, hot, restartRequired });
    void plugins
      .dispatch(
        capabilityRoots(),
        "on-file-change",
        {
          component: change.component,
          file: change.file || "",
          relative: change.relative || `${change.component}/${change.file || ""}`,
          at: change.at || Date.now(),
        },
        { services: pluginServices },
      )
      .catch((error) => log(`plugin on-file-change failed: ${error?.message || error}`));
    // Feed the same event into self-maintenance: it updates the architecture
    // index and publishes an impact verdict for this change.
    selfMaintenance.noteChange({
      path: `${change.component}/${change.file || ""}`,
      component: change.component,
      file: change.file,
    });
    scheduleRescan(getWorkspaceRoot());
    // The connection graph is derived from files, so a change can invalidate
    // it. Recomputing is cheap and debounced by the same burst timer, which is
    // what keeps every section's list connected after a future upgrade.
    scheduleConnectivityRefresh();
  });
  watcher.start(root);
}

/**
 * The kernel's canonical config folder: <FRIDAY root>/config. The seed files
 * that ship with the build (models.yaml, kernel.yaml) are copied in once so the
 * installed EXE never reads them from a development checkout, and the owner can
 * edit their own copy afterwards without an update overwriting it.
 */
function ensureKernelConfigDir() {
  let configDir = null;
  try {
    configDir = paths.dir("config");
  } catch {
    return null;
  }
  if (!configDir) return null;
  try {
    fs.mkdirSync(configDir, { recursive: true });
    const sources = [
      path.join(process.resourcesPath || "", "config"),
      path.join(__dirname, "..", "config"),
    ];
    for (const name of ["models.yaml", "kernel.yaml"]) {
      const target = path.join(configDir, name);
      if (fs.existsSync(target)) continue;
      const from = sources.map((base) => path.join(base, name)).find((file) => fs.existsSync(file));
      if (from) fs.copyFileSync(from, target);
    }
  } catch (error) {
    log(`kernel config seed failed: ${error?.message || error}`);
  }
  return configDir;
}

async function startKernel(root) {
  // Single-root rule: the kernel owns SQLite, memory and state, so it must
  // never run before a FRIDAY folder exists — starting it early would create a
  // second FRIDAY-owned data store under AppData. First run asks for a folder
  // and restartKernel() brings the service up the moment one is selected.
  if (!root) {
    kernelReady = false;
    kernelFailure = "No FRIDAY folder has been selected yet.";
    boot("Starting services", "warn", kernelFailure);
    return;
  }
  // Never run two kernels against one SQLite file / port.
  if (kernel) await stopKernel();

  // A packaged app must resolve its interpreter from the installed runtime and
  // the selected FRIDAY folder — never from a source checkout that only exists
  // on a development machine.
  const resolvedPython = await resolvePython(app.isPackaged ? null : path.join(__dirname, ".."));
  const python = resolvedPython?.exe;
  const pythonPrefix = resolvedPython?.prefix || [];

  const packaged = path.join(process.resourcesPath || "", "kernel", "main.py");
  const entry = fs.existsSync(packaged)
    ? packaged
    : path.join(__dirname, "..", "kernel", "main.py");
  const kernelConfigDir = ensureKernelConfigDir();

  kernelReady = false;
  kernelFailure = "";

  if (!fs.existsSync(entry)) {
    kernelFailure = `The local AI service is missing from this installation (${entry}).`;
    boot("Starting services", "warn", kernelFailure);
    return;
  }

  if (!python) {
    kernelFailure =
      "FRIDAY's isolated Python 3.12 runtime was not found. Run Setup again to repair it.";
    boot("Starting services", "warn", kernelFailure);
    return;
  }

  try {
    kernel = spawn(python, [...pythonPrefix, entry], {
      env: {
        ...process.env,
        FRIDAY_BRIDGE_TOKEN: BRIDGE_TOKEN,
        FRIDAY_TOOL_AUTHORITY_SECRET: TOOL_AUTHORITY_SECRET,
        FRIDAY_HOST: KERNEL_HOST,
        FRIDAY_PORT: String(KERNEL_PORT),
        // Workspace first: everything the user owns stays in the folder they
        // picked. userData is used only before setup has chosen one.
        FRIDAY_DATA_DIR: dataDir(),
        // The one config folder the kernel reads models.yaml/kernel.yaml from.
        ...(kernelConfigDir ? { FRIDAY_CONFIG_DIR: kernelConfigDir } : {}),
        // A read-only install folder must never be written to at import time.
        PYTHONDONTWRITEBYTECODE: "1",
        // The kernel re-scans this root on every launch and then watches it.
        FRIDAY_WORKSPACE_ROOT: root || "",
        // Packaged builds never read a source checkout; only a dev run may.
        FRIDAY_PACKAGED: app.isPackaged ? "1" : "",
        // Phone companion: the kernel only listens on the LAN when the user
        // turned this on in Settings. Off means loopback only.
        FRIDAY_LAN: readSettings().companionEnabled ? "1" : "",
        // Hardware auto-tuning: the kernel and its providers size themselves
        // from the profile the app already detected instead of guessing.
        ...(lastHardware
          ? {
              FRIDAY_BACKEND: lastHardware.plan.backend,
              FRIDAY_THREADS: String(lastHardware.plan.threads),
              FRIDAY_MAX_RAM_GB: String(lastHardware.plan.maxRamGb),
              FRIDAY_MAX_VRAM_GB: String(lastHardware.plan.maxVramGb),
              FRIDAY_GPU_FALLBACK: lastHardware.plan.fallback,
            }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
      // Without this Windows opens a console window for the Python kernel on
      // every launch and restart — the "popup" the owner sees at boot.
      windowsHide: true,
    });
  } catch (error) {
    kernel = null;
    kernelFailure = `Python could not be started (${python}). Install Python 3 and reopen FRIDAY.`;
    log(`kernel spawn failed: ${error?.stack || error}`);
    boot("Starting services", "warn", kernelFailure);
    return;
  }

  // The last lines of kernel output make an unavailable kernel diagnosable.
  const forward = (level) => (chunk) => {
    const text = chunk.toString();
    if (level === "error") kernelStderr = `${kernelStderr}${text}`.slice(-2000);
    send("kernel:log", { level, text });
    for (const line of String(text).split(/\r?\n/)) {
      if (line.trim()) telemetry.recordLog(level === "error" ? "error" : "info", "kernel", line);
    }
    process.stdout.write(`[kernel:${level}] ${text}`);
  };

  kernel.stdout.on("data", forward("info"));
  kernel.stderr.on("data", forward("error"));
  kernel.on("error", (err) => {
    kernelReady = false;
    kernel = null;
    kernelFailure =
      err?.code === "ENOENT"
        ? `Python was not found (tried "${python}"). Install Python 3 and reopen FRIDAY.`
        : `The local AI service could not start: ${err.message}`;
    send("kernel:log", { level: "error", text: String(err) });
    telemetry.recordLog("error", "kernel", String(err));
    boot("Starting services", "warn", kernelFailure);
    serviceHealth.invalidate();
  });
  kernel.on("exit", (code) => {
    kernelReady = false;
    kernel = null;
    if (code !== 0 && code !== null) {
      const tail = kernelStderr.trim().split("\n").slice(-2).join(" ").slice(0, 300);
      kernelFailure = `The local AI service stopped (exit ${code}).${tail ? ` ${tail}` : ""}`;
    }
    send("kernel:exit", { code });
    // Drop the last health snapshot so the UI cannot keep showing kernel
    // "online" for the rest of the 5s probe window after a real crash.
    serviceHealth.invalidate();
    // Unexpected mid-session crash: try restartKernel() with backoff. A
    // deliberate stop (apply-fix, folder change, quit) is ignored here.
    kernelAuto?.onProcessExit(code, { shutdownStarted });
  });

  kernelStartPromise = waitForKernel().finally(() => {
    kernelStartPromise = null;
  });
}

/* ------------------------------------------------- shared session listener */
/**
 * ONE conversation across devices.
 *
 * The kernel broadcasts every turn that arrives from the paired phone. This
 * long-lived socket mirrors those turns into the desktop UI in real time, so
 * the owner sees one continuous conversation no matter which device they used.
 * It reconnects with backoff and never blocks chat, which has its own socket.
 */
let sessionSocket = null;
let sessionRetry = null;
let sessionBackoff = 1000;

function connectSessionStream() {
  const WebSocketImpl = getWebSocket();
  if (!WebSocketImpl || sessionSocket || app.__fridayQuitting) return;
  let socket;
  try {
    socket = new WebSocketImpl(`ws://${KERNEL_HOST}:${KERNEL_PORT}/bridge`);
  } catch {
    return scheduleSessionReconnect();
  }
  sessionSocket = socket;
  socket.addEventListener("open", () => {
    sessionBackoff = 1000;
    socket.send(JSON.stringify({ token: BRIDGE_TOKEN }));
  });
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    // Only unsolicited broadcasts: request/response traffic has an id.
    if (message.id !== undefined) return;
    if (message.type === "session.message") send("session:message", message.data || {});
    else if (message.type === "companion.cognize") send("companion:cognize", message.data || {});
    else if (message.type === "chat.delta" && message.data?.origin === "phone")
      send("session:delta", message.data);
    else if (message.type === "privacy.ask") void handleCompanionPrivacyAsk(message.data || {});
    else if (message.type === "billing.spent") {
      // The kernel spent a one-shot unlock at its own provider boundary. The
      // desktop owns the persisted record, so mirror the spend here too.
      const spent = billingPolicy.normaliseBilling(message.data?.billing || {});
      if (spent.grantScope !== billingState().grantScope) {
        writeSettings({ ...readSettings(), billing: spent });
        publishBilling(spent);
      }
    }
  });
  const drop = () => {
    if (sessionSocket === socket) sessionSocket = null;
    scheduleSessionReconnect();
  };
  socket.addEventListener("close", drop);
  socket.addEventListener("error", drop);
}

function sendSessionKernel(method, params) {
  const sock = sessionSocket;
  if (!sock) return false;
  try {
    sock.send(JSON.stringify({ id: Date.now(), method, params: params || {} }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Companion/phone SENSITIVE turns fail closed unless this desktop window
 * answers. The kernel already classified; forceAsk so a truncated payload
 * cannot auto-send.
 */
async function handleCompanionPrivacyAsk(data) {
  const model = {
    id: data.modelId,
    type: "cloud",
    meta: { providerId: String(data.modelId || "").split(":")[0] },
  };
  const verdict = await confirmEgress({
    model,
    content: String(data.content || ""),
    label: data.label || "companion chat",
    forceAsk: true,
  });
  const sock = sessionSocket;
  if (!sock) return;
  try {
    sock.send(
      JSON.stringify({
        id: Date.now(),
        method: "privacy.decide",
        params: { askId: data.id, allowed: Boolean(verdict.allowed) },
      }),
    );
  } catch {
    /* session socket dropped */
  }
}

function scheduleSessionReconnect() {
  if (sessionRetry || app.__fridayQuitting) return;
  sessionRetry = setTimeout(() => {
    sessionRetry = null;
    sessionBackoff = Math.min(sessionBackoff * 2, 30_000);
    if (kernelReady) connectSessionStream();
  }, sessionBackoff);
}

async function waitForKernel(timeoutMs = 20000) {
  // A known spawn/configuration failure cannot heal by polling an unopened
  // port. Return immediately so chat and diagnostics stay responsive.
  if (!kernelReady && !kernel && !kernelStartPromise && kernelFailure) return false;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // The child died (crash or deliberate stop). Stop polling so auto-restart
    // can take over instead of burning the rest of the timeout against a dead port.
    if (!kernel && !kernelReady) return false;
    try {
      const response = await fetch(`http://${KERNEL_HOST}:${KERNEL_PORT}/health`, {
        signal: AbortSignal.timeout(800),
      });
      if (response.ok) {
        kernelReady = true;
        kernelFailure = "";
        connectSessionStream();
        // The kernel starts locked down; hand it the owner's real policy.
        void pushBillingToKernel();
        serviceHealth.invalidate();
        return true;
      }
    } catch {
      // Kernel process is still importing or binding the local port.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/** True while something still holds the kernel's local port. */
function portBusy(port) {
  return new Promise((resolve) => {
    const probe = net.createConnection({ host: KERNEL_HOST, port }, () => {
      probe.destroy();
      resolve(true);
    });
    probe.on("error", () => resolve(false));
    probe.setTimeout(500, () => {
      probe.destroy();
      resolve(false);
    });
  });
}

/**
 * Stop the running kernel and WAIT for it to be gone.
 *
 * Restarting used to kill the old process and immediately spawn a new one; on
 * Windows the old process still held port 8765 for a moment, so the new kernel
 * died with "address in use" and chat went silent until the next restart. Now
 * the exit is awaited, the port is polled until it is free, and only then does
 * the caller start a new kernel.
 */
async function stopKernel({ timeoutMs = 10_000 } = {}) {
  kernelAuto?.beginExpectedStop();
  const child = kernel;
  kernel = null;
  kernelReady = false;
  if (child && !child.killed) {
    const exited = new Promise((resolve) => {
      child.once("exit", () => resolve(true));
      setTimeout(() => resolve(false), timeoutMs).unref?.();
    });
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    const clean = await exited;
    if (!clean) {
      try {
        if (process.platform === "win32" && child.pid) {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        // Nothing else we can do; the port poll below decides.
      }
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portBusy(KERNEL_PORT))) {
      kernelAuto?.endExpectedStop();
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  kernelAuto?.endExpectedStop();
  return false;
}

let kernelRestart = Promise.resolve();

/** Serialised restart: stop -> port free -> start. Never overlaps itself. */
function restartKernel({ reason = "manual" } = {}) {
  // Diagnostics / folder change: reset the crash-storm counter so a later
  // unexpected exit can auto-recover again. Auto-recovery must not reset
  // itself or a tight crash loop would never hit the cap.
  if (reason !== "auto") kernelAuto?.noteManualRestart();
  // A re-selected FRIDAY folder can bring its own runtime/.venv with it.
  invalidatePython();
  kernelRestart = kernelRestart
    .catch(() => {})
    .then(async () => {
      const free = await stopKernel();
      if (!free) log("kernel port still busy after stop — starting anyway");
      await startKernel(getWorkspaceRoot());
    });
  return kernelRestart;
}

kernelAuto = kernelAutoRestart.createKernelAutoRestart({
  restartKernel: () => restartKernel({ reason: "auto" }),
  waitUntilReady: () => waitForKernel(),
  onAttempt({ attempt, maxAttempts, delayMs, code }) {
    log(`kernel auto-restart ${attempt}/${maxAttempts} in ${delayMs}ms (exit ${code})`);
    send("kernel:recover", {
      phase: "trying",
      attempt,
      maxAttempts,
      delayMs,
      code,
      message: `The local AI service stopped. Restarting (${attempt}/${maxAttempts})…`,
    });
  },
  onRecovered({ attempts }) {
    kernelFailure = "";
    log(`kernel auto-restart recovered after ${attempts} attempt(s)`);
    send("kernel:recover", {
      phase: "recovered",
      attempts,
      message: "The local AI service recovered.",
    });
  },
  onGaveUp({ attempts, maxAttempts, code }) {
    log(`kernel auto-restart gave up after ${attempts}/${maxAttempts} (exit ${code})`);
    send("kernel:recover", {
      phase: "failed",
      attempts,
      maxAttempts,
      code,
      message: kernelFailure || `The local AI service stopped (exit ${code}).`,
      steps: require("./diagnostics.cjs").kernelOwnerSteps(),
    });
  },
});

/** Bring the kernel back after an update step that had to stop it for file locks. */
function resumeKernel(reason) {
  return restartKernel().catch((error) => {
    log(`${reason || "kernel resume"}: ${error?.message || error}`);
  });
}

function stopOwnedProcesses() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  kernelAuto?.cancelAll();
  activeChats.forEach((_socket, requestId) => stopChat(requestId));
  if (watcher) {
    watcher.stop();
    watcher = null;
  }
  if (kernel) {
    try {
      kernel.kill();
    } catch {
      // The kernel may already have exited.
    }
    kernel = null;
  }
  try {
    stt.shutdown();
  } catch {
    /* worker may already be gone */
  }
  try {
    wakeEngine.shutdown();
  } catch {
    /* worker may already be gone */
  }
}

function stopChat(requestId) {
  const socket = activeChats.get(requestId);
  if (!socket) return;
  socket.__fridayCancelled = true;
  activeChats.delete(requestId);
  try {
    socket.close(1000, "cancelled");
  } catch {
    // The socket may already be closing.
  }
}

// --------------------------------------------- routable models → AI kernel
// The Models page detects what this machine can actually run. Those models are
// pushed into the Python router so chat can use them; nothing is invented and
// a cloud model only appears when its key answered a real API call.
const ROUTABLE_TTL_MS = 30000;
// A local engine (Ollama, LM Studio) needs a few seconds after boot before it
// answers. An empty catalogue is therefore treated as "not settled yet" and is
// only cached briefly — otherwise the first boot probe would pin "no models"
// for a full TTL and the owner would see an empty selector after every restart.
const EMPTY_ROUTABLE_TTL_MS = 4000;
let routableCache = { at: 0, models: [] };
let routableInFlight = null;
let kernelSyncInFlight = null;

async function refreshRoutable(force = false) {
  const ttl = routableCache.models.length ? ROUTABLE_TTL_MS : EMPTY_ROUTABLE_TTL_MS;
  if (!force && routableCache.at && Date.now() - routableCache.at < ttl) return routableCache;
  if (routableInFlight) return routableInFlight;
  routableInFlight = modelsApi
    .routable(modelsContext())
    .then((result) => {
      routableCache = result;
      return result;
    })
    .catch((error) => {
      log(`model detection failed: ${error?.message || error}`);
      return routableCache;
    })
    .finally(() => {
      routableInFlight = null;
    });
  return routableInFlight;
}

let lastKernelSyncHash = "";
let modelRefreshTimer = null;
const MODEL_REFRESH_MS = modelAccess.CATALOGUE_TTL_MS || 10 * 60 * 1000;

/**
 * Stamp a lifecycle kind onto the existing models:* broadcasts.
 * Brain already listens to registry-changed / health-changed; this is the
 * same snapshot, with a reason, not a second event bus.
 */
function emitModelLifecycle(kind, extra = {}) {
  const payload = { kind, at: Date.now(), ...extra };
  if (kind === "ROUTE_CHANGED") return payload;
  if (
    kind === "MODEL_FAILED" ||
    kind === "MODEL_RATE_LIMITED" ||
    kind === "MODEL_EXHAUSTED" ||
    kind === "MODEL_RETIRED" ||
    kind === "MODEL_VERIFIED"
  ) {
    send("models:health-changed", payload);
    return payload;
  }
  send("models:registry-changed", payload);
  return payload;
}

function startModelRegistryRefresh() {
  if (modelRefreshTimer) return;
  modelRefreshTimer = setInterval(() => {
    void refreshRoutable(true).then((result) => {
      void syncKernelModels();
      emitModelLifecycle("MODEL_UPDATED", {
        reason: "ttl-refresh",
        count: Array.isArray(result?.models) ? result.models.length : 0,
      });
    });
  }, MODEL_REFRESH_MS);
}

function stopModelRegistryRefresh() {
  if (!modelRefreshTimer) return;
  clearInterval(modelRefreshTimer);
  modelRefreshTimer = null;
}

/** Register everything reachable with the kernel router — idempotent. */
async function syncKernelModels(force = false) {
  if (kernelSyncInFlight) return kernelSyncInFlight;
  kernelSyncInFlight = (async () => {
    const { models } = await refreshRoutable(force);
    if (!kernelReady) return { ok: false, error: "kernel not ready", registered: 0 };
    // The kernel must see the SAME classification and capability record the
    // desktop routed on, so a kernel-side path cannot re-guess them.
    const specs = models.map(({ meta, ...spec }) => ({
      ...spec,
      type: meta?.kind || spec.type || null,
      access: modelRouter.classifyAccess({ ...spec, meta }),
      accessRecord: modelAccess.accessOf({ ...spec, meta }),
      capabilities: modelRouter.capabilitiesOf({ ...spec, meta }),
    }));

    const currentHash = `${specs.length}:${specs.map((s) => `${s.id}:${s.accessRecord?.verification}:${s.status}`).join(",")}`;
    if (!force && lastKernelSyncHash === currentHash) {
      return { ok: true, registered: specs.length, cached: true };
    }

    try {
      await pushBillingToKernel();
      const result = await kernelRequest("model.sync", { models: specs }, 20000);
      lastKernelSyncHash = currentHash;
      send("models:kernel-sync", { at: Date.now(), ...result });
      return { ok: true, ...result };
    } catch (error) {
      const message = String(error?.message || error);
      log(`model sync failed: ${message}`);
      return { ok: false, error: message, registered: 0 };
    }
  })().finally(() => {
    kernelSyncInFlight = null;
  });
  return kernelSyncInFlight;
}

/**
 * Auto mode. Turns the renderer's request (explicit ids, or nothing at all)
 * into the ordered list of real model ids the kernel should try.
 */
async function resolveChatModels(
  requested = [],
  task = "chat",
  routeModeOverride = null,
  extraOptions = {},
) {
  const { models } = await refreshRoutable();
  if (!models.length) return [];
  const preferred = requested.filter(Boolean).length ? requested.filter(Boolean) : modelSelection();
  // A paid model may only be used when the OWNER picked it for this request.
  const explicitPaid = preferred.some((id) => {
    const spec = models.find((m) => m.id === id || m.meta?.modelName === id);
    return spec ? modelRouter.classifyAccess(spec) === "paid" : false;
  });
  // Real reachability, not navigator.onLine: with no route to the internet
  // every cloud candidate would just time out, so routing goes local-only.
  const network = await checkNetwork();
  const policy = extraOptions.costPolicy
    ? modelRouter.policyForCostMode(extraOptions.costPolicy)
    : effectiveUsagePolicy({ explicitPaid });
  const resolvedMode = routeModeOverride || modelRouteMode();
  const requirements = extraOptions.requirements || {};
  const selectedProviderIds = extraOptions.selectedProviderIds || [];
  const limit = extraOptions.limit || 4;

  const routeOptions = {
    task,
    preferred,
    policy,
    mode: resolvedMode,
    offline: !network.online,
    health: providerHealth,
    limit,
    requirements,
    selectedProviderIds,
    qualityTarget: extraOptions.qualityTarget || modelQualityTarget(),
    strategy: extraOptions.strategy || modelRouteStrategy(),
    now: Date.now(),
  };
  await modelsApi.lazyVerifyForRoute(models, routeOptions);
  // The live probe may have promoted a free-class candidate to VERIFIED.
  // Mirror that exact record into the kernel before its independent billing
  // firewall sees the request; otherwise the kernel would still hold the
  // earlier UNVERIFIED catalogue snapshot and correctly block it.
  await syncKernelModels();
  const plan = modelRouter.planRoute(models, routeOptions);
  log(`route plan (${plan.planType}): ${plan.why}`);
  return modelRouter.selectEligible(models, routeOptions);
}

/**
 * Network detection for the router, with change broadcast so the UI (and the
 * offline banner) reflects the same truth the router used.
 */
async function checkNetwork(force = false) {
  const before = netStatus.snapshot().online;
  const result = await netStatus.check(force);
  if (result.online !== before) {
    log(`network ${result.online ? "online" : "offline"} — ${result.detail}`);
    send("system:network", result);
  }
  return result;
}

/** Where inference may run — authoritative in the main process. */
function modelRouteMode() {
  return modelRouter.normaliseRouteMode(readSettings().modelRouteMode);
}

function modelQualityTarget() {
  return modelRouter.normaliseQualityTarget(readSettings().modelQualityTarget);
}

function setModelQualityTarget(value) {
  const qualityTarget = modelRouter.normaliseQualityTarget(value);
  writeSettings({ ...readSettings(), modelQualityTarget: qualityTarget });
  log(`model quality target set to ${qualityTarget}`);
  return { qualityTarget };
}

function modelRouteStrategy() {
  return modelRouter.normaliseStrategy(readSettings().modelRouteStrategy);
}

function setModelRouteStrategy(value) {
  const strategy = modelRouter.normaliseStrategy(value);
  writeSettings({ ...readSettings(), modelRouteStrategy: strategy });
  log(`model route strategy set to ${strategy}`);
  return { strategy };
}

function setModelRouteMode(value) {
  const mode = modelRouter.normaliseRouteMode(value);
  writeSettings({ ...readSettings(), modelRouteMode: mode });
  routableCache = { ...routableCache, at: 0 };
  log(`model route mode set to ${mode}`);
  emitModelLifecycle("ROUTE_CHANGED", { mode });
  send("models:route-mode", { mode, kind: "ROUTE_CHANGED" });
  return { mode };
}

/** Owner-picked model ids — same pool chat, voice and companion read. */
function modelSelection() {
  const raw = readSettings().modelSelection;
  return Array.isArray(raw) ? raw.map((id) => String(id || "").trim()).filter(Boolean) : [];
}

function setModelSelection(ids) {
  const next = Array.isArray(ids) ? ids.map((id) => String(id || "").trim()).filter(Boolean) : [];
  writeSettings({ ...readSettings(), modelSelection: next });
  send("models:selection", { ids: next });
  return { ids: next };
}

/**
 * Billing safety — authoritative in the main process. A stored paid API key
 * is NOT permission to spend: paid inference stays locked until the owner
 * enables it (or grants it for this request/session), and the kill switch
 * overrides everything. The UI can only ask; this is what actually blocks.
 */
function billingState() {
  return billingPolicy.normaliseBilling(readSettings().billing);
}

/** The policy the router must enforce right now. */
function effectiveUsagePolicy(options = {}) {
  return billingPolicy.effectivePolicy(billingState(), {
    requested: modelRouter.normalisePolicy(readSettings().modelUsagePolicy),
    explicitPaid: Boolean(options.explicitPaid),
    now: Date.now(),
  });
}

function modelUsagePolicy() {
  return effectiveUsagePolicy();
}

/**
 * Mirror the owner's billing decision into the Python kernel. The kernel is
 * not a second authority: it enforces THIS record at its own provider
 * boundary, so a kernel-side path (planner, agent, companion, background
 * work) can never spend money the desktop has not authorised.
 */
async function pushBillingToKernel() {
  if (!kernelReady) return { ok: false, error: "kernel not ready" };
  try {
    const result = await kernelRequest(
      "billing.set",
      { billing: billingState(), policy: modelUsagePolicy() },
      8000,
    );
    return { ok: true, ...result };
  } catch (error) {
    log(`billing sync to kernel failed: ${String(error?.message || error)}`);
    return { ok: false, error: String(error?.message || error) };
  }
}

function publishBilling(state) {
  routableCache = { ...routableCache, at: 0 };
  const payload = {
    billing: state,
    policy: modelUsagePolicy(),
    summary: billingPolicy.describeBilling(state),
  };
  log(`billing: ${payload.summary}`);
  send("models:billing", payload);
  void pushBillingToKernel();
  return payload;
}

function setBillingState(patch = {}) {
  const next = billingPolicy.normaliseBilling({ ...billingState(), ...patch });
  writeSettings({ ...readSettings(), billing: next });
  return publishBilling(next);
}

function grantPaidUsage(scope) {
  const next = billingPolicy.applyGrant(billingState(), scope);
  writeSettings({ ...readSettings(), billing: next });
  return publishBilling(next);
}

function setPaidKillSwitch(on) {
  const next = billingPolicy.setKillSwitch(billingState(), Boolean(on));
  writeSettings({ ...readSettings(), billing: next });
  return publishBilling(next);
}

function setModelUsagePolicy(value) {
  const policy = modelRouter.normalisePolicy(value);
  writeSettings({ ...readSettings(), modelUsagePolicy: policy });
  // A stricter policy must take effect immediately, not after the next TTL.
  routableCache = { ...routableCache, at: 0 };
  log(`model usage policy set to ${policy} (effective: ${modelUsagePolicy()})`);
  send("models:policy", { policy: modelUsagePolicy(), requested: policy });
  // Companion / planner spendable() reads the kernel's copy of this policy.
  // Without this push, the phone kept the previous cost mode until the next
  // billing grant or kernel restart.
  void pushBillingToKernel();
  return { policy: modelUsagePolicy(), requested: policy };
}

/**
 * One-shot request/response call into the Python kernel. Used by plugins and
 * by the renderer (through the `kernel:rpc` channel) for everything that is
 * not streaming chat, so there is a single place that knows the bridge
 * protocol, the token and the timeout policy.
 */
async function kernelRequest(method, params = {}, timeoutMs = 30000) {
  const WebSocketImpl = getWebSocket();
  if (!WebSocketImpl) throw new Error("No WebSocket client is available in this build.");
  if (!kernelReady) {
    if (!kernel && !kernelStartPromise && kernelFailure) throw new Error(kernelFailure);
    const ready = await (kernelStartPromise || waitForKernel(8000));
    if (!ready) throw new Error(kernelFailure || "FRIDAY's local AI service is unavailable.");
  }
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(`ws://${KERNEL_HOST}:${KERNEL_PORT}/bridge`);
    const id = `rpc-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closing */
      }
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error(`${method} timed out`)), timeoutMs);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ token: BRIDGE_TOKEN }));
      socket.send(JSON.stringify({ id, method, params }));
    });
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id !== id) return; // ignore the ready frame and stream events
      if (message.type === "error") finish(new Error(message.error || `${method} failed`));
      else if (method === "chat.stream" && message.data?.done === false)
        finish(new Error(message.data?.error || "chat produced no answer"));
      else finish(null, message.data);
    });
    socket.addEventListener("error", () =>
      finish(new Error(`${method} could not reach the kernel`)),
    );
    socket.addEventListener("close", () => finish(new Error(`${method} connection closed`)));
  });
}

/**
 * Serialises billing-grant consumption. Two chat requests that start in the
 * same tick must not both spend the same one-shot ("this request") unlock, and
 * the kernel must have the spent record before the second request opens its
 * socket — otherwise its own guard would still see the unused grant.
 */
let billingGate = Promise.resolve();
function withBillingGate(fn) {
  const run = billingGate.then(fn, fn);
  billingGate = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Authorise one provider request against the owner's billing record and spend
 * a one-shot grant when the request is billable. Shared by every Electron path
 * that can reach a provider (chat dispatch, model health probes).
 */
/**
 * PRIVACY FIREWALL — two tiers, in manual and auto mode alike:
 *
 *  • SENSITIVE content (credentials, secrets, financial/identity numbers)
 *    always asks the owner, fresh, every single time. No cached answer, no
 *    standing permission, no bypass.
 *  • Everything else going to a provider the owner has ALREADY connected is
 *    sent automatically, with no prompt and no click, so ordinary chat (the
 *    core function) is never blocked and unattended work never stalls.
 *  • A destination that is not a connected provider still asks.
 */
/**
 * Is this destination a provider the owner has really connected (a stored key)?
 *
 * The routable model shape carries the upstream provider in `meta.providerId`
 * ("openrouter", "gemini", …). The top-level `provider` field is the *wire*
 * the kernel router speaks ("online", "ollama"), and `id` may be the raw
 * upstream slug ("thinkingmachines/inkling:free") for an auto-routed model —
 * neither of those contains the provider name, which is exactly why an
 * already-connected OpenRouter model used to be reported as unconnected.
 * So the resolved routing provider is checked first, and the id is only ever
 * used through its `<provider>:<model>` prefix, never as a free-text guess.
 */
function providerIsConnected(model, destination) {
  try {
    const stored = Object.keys(modelsApi.readKeys(keyStoreRoot())).map((id) =>
      String(id).toLowerCase(),
    );
    if (!stored.length) return false;
    const id = String(model?.id || "");
    const candidates = [
      model?.meta?.providerId,
      model?.providerId,
      model?.meta?.providerName,
      // "<provider>:<model>" — the id shape routable() emits.
      id.includes(":") ? id.slice(0, id.indexOf(":")) : "",
      model?.provider,
      destination,
    ]
      .map((value) => String(value || "").toLowerCase())
      .filter(Boolean);
    return candidates.some((candidate) =>
      stored.some((key) => candidate === key || candidate.includes(key)),
    );
  } catch {
    return false;
  }
}

async function confirmEgress({
  model,
  content,
  destination = null,
  label = "request",
  forceAsk = false,
}) {
  const connected = providerIsConnected(model, destination);
  const decision = privacyFirewall.guardEgress({ model, content, destination, connected });
  if (forceAsk) {
    decision.requiresConfirmation = true;
    decision.autoAllowed = false;
  }
  if (decision.requiresConfirmation && !connected && ownerPrefToggle("blockUnknownHosts", false)) {
    const where = destination || model?.label || model?.id || "an external service";
    return {
      allowed: false,
      decision,
      message: `Blocked: ${where} is not a connected provider (Settings → Security).`,
    };
  }
  if (!decision.requiresConfirmation) return { allowed: true, decision, message: null };

  const detail = privacyFirewall.describeEgress(decision, model, destination);
  send("privacy:egress-pending", {
    label,
    modelId: model?.id || null,
    destination: destination || model?.label || model?.id || null,
    classification: decision.classification.level,
    reasons: decision.classification.reasons,
    at: Date.now(),
  });

  const target = liveWin();
  let granted = false;
  if (target) {
    const where = destination || model?.label || model?.id || "an external service";
    const buttons = ["Send this once", "Keep it on this PC"];
    const cancelId = buttons.length - 1;
    const { response } = await dialog.showMessageBox(target, {
      type: "warning",
      buttons,
      defaultId: cancelId,
      cancelId,
      noLink: true,
      title: "FRIDAY is about to send your data off this PC",
      message: `Send this ${decision.classification.level} content to ${where}?`,
      detail,
    });
    granted = response === 0;
  }

  const verdict = {
    allowed: granted,
    decision,
    message: granted
      ? null
      : target
        ? "You kept this on your PC — the external request was not sent."
        : "No window was available to confirm the data leaving this PC, so the request was not sent.",
  };
  send("privacy:egress-decided", {
    label,
    modelId: model?.id || null,
    destination: destination || model?.label || model?.id || null,
    classification: decision.classification.level,
    reasons: decision.classification.reasons,
    allowed: granted,
    at: Date.now(),
  });
  lastEgress = {
    at: Date.now(),
    label,
    modelId: model?.id || null,
    destination: destination || model?.label || model?.id || null,
    classification: decision.classification.level,
    reasons: decision.classification.reasons,
    allowed: granted,
  };
  log(
    `privacy firewall: ${label} · ${decision.classification.level} · ${granted ? "owner allowed once" : "blocked"}`,
  );
  return verdict;
}

/** The most recent egress decision, for the renderer status surface. */
let lastEgress = null;

function kernelChatContent(payload) {
  if (typeof payload?.prompt === "string" && payload.prompt) return payload.prompt;
  const messages = payload?.messages;
  if (!Array.isArray(messages)) return "";
  return messages
    .filter((row) => String(row?.role || "") !== "system")
    .map((row) => String(row?.content || ""))
    .join("\n");
}

function kernelChatModel(payload) {
  const first = String((payload?.modelIds || [])[0] || "");
  const keys = Object.keys(modelsApi.readKeys(keyStoreRoot()) || {});
  const prefix = (first.includes(":") ? first.slice(0, first.indexOf(":")) : first).toLowerCase();
  const localKinds = new Set([
    "local",
    "ollama",
    "llamacpp",
    "lmstudio",
    "vllm",
    "llama.cpp",
    "localai",
    "jan",
    "mlx",
  ]);
  if (localKinds.has(prefix) || localKinds.has(first.toLowerCase())) {
    return { id: first || "local", type: "ollama" };
  }
  if (keys.length) {
    const providerId =
      keys.find((id) => id.toLowerCase() === prefix || prefix.includes(id.toLowerCase())) ||
      keys[0];
    return { id: first || `${providerId}:chat`, type: "cloud", meta: { providerId } };
  }
  return { id: first || "local", type: "ollama" };
}

async function confirmKernelChat(payload, label) {
  return confirmEgress({
    model: kernelChatModel(payload),
    content: kernelChatContent(payload),
    label,
  });
}

async function authoriseProviderRequest({
  model,
  explicitPaid = false,
  label = "request",
  content = "",
}) {
  // Nothing may leave this PC without a fresh, explicit yes — checked before
  // the billing gate, because privacy outranks cost.
  const privacy = await confirmEgress({ model, content, label });
  if (!privacy.allowed) {
    return {
      allowed: false,
      privacyBlocked: true,
      privacy: privacy.decision,
      verdict: {
        billingClass: billingFirewall.billingClass(model),
        reason: privacy.message,
      },
      message: privacy.message,
    };
  }
  return withBillingGate(async () => {
    const verdict = billingFirewall.guardProviderRequest({
      model,
      billing: billingState(),
      explicitPaid,
      policy: modelUsagePolicy(),
    });
    if (!verdict.allowed) {
      const message = billingFirewall.describeBlock(verdict, model);
      log(`${label}: ${message}`);
      return { allowed: false, verdict, message };
    }
    if (verdict.billingClass !== "free") {
      // A one-shot ("this request") unlock is spent the moment it authorises a
      // billable request, so it can never pay for a second one.
      const spent = billingPolicy.consumeGrant(billingState());
      if (spent.grantScope !== billingState().grantScope) {
        writeSettings({ ...readSettings(), billing: spent });
        publishBilling(spent);
        // Wait for the kernel to hold the spent record BEFORE the request runs.
        await pushBillingToKernel();
      }
    }
    return { allowed: true, verdict, message: null };
  });
}

/**
 * One attempt against exactly one model. Resolves instead of throwing so the
 * broker above can decide whether to fall back to the next candidate.
 *
 * `collect` keeps the stream out of the chat UI and returns the full text
 * instead — that is what the Brain's multi-model collaboration path uses so
 * two or three concurrent candidates do not interleave into one bubble.
 */
async function streamOnce({
  requestId,
  request,
  prompt,
  model,
  explicitPaid = false,
  collect = false,
}) {
  // BILLING FIREWALL — the last gate before a provider request leaves this
  // machine. Every caller (chat, agents, tools, workflows, schedulers, remote
  // clients) reaches a provider through here, so nothing can route around it.
  const auth = await authoriseProviderRequest({
    model,
    explicitPaid,
    label: `chat ${requestId}`,
    content: prompt,
  });
  if (!auth.allowed) {
    send("models:billing-blocked", {
      requestId,
      modelId: model?.id || null,
      label: model?.label || null,
      billingClass: auth.verdict.billingClass,
      reason: auth.verdict.reason,
    });
    return { ok: false, received: false, blocked: true, error: auth.message };
  }
  const WebSocketImpl = getWebSocket();

  return new Promise((resolve) => {
    let settled = false;
    let ready = false;
    let received = false;
    let collected = "";

    const startedAt = Date.now();
    let socket;
    try {
      socket = new WebSocketImpl(`ws://${KERNEL_HOST}:${KERNEL_PORT}/bridge`);
    } catch (error) {
      resolve({
        ok: false,
        received: false,
        error: `connection failed: ${error?.message || error}`,
      });
      return;
    }
    activeChats.set(requestId, socket);

    // Defensive second layer: the kernel's HTTP client has its own finite idle
    // read timeout, but a hang inside the kernel process would never reach it.
    // This watchdog guarantees the turn always ends with a real, spoken error
    // instead of leaving the UI (and Auto Mode) waiting forever.
    const watchdog = createStallWatchdog((stall) => {
      done({ ok: false, received, timedOut: true, error: stall.message });
    });

    function done(result) {
      if (settled) return;
      settled = true;
      watchdog.stop();
      activeChats.delete(requestId);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve({ latencyMs: Date.now() - startedAt, text: collected, ...result });
    }

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ token: BRIDGE_TOKEN }));
    });
    socket.addEventListener("message", (event) => {
      // Any frame is proof of life: restart the idle deadline.
      watchdog.beat();
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === "ready") {
          ready = true;
          socket.send(
            JSON.stringify({
              id: 1,
              method: "chat.stream",
              params: {
                prompt,
                sessionId: request.sessionId || "main",
                modelIds: [model.id],
                // The desktop router owns fallback: it enforces the free-only
                // policy and the cooldowns the kernel cannot know about.
                allowFallback: false,
                // Kernel re-checks the owner-selected route mode so a local-only
                // turn cannot fall through to a cloud model, and vice versa.
                routeMode: request.routeMode || modelRouteMode(),
                // Only an owner-picked paid model may bill; the kernel
                // firewall re-checks this against its own policy copy.
                explicitPaid: Boolean(explicitPaid),
                system: request.system,
                // Desktop already ran confirmEgress for this exact model.
                privacyConfirmed: true,
                // Private is a hard local filter. The kernel must not widen it.
                privacy:
                  request.requirements?.privacy || request.routingContract?.requirements?.privacy,
              },
            }),
          );
          return;
        }
        if (message.type === "chat.delta") {
          if (message.data?.error) {
            done({ ok: false, received, error: message.data.error });
            return;
          }
          if (message.data?.tool && !collect) {
            const name = String(message.data.tool).slice(0, 120);
            if (name) {
              send("chat:tool", {
                requestId,
                modelId: message.data.modelId || model.id,
                name,
              });
            }
          }
          if (message.data?.delta) {
            const text = String(message.data.delta);
            // A missed fold must not land in the transcript as answer text.
            if (text.startsWith("\u001etool:")) {
              /* tool notice */
            } else {
              received = true;
              if (collect) {
                collected += text;
              } else {
                send("chat:delta", {
                  requestId,
                  modelId: message.data.modelId || model.id,
                  text,
                });
              }
            }
          }

          return;
        }
        if (message.id === 1 && message.type === "error") {
          done({ ok: false, received, error: message.error || "chat request failed" });
          return;
        }
        if (message.id === 1 && message.type === "result") {
          // A finished stream with nothing in it is not "no output" — say which
          // model went quiet, so the failure is traceable instead of generic.
          const label = model.label || model.id;
          done(
            received
              ? { ok: true, received: true }
              : {
                  ok: false,
                  received: false,
                  error: `${label} accepted the request but streamed no content and reported no error`,
                },
          );
        }
      } catch (error) {
        done({ ok: false, received, error: `invalid kernel response: ${error.message}` });
      }
    });
    socket.addEventListener("error", () => {
      done({ ok: false, received, error: "connection failed to the local AI service" });
    });
    socket.addEventListener("close", () => {
      if (socket.__fridayCancelled) {
        done({ ok: false, cancelled: true, received });
        return;
      }
      done({ ok: false, received, error: "the local AI service disconnected" });
    });
  });
}

/**
 * Main-process chat broker.
 *
 * Resolves the eligible models (free first, paid blocked unless the owner
 * allowed it, cooling-down models skipped), then tries them one at a time.
 * A 429/quota failure is never shown as a chat failure while another eligible
 * model can still answer.
 */
async function startChat(request) {
  const requestId = request?.requestId;
  const prompt = typeof request?.prompt === "string" ? request.prompt.trim() : "";
  if (!requestId || !prompt) {
    send("chat:error", { requestId, error: "Enter a message before sending." });
    return;
  }

  const WebSocketImpl = getWebSocket();
  if (!WebSocketImpl) {
    send("chat:error", {
      requestId,
      error:
        "This build has no WebSocket client available, so chat cannot reach the local AI service.",
    });
    return;
  }

  if (!kernelReady) {
    // A kernel start may already be in flight; wait for it instead of racing it.
    if (!kernel && !kernelStartPromise && kernelFailure) {
      send("chat:error", { requestId, error: kernelFailure });
      return;
    }
    const ready = await (kernelStartPromise || waitForKernel(8000));
    if (!ready) {
      send("chat:error", {
        requestId,
        error:
          kernelFailure ||
          "FRIDAY's local AI service is unavailable. Check Logs for the Python kernel error.",
      });
      return;
    }
  }

  // Auto mode: make sure the kernel knows every model this machine can reach,
  // then compute the ordered, policy-approved candidate list.
  await syncKernelModels();
  const task = typeof request.task === "string" ? request.task : "chat";
  const policy = modelUsagePolicy();
  const wanted = Array.isArray(request.modelIds) ? request.modelIds.filter(Boolean) : [];
  const contract =
    request.routingContract && typeof request.routingContract === "object"
      ? modelRouter.createRoutingContract(request.routingContract)
      : null;
  // The chat picker can override the stored routing mode for this turn.
  // The shared routing contract is authoritative when the caller sent one.
  const requestedMode =
    typeof request.routeMode === "string"
      ? request.routeMode
      : contract
        ? contract.routeMode
        : null;
  const routeMode = requestedMode || modelRouteMode();
  request.routeMode = routeMode;
  const requirements =
    (request.requirements && typeof request.requirements === "object" && request.requirements) ||
    contract?.requirements ||
    {};
  const selectedProviderIds = Array.isArray(request.selectedProviderIds)
    ? request.selectedProviderIds
    : contract?.selectedProviderIds || [];
  const routingOptions = {
    requirements,
    selectedProviderIds,
    costPolicy: request.costPolicy || contract?.costPolicy,
    qualityTarget: request.qualityTarget || contract?.qualityTarget || modelQualityTarget(),
    strategy: request.strategy || contract?.strategy || modelRouteStrategy(),
  };
  let candidates = await resolveChatModels(wanted, task, requestedMode, routingOptions);

  // Only the exact model the OWNER named for this turn counts as an explicit
  // paid choice; a fallback candidate the router picked never does.
  const ownerPicked = (model) =>
    wanted.includes(model?.id) || wanted.includes(model?.meta?.modelName);
  let failures = [];

  // Two passes at most: free-tier catalogues (OpenRouter especially) rotate
  // their available models often, so a stale list is re-fetched live once
  // before FRIDAY gives up.
  for (let pass = 0; pass < 2; pass += 1) {
    failures = [];
    for (const model of candidates) {
      log(
        `chat ${requestId}: trying ${model.id} (${model.type}/${model.access}, score-ordered, policy=${policy})`,
      );
      const result = await streamOnce({
        requestId,
        request,
        prompt,
        model,
        explicitPaid: ownerPicked(model),
      });
      if (result.cancelled) {
        send("chat:done", { requestId, cancelled: true });
        return;
      }
      if (result.ok) {
        providerHealth.noteSuccess(model.id, result.latencyMs);
        const verified = modelAccess.applyProbe(model.accessRecord || model.meta?.accessRecord, {
          ok: true,
          response: result.text || "ok",
          status: 200,
          headers: {},
        });
        if (model.meta) model.meta.accessRecord = verified;
        if (model.options) model.options.accessRecord = verified;
        model.accessRecord = verified;
        log(`chat ${requestId}: answered by ${model.id} in ${result.latencyMs}ms`);
        send("models:health-changed", {
          modelId: model.id,
          status: "available",
          kind: "MODEL_VERIFIED",
        });
        const answeredBy = modelRouter.formatAnsweredBy({
          winner: model,
          failures,
          auto: wanted.length === 0 && modelSelection().length === 0,
        });
        send("chat:done", { requestId, modelId: model.id, answeredBy });
        return;
      }
      const noted = providerHealth.noteFailure(model.id, result.error);
      const failed = modelAccess.applyProbe(model.accessRecord || model.meta?.accessRecord, {
        ok: false,
        status: Number(noted.status || /http (\d{3})/i.exec(String(result.error || ""))?.[1] || 0),
        error: result.error,
        headers: {},
      });
      if (model.meta) model.meta.accessRecord = failed;
      if (model.options) model.options.accessRecord = failed;
      model.accessRecord = failed;
      failures.push({
        modelId: model.id,
        label: model.label,
        display: model.displayName || model.label,
        category: noted.category,
      });
      log(
        `chat ${requestId}: ${model.id} failed (${noted.category}) — cooldown ${Math.round(
          noted.cooldownMs / 1000,
        )}s`,
      );
      send("models:health-changed", {
        modelId: model.id,
        status: noted.category,
        cooldownUntil: noted.cooldownUntil,
        kind: modelRouter.lifecycleKindFromHealth(noted.category),
      });
      // Tokens already reached the owner: restarting would duplicate the answer.
      if (result.received) {
        send("chat:error", { requestId, error: `${model.label} stopped mid-answer.` });
        return;
      }
    }

    const rotated =
      !candidates.length ||
      failures.every((f) => f.category === "model_unavailable" || f.category === "unknown");
    if (pass === 0 && rotated) {
      log(`chat ${requestId}: refreshing the live model catalogue before giving up`);
      const fresh = await refreshRoutable(true);
      await syncKernelModels();
      candidates = await resolveChatModels(wanted, task, requestedMode, routingOptions);
      log(
        `chat ${requestId}: catalogue refreshed — ${fresh.models.length} routable, ${candidates.length} eligible`,
      );
      continue;
    }
    break;
  }

  const checked = candidates.length
    ? [
        ...new Set(
          candidates.map((m) => (m.type === "local" ? "Local models" : "Connected cloud models")),
        ),
      ]
    : ["Local models", "Connected free cloud models"];
  const preferred = wanted.length ? wanted : modelSelection();
  const unlocked = billingPolicy.paidUnlocked(billingState()).allowed;
  const detail = modelRouter.explainUnavailable({
    mode: routeMode,
    policy,
    preferred,
    unlocked,
    checked,
    failures: failures.length
      ? failures
      : providerHealth
          .snapshot()
          .filter((entry) => entry.coolingDown)
          .map((entry) => ({ modelId: entry.modelId, category: entry.category })),
    offline: netStatus.isOffline(),
  });
  log(`chat ${requestId}: no model could answer (policy=${policy})`);
  send("chat:error", { requestId, error: honestHandoff(detail) });
}

/**
 * Multi-model collaboration (rare, deliberate, never the default path).
 *
 * The Brain asks for this when its own capability matrix says the task is
 * genuinely hard, or when the owner explicitly asks for a second opinion. It
 * reuses `selectParallel()` for the candidate set and `streamOnce()` for every
 * call, so each model still passes the SAME privacy (data-egress) confirmation
 * and billing/free-vs-paid firewall, once per model actually used.
 */
async function runParallelChat(request = {}) {
  const prompt = typeof request.prompt === "string" ? request.prompt.trim() : "";
  if (!prompt) return { ok: false, error: "Enter a message before sending.", results: [] };

  if (!kernelReady) {
    const ready = await (kernelStartPromise || waitForKernel(8000));
    if (!ready) {
      return {
        ok: false,
        error: kernelFailure || "FRIDAY's local AI service is unavailable.",
        results: [],
      };
    }
  }
  await syncKernelModels();

  const { models } = await refreshRoutable();
  if (!models.length) return { ok: false, error: "No routable model is configured.", results: [] };

  const wanted = Array.isArray(request.modelIds)
    ? request.modelIds.filter(Boolean)
    : modelSelection();
  const explicitPaid = wanted.some((id) => {
    const spec = models.find((m) => m.id === id || m.meta?.modelName === id);
    return spec ? modelRouter.classifyAccess(spec) === "paid" : false;
  });
  const network = await checkNetwork();
  const count = Math.max(2, Math.min(Number(request.count) || 2, 3));
  // Owner-selected route mode stays authoritative. Multi-model fan-out is
  // parallel execution of the selected pool, not a silent switch to "multi"
  // that would reopen cloud/local boundaries.
  const routeMode = request.routeMode || modelRouteMode();
  const policy = effectiveUsagePolicy({ explicitPaid });
  const qualityTarget = request.qualityTarget || modelQualityTarget();
  const requirements =
    request.requirements && typeof request.requirements === "object" ? request.requirements : {};
  await modelsApi.lazyVerifyForRoute(models, {
    task: typeof request.task === "string" ? request.task : "chat",
    preferred: wanted,
    policy,
    mode: routeMode,
    exclusive: wanted.length > 0,
    offline: !network.online,
    health: providerHealth,
    limit: count,
    requirements,
    qualityTarget,
  });
  await syncKernelModels();
  const candidates = modelRouter.selectParallel(models, {
    task: typeof request.task === "string" ? request.task : "chat",
    preferred: wanted,
    policy,
    mode: routeMode,
    exclusive: wanted.length > 0,
    offline: !network.online,
    health: providerHealth,
    count,
    requirements,
    qualityTarget,
    strategy: request.strategy || modelRouteStrategy(),
  });

  if (candidates.length < 2) {
    const unlocked = billingPolicy.paidUnlocked(billingState()).allowed;
    const combo = modelRouter.explainUnavailable({
      mode: modelRouteMode(),
      policy,
      preferred: wanted,
      unlocked,
    });
    return {
      ok: false,
      error:
        candidates.length === 0
          ? combo
          : "Only one model is eligible right now, so I can't compare two independent answers. Connect another model (or start a local one) and ask again.",
      results: [],
      reason: request.reason || null,
    };
  }

  const baseId = request.requestId || `multi-${Date.now()}`;
  const storedStrategy = modelRouter.normaliseStrategy(request.strategy || modelRouteStrategy());
  const strategy = storedStrategy === "auto" ? "parallel" : storedStrategy;
  const steps = modelRouter.assignSteps(candidates, strategy);
  log(
    `parallel chat ${baseId}: ${strategy} — ${steps
      .map((step) => `${step.role}:${step.modelEndpointId}`)
      .join(", ")}`,
  );
  const ownerPicked = (model) =>
    wanted.includes(model?.id) || wanted.includes(model?.meta?.modelName);

  async function runRole(model, index, promptText, role) {
    const result = await streamOnce({
      requestId: `${baseId}-${index}`,
      request,
      prompt: promptText,
      model,
      explicitPaid: ownerPicked(model),
      collect: true,
    });
    if (result.ok) providerHealth.noteSuccess(model.id, result.latencyMs);
    else if (!result.cancelled) providerHealth.noteFailure(model.id, result.error);
    return {
      modelId: model.id,
      label: model.label || model.id,
      access: modelRouter.classifyAccess(model),
      type: model.type || null,
      role,
      ok: Boolean(result.ok && String(result.text || "").trim()),
      text: String(result.text || "").trim(),
      ms: result.latencyMs ?? 0,
      error: result.ok ? null : result.error || null,
    };
  }

  let results;
  if (strategy === "parallel" || strategy === "race") {
    const rows = await Promise.all(
      candidates.map((model, index) =>
        runRole(model, index, prompt, strategy === "race" ? "racer" : "peer"),
      ),
    );
    if (strategy === "race") {
      const first = rows.find((row) => row && row.ok);
      results = first ? [first, ...rows.filter((row) => row !== first)] : rows;
    } else {
      results = rows;
    }
  } else if (strategy === "candidate-judge") {
    const judgeStep = steps.find((step) => step.role === "judge");
    const peers = steps.filter((step) => step.role !== "judge");
    const drafts = await Promise.all(
      peers.map((step, index) => {
        const model = candidates.find((item) => item.id === step.modelEndpointId);
        return model ? runRole(model, index, prompt, step.role) : null;
      }),
    );
    const ready = drafts.filter(Boolean);
    const judge = candidates.find((item) => item.id === judgeStep?.modelEndpointId);
    if (judge) {
      const judged = await runRole(
        judge,
        ready.length,
        modelRouter.compileRoleTurn({
          strategy,
          role: "judge",
          prompt,
          drafts: ready.filter((row) => row.ok),
        }),
        "judge",
      );
      results = [...ready, judged];
    } else {
      results = ready;
    }
  } else {
    results = [];
    const drafts = [];
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const model = candidates.find((item) => item.id === step.modelEndpointId);
      if (!model) continue;
      const row = await runRole(
        model,
        index,
        modelRouter.compileRoleTurn({ strategy, role: step.role, prompt, drafts }),
        step.role,
      );
      results.push(row);
      if (row.ok) drafts.push(row);
      if (strategy === "fallback" && row.ok) break;
      if (
        strategy === "cascade" &&
        row.ok &&
        step.role === "cheap" &&
        modelRouter.cascadeAccepts(row.text)
      ) {
        break;
      }
    }
  }

  const usable = results.filter((entry) => entry.ok);
  log(`parallel chat ${baseId}: ${usable.length}/${results.length} answered`);
  send("chat:parallel-done", {
    requestId: baseId,
    at: Date.now(),
    reason: request.reason || null,
    models: results.map(({ modelId, label, access, ok, ms }) => ({
      modelId,
      label,
      access,
      ok,
      ms,
    })),
  });
  return {
    ok: usable.length > 0,
    results,
    reason: request.reason || null,
    ...(usable.length ? {} : { error: results[0]?.error || "No model answered." }),
  };
}

/**
 * What the owner sees when nothing could answer. FRIDAY says plainly that this
 * particular request needs a model, what she can still do without one, and the
 * next step — never a bare failure block, and never a pretended answer.
 */
function honestHandoff(detail) {
  return [
    "I can't answer that one on my own — it needs a connected AI model, and none is reachable right now.",
    "",
    detail,
    "",
    "I can still do plenty without one: maths and conversions, date and time, anything already in my memory, and running your tools directly (open, close or focus an app, list open windows, check connected phones and Bluetooth devices).",
    "Want me to help you connect a model in Models, or start a local one with Ollama?",
  ].join("\n");
}

/**
 * Window placement obeys Windows rules: restore the last bounds when they are
 * still on a connected display, otherwise fall back to the primary work area.
 */
function readWindowState() {
  const saved = readSettings().windowState;
  const area = screen.getPrimaryDisplay().workArea;
  const fallback = {
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    maximized: true,
  };
  if (!saved || typeof saved !== "object") return fallback;
  const { x, y, width, height } = saved;
  if ([x, y, width, height].some((n) => typeof n !== "number" || !Number.isFinite(n))) {
    return { ...fallback, maximized: saved.maximized !== false };
  }
  // Clamp onto the display that actually contains the saved position so the
  // window can never open off-screen after a monitor change.
  const display = screen.getDisplayMatching({ x, y, width, height }).workArea;
  const w = Math.min(Math.max(width, 1080), display.width);
  const h = Math.min(Math.max(height, 680), display.height);
  return {
    x: Math.min(Math.max(x, display.x), display.x + display.width - w),
    y: Math.min(Math.max(y, display.y), display.y + display.height - h),
    width: w,
    height: h,
    maximized: saved.maximized === true,
  };
}

function saveWindowState() {
  const target = liveWin();
  if (!target) return;
  try {
    const maximized = target.isMaximized();
    const bounds = target.isNormal() ? target.getBounds() : target.getNormalBounds();
    writeSettings({ ...readSettings(), windowState: { ...bounds, maximized } });
  } catch {
    /* window went away mid-save — nothing to persist */
  }
}

/** Push maximize/focus state to the renderer so the strip can stay in sync. */
function pushWindowState() {
  const target = liveWin();
  if (!target) return;
  send("window:state", {
    maximized: target.isMaximized(),
    minimized: target.isMinimized(),
    focused: target.isFocused(),
    fullScreen: target.isFullScreen(),
  });
}

function createWindow() {
  const state = readWindowState();

  win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: "#141821",
    title: "FRIDAY",
    icon: appIconPath(),
    show: false,
    // Windows-sanctioned hidden caption: the OS keeps owning the frame (Aero
    // Snap, snap layouts, edge resize, system menu, shadows, animations) while
    // no native title bar is drawn — the custom FRIDAY strip is the only chrome.
    titleBarStyle: "hidden",
    frame: process.platform === "win32" ? undefined : false,
    maximizable: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // Keep IPC and timers alive when the window is occluded so background
      // work never appears frozen to Windows.
      backgroundThrottling: false,
      // The FRIDAY Browser section hosts real Chromium <webview> tabs.
      webviewTag: true,
    },
  });

  win.__fridayStartMaximized = state.maximized;
  stayHiddenOnLaunch = false;
  forceVisible = false;
  try {
    if (ownerPrefToggle("alwaysOnTop", false)) win.setAlwaysOnTop(true);
  } catch {
    /* display may reject always-on-top */
  }

  // Persist placement without thrashing the disk during a drag or resize.
  let saveTimer = null;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveWindowState, 400);
  };
  for (const event of ["resize", "move", "maximize", "unmaximize", "restore"]) {
    win.on(event, scheduleSave);
  }
  for (const event of ["maximize", "unmaximize", "minimize", "restore", "focus", "blur"]) {
    win.on(event, pushWindowState);
  }
  win.on("close", (event) => {
    clearTimeout(saveTimer);
    saveWindowState();
    // Close = hide to tray unless the owner turned the tray off. "Quit FRIDAY"
    // (tray menu / Advanced) is still the explicit full exit.
    if (!app.__fridayQuitting) {
      event.preventDefault();
      const closeToTray = ownerPrefToggle("tray", true);
      const confirm = ownerPrefToggle("confirmExit", true) && Boolean(app.__fridayBusy);
      const finish = () => {
        if (closeToTray) hideToTray();
        else {
          app.__fridayQuitting = true;
          app.quit();
        }
      };
      if (!confirm) {
        finish();
        return;
      }
      void dialog
        .showMessageBox(win, {
          type: "question",
          buttons: closeToTray
            ? ["Hide to tray", "Quit FRIDAY", "Cancel"]
            : ["Quit FRIDAY", "Cancel"],
          defaultId: 0,
          cancelId: closeToTray ? 2 : 1,
          title: "FRIDAY is still working",
          message: closeToTray
            ? "Tasks are still running. Hide FRIDAY to the tray, or quit completely?"
            : "Tasks are still running. Quit FRIDAY completely?",
        })
        .then(({ response }) => {
          if (closeToTray) {
            if (response === 0) hideToTray();
            else if (response === 1) {
              app.__fridayQuitting = true;
              app.quit();
            }
          } else if (response === 0) {
            app.__fridayQuitting = true;
            app.quit();
          }
        });
    }
  });

  // The window is never allowed to stay invisible: if the renderer fails to
  // load, FRIDAY shows the window with a readable error instead of exiting
  // silently with no visible sign that anything happened.
  const reveal = () => {
    if (!win || win.isDestroyed()) return;
    if (forceVisible) {
      if (!win.isVisible()) win.show();
      return;
    }
    if (stayHiddenOnLaunch) return;
    if (win.isVisible()) return;
    if (state.maximized) {
      try {
        win.maximize();
      } catch {
        // Maximize can fail on odd display configurations — show anyway.
      }
    }
    if (ownerPrefToggle("launchMinimized", false) && ownerPrefToggle("tray", true)) {
      stayHiddenOnLaunch = true;
      hideToTray();
      return;
    }
    win.show();
    win.focus();
    pushWindowState();
  };

  // Renderer bundle produced by `npm run build:desktop` (vite.electron.config.ts)
  // and packaged inside app.asar. It is served over the privileged friday://
  // scheme because Chromium blocks ES modules / dynamic imports over file://.
  renderer.load(win, {
    devUrl: process.env.FRIDAY_DEV_URL,
    log,
    onFailure: (message) => showLoadFailure(message),
  });

  win.once("ready-to-show", reveal);
  // Fail-safe: some GPU/driver combinations never emit ready-to-show.
  setTimeout(reveal, 6000);

  win.webContents.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame) return;
    log(`renderer failed to load [${code}] ${description} ${url}`);
    showLoadFailure(`${description} (${code})\n${url}`);
  });

  win.webContents.on("render-process-gone", (_e, details) => {
    log(`render process gone: ${details.reason}`);
    showLoadFailure(`The FRIDAY interface stopped unexpectedly (${details.reason}).`);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // FRIDAY Browser tabs: force the shared, persistent browser session and keep
  // Node out of every guest page. Popups are routed back into a FRIDAY tab.
  win.webContents.on("will-attach-webview", (_event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    // Guest pages never hold window focus (the FRIDAY chrome does), so
    // Chromium would throttle timers if this stayed true. Hidden tabs are
    // throttled later via setActiveGuest.
    webPreferences.backgroundThrottling = false;
    webPreferences.partition = liveBrowser.PARTITION;
    params.partition = liveBrowser.PARTITION;
  });
  win.webContents.on("did-attach-webview", (_event, guest) => {
    try {
      guest.setBackgroundThrottling(false);
    } catch {
      /* older Electron */
    }
    guest.setWindowOpenHandler(({ url, disposition }) => {
      send("browser:popup", { url, disposition });
      return { action: "deny" };
    });
    guest.on("context-menu", (_e, props) => {
      send("browser:context-menu", {
        x: props.x,
        y: props.y,
        linkURL: props.linkURL,
        srcURL: props.srcURL,
        selectionText: props.selectionText,
        isEditable: props.isEditable,
        mediaType: props.mediaType,
      });
    });
    const gone = (_e, details) => {
      send("browser:guest-gone", {
        reason: (details && details.reason) || "gone",
        url: guest.getURL ? guest.getURL() : "",
      });
    };
    guest.on("render-process-gone", gone);
    guest.on("unresponsive", () => gone(null, { reason: "unresponsive" }));
  });

  // Replay the boot log and push the first full scan once the UI is ready.
  win.webContents.on("did-finish-load", () => {
    reveal();
    // Shared boot self-test (scripts/verify-boot.cjs). Only active when the
    // verifier asks for it; normal launches are completely unaffected.
    // It waits for the REAL FRIDAY interface to mount (app root with rendered
    // content), not merely for the document to finish loading.
    if (process.env.FRIDAY_BOOT_SELFTEST) {
      const probe = `(() => {
        const root = document.querySelector('#root');
        if (!root || !root.childElementCount) return { mounted: false, reason: 'app root is empty' };
        const text = (document.body.innerText || '').trim();
        const painted = root.querySelectorAll('*').length;
        if (painted < 5 || text.length < 3)
          return { mounted: false, reason: 'interface rendered no content' };
        return { mounted: true, painted, chars: text.length };
      })()`;
      const deadline = Date.now() + 45000;
      // `app.exit()` tears the process down while the renderer, the character
      // overlay and the kernel child process are still live; on Windows that
      // teardown itself can fault (exit code -1073741819) and hide a perfectly
      // successful boot. Close the windows first, let stdout flush, then exit.
      const finish = (code) => {
        try {
          for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) w.destroy();
          }
        } catch {
          /* teardown must never change the self-test result */
        }
        setTimeout(() => app.exit(code), 400);
      };
      const check = () => {
        if (!win || win.isDestroyed()) return;
        win.webContents
          .executeJavaScript(probe)
          .then((result) => {
            if (result && result.mounted) {
              console.log(
                `FRIDAY_BOOT_SELFTEST_OK interface mounted (${result.painted} nodes, ${result.chars} chars)`,
              );
              return finish(0);
            }
            if (Date.now() < deadline) return setTimeout(check, 500);
            console.log(
              `FRIDAY_BOOT_SELFTEST_FAIL ${(result && result.reason) || "interface did not mount"}`,
            );
            finish(1);
          })
          .catch((err) => {
            if (Date.now() < deadline) return setTimeout(check, 500);
            console.log(`FRIDAY_BOOT_SELFTEST_FAIL ${err && err.message}`);
            finish(1);
          });
      };
      check();
    }

    // Full post-install readiness run (scripts/readiness-test.cjs). Exercises
    // the real kernel, database, chat, voice, model and task paths inside this
    // process, prints one JSON line and shuts FRIDAY down cleanly.
    if (process.env.FRIDAY_READINESS) {
      void runReadiness({
        win,
        waitForKernel,
        kernelUrl: `http://${KERNEL_HOST}:${KERNEL_PORT}`,
        kernelRequest,
        getWorkspaceRoot,
      })
        .then((report) => {
          console.log(`FRIDAY_READINESS_RESULT ${JSON.stringify(report)}`);
          setTimeout(() => app.exit(report.ok ? 0 : 1), 250);
        })
        .catch((error) => {
          console.log(
            `FRIDAY_READINESS_RESULT ${JSON.stringify({ ok: false, stages: [], error: String(error.message || error) })}`,
          );
          setTimeout(() => app.exit(1), 250);
        });
    }

    bootSteps.forEach((step) => send("boot:step", step));
    if (lastScan) send("workspace:scanned", lastScan);
    if (lastProviders) send("providers:detected", lastProviders);
    if (lastStartup) send("startup:state", lastStartup);
  });
}

/** The main window, or null when it is gone — never a destroyed handle. */
function liveWin() {
  return win && !win.isDestroyed() ? win : null;
}

/** Renders a plain, readable failure screen inside the FRIDAY window. */
function showLoadFailure(detail) {
  if (!win || win.isDestroyed()) return;
  forceVisible = true;
  stayHiddenOnLaunch = false;
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#141821;color:#e6ecff;font:14px/1.6 Segoe UI,system-ui,sans-serif;padding:48px">
<h1 style="font-size:20px;letter-spacing:.12em">FRIDAY could not start the interface</h1>
<pre style="white-space:pre-wrap;color:#9fb0d0">${String(detail).replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"))}</pre>
<p style="color:#7f8ea8">Log file: ${logFile()}</p></body>`;
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html)).catch(() => {});
  if (!win.isVisible()) win.show();
}

// ---- IPC -------------------------------------------------------------------
ipcMain.on("window:minimize", () => {
  const target = liveWin();
  if (target) target.minimize();
});

// Windows convention: double-clicking the caption toggles maximize / restore.
ipcMain.on("window:toggle-maximize", () => {
  const target = liveWin();
  if (!target) return;
  if (target.isMaximized()) target.unmaximize();
  else target.maximize();
});

// Right-click on the caption must open the native system menu (Move, Size,
// Minimize, Maximize, Close) exactly like a standard Windows window.
ipcMain.on("window:system-menu", () => {
  const target = liveWin();
  if (!target) return;
  const maximized = target.isMaximized();
  Menu.buildFromTemplate([
    { label: "Restore", enabled: maximized, click: () => liveWin()?.unmaximize() },
    { label: "Minimize", click: () => liveWin()?.minimize() },
    { label: "Maximize", enabled: !maximized, click: () => liveWin()?.maximize() },
    { type: "separator" },
    { label: "Close\tAlt+F4", click: () => liveWin()?.close() },
  ]).popup({ window: target });
});

ipcMain.handle("window:state", () => {
  const target = liveWin();
  if (!target) return { maximized: false, minimized: false, focused: false, fullScreen: false };
  return {
    maximized: target.isMaximized(),
    minimized: target.isMinimized(),
    focused: target.isFocused(),
    fullScreen: target.isFullScreen(),
  };
});

// Windows convention for an assistant that must stay reachable: the X button
// hides FRIDAY into the tray, it does NOT end her. Only "Quit FRIDAY" (tray
// menu or Settings) really stops the process — see quitFriday() below.
ipcMain.on("window:close", () => {
  hideToTray();
});

/** Show + focus the one FRIDAY window (tray click, wake word, second instance). */
function showFridayWindow() {
  const target = liveWin();
  if (!target) {
    createWindow();
    return true;
  }
  try {
    if (target.isMinimized()) target.restore();
    if (!target.isVisible()) target.show();
    target.focus();
    pushWindowState();
  } catch {
    /* window went away between the check and the call */
  }
  return true;
}

/** Close-to-tray: the renderer keeps running (wake word, timers, background). */
function hideToTray() {
  const target = liveWin();
  if (!target) return false;
  saveWindowState();
  try {
    target.hide();
  } catch {
    /* already hidden */
  }
  tray.noticeBackground();
  tray.refresh();
  return true;
}

/** The only real exit path. Always works, even if the renderer stalls. */
let quitting = false;
function quitFriday() {
  if (quitting) return;
  quitting = true;
  app.__fridayQuitting = true;
  try {
    tray.destroy();
  } catch {
    /* nothing to destroy */
  }
  try {
    win?.close();
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    try {
      if (win && !win.isDestroyed()) win.destroy();
    } catch {
      /* already destroyed */
    }
    app.quit();
    setTimeout(() => app.exit(0), 1500);
  }, 1200);
}

ipcMain.on("window:show", () => showFridayWindow());
ipcMain.on("window:hide", () => hideToTray());
ipcMain.handle("app:quit", () => {
  quitFriday();
  return true;
});

// The renderer owns the microphone, so it is the only honest source of the
// listening state the tray shows. Pausing from the tray is forwarded back and
// really stops recognition there (assistant-mode.ts).
ipcMain.on("voice:state", (_e, state) => {
  tray.setState({
    mode: state?.mode === "auto" ? "auto" : "manual",
    listening: Boolean(state?.listening),
    paused: Boolean(state?.paused),
  });
});
ipcMain.handle("voice:tray-state", () => tray.getState());

// ------------------------------------------------ 2D desktop companion --
// Additive feature: the transparent character overlay. It never talks to a
// model itself — everything it asks for is forwarded to the main window and
// runs through the existing brain, permission and billing pipeline.
const character = new CharacterController({
  log,
  devUrl: process.env.FRIDAY_DEV_URL,
  sendToMain: (channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  },
});

ipcMain.handle("character:get", () => character.get());
ipcMain.handle("character:set", (_e, patch) => character.set(patch || {}));
ipcMain.handle("character:start", () => character.start());
ipcMain.handle("character:stop", () => {
  character.settings.enabled = false;
  character.save();
  return character.stop();
});
ipcMain.handle("character:restart", () => character.restart());
ipcMain.handle("character:reset-position", () => character.resetPosition());
ipcMain.handle("character:model", () => characterRuntime.modelPayload());
ipcMain.handle("character:texture", () => characterRuntime.textureData());
ipcMain.handle("character:health", () => characterRuntime.health());
ipcMain.handle("character:install", () => characterRuntime.install());
ipcMain.handle("character:repair", () => characterRuntime.repair());
ipcMain.handle("character:update", () => characterRuntime.update());
ipcMain.handle("character:remove", () => {
  const result = characterRuntime.remove();
  character.stop();
  return result;
});
ipcMain.handle("character:probe", (_e, probe) => characterRuntime.recordProbe(probe || {}));
// From the main window: real live FRIDAY state (action, emotion, lip-sync).
ipcMain.handle("character:publish", (_e, state) => character.publish(state || {}));
// From the overlay: user intent that must run through the real pipeline.
ipcMain.handle("character:ask", (_e, payload) =>
  character.forwardToMain("character:ask", payload || {}),
);
ipcMain.handle("character:command", (_e, payload) =>
  character.forwardToMain("character:command", payload || {}),
);
ipcMain.handle("character:drag", (_e, delta) => character.drag(delta || {}));
ipcMain.handle("character:interactive", (_e, on) => character.setInteractive(Boolean(on)));
ipcMain.handle("character:show-app", () => {
  showFridayWindow();
  return { ok: true };
});

// Bring the companion back after a restart, but only if the user turned it on.
// It is deliberately late and non-blocking: the main window and the kernel
// always come first.
app.whenReady().then(() => {
  setTimeout(() => {
    try {
      if (character.load().enabled) character.apply();
    } catch (error) {
      log(`character: autostart failed — ${String(error?.message || error)}`);
    }
  }, 5000);
});

// ------------------------------------------------------ neural voice (TTS) --
ipcMain.handle("voice:neural-status", () => neuralVoice.status(true));
ipcMain.handle("voice:neural-install", () => neuralVoice.install());
ipcMain.handle("voice:neural-voices", () => neuralVoice.voices());
ipcMain.handle("voice:neural-speak", (_e, payload) => neuralVoice.speak(payload || {}));
ipcMain.handle("voice:duck", (_e, payload) => {
  const on = Boolean(payload && payload.on);
  return audioDuck.apply(on);
});
ipcMain.handle("voice:meeting", () => meetingWatch.status());
ipcMain.handle("voice:voiceprint-status", () => voiceprint.status());
ipcMain.handle("voice:voiceprint-clear", () => voiceprint.clear());

// ------------------------------------------- desktop speech-to-text (STT) --
// Real on-device transcription. Auto Mode sets localOnly so neither status
// discovery nor transcription can select a cloud provider.
ipcMain.handle("voice:stt-status", (_e, request) => {
  const options = request && typeof request === "object" ? request : { force: Boolean(request) };
  return stt.status(Boolean(options.force), {
    localOnly: Boolean(options.localOnly),
    warm: Boolean(options.warm),
  });
});
ipcMain.handle("voice:stt-install", () => stt.install());
ipcMain.handle("voice:transcribe", (e, payload) =>
  stt.transcribe(payload || {}, (partial) => {
    try {
      e.sender.send("voice:partial", partial);
    } catch {
      /* the window is already gone */
    }
  }),
);
ipcMain.handle("voice:score-turn", (_e, payload) => stt.scoreTurn(payload || {}));

// ------------------------------------------ low-latency wake word (openWW) --
// The REAL detector when openWakeWord is installed with a model for the
// configured wake word; otherwise the renderer keeps the documented
// transcript-matching fallback and both are visible in Voice Diagnostics.
ipcMain.handle("voice:wake-status", (_e, payload) =>
  wakeEngine.status(payload?.wakeWord || "friday", Boolean(payload?.force)),
);
ipcMain.handle("voice:wake-install", () => wakeEngine.install());
ipcMain.handle("voice:wake-detect", (_e, payload) => wakeEngine.detect(payload || {}));

// Real post-install verification of the voice runtime (imports + model load +
// a real neural voice), used by first-run and Voice Diagnostics.
ipcMain.handle("voice:verify", (_e, payload) => voiceVerify.verifyVoiceRuntime(payload || {}));

ipcMain.on("chat:send", (_event, request) => void startChat(request));
// Explicit multi-model collaboration. Never automatic: the renderer's Brain
// only asks for it on a real capability gap or an owner "second opinion".
ipcMain.handle("chat:parallel", async (_event, request) => {
  try {
    return await runParallelChat(request || {});
  } catch (error) {
    return { ok: false, error: String(error?.message || error), results: [] };
  }
});

ipcMain.on("chat:abort", (_event, requestId) => {
  stopChat(requestId);
  send("chat:done", { requestId, cancelled: true });
});

// -------------------------------------------------------------- plugins ---
// The plugin host only ever sees the workspace folder the user selected.
const pluginServices = {
  workspaceRoot: () => getWorkspaceRoot(),
  log: (message) => {
    telemetry.recordLog("info", "plugin", message);
  },
  emit: (event, payload) => send("plugin:event", { event, payload }),
  on: (event, handler) => {
    const channel = `plugin:host:${event}`;
    ipcMain.on(channel, handler);
    return () => ipcMain.removeListener(channel, handler);
  },
  kernel: (method, params) => kernelRequest(method, params),
  // Plugins run sandboxed by default. Electron main-process trust is granted
  // ONLY when the manifest asks for it and the owner approves it here — the
  // same explicit gate every other risky action goes through.
  approveHostAccess: async ({ id, name, permissions, path: dir }) => {
    const target = liveWin();
    if (!target) return false;
    const { response } = await dialog.showMessageBox(target, {
      type: "warning",
      buttons: ["Run sandboxed", "Grant full access"],
      defaultId: 0,
      cancelId: 0,
      title: "Plugin asks for full system access",
      message: `Give the plugin \u201c${name || id}\u201d Electron main-process access?`,
      detail:
        `Permissions requested: ${(permissions || []).join(", ") || "electron"}\n` +
        `Folder: ${dir}\n\n` +
        "Full access lets this plugin do anything FRIDAY can do on this PC. " +
        "Choosing \u201cRun sandboxed\u201d keeps it isolated in its own process.",
    });
    return response === 1;
  },
};

ipcMain.handle("plugins:list", () => plugins.list(capabilityRoots()));
ipcMain.handle("plugins:check-updates", (_e) => plugins.checkUpdates(capabilityRoots()));
ipcMain.handle("plugins:load", (_e, id) => plugins.load(capabilityRoots(), id, pluginServices));
ipcMain.handle("plugins:reload", (_e, id) => plugins.load(capabilityRoots(), id, pluginServices));
ipcMain.handle("plugins:unload", (_e, id) => plugins.unload(id));
ipcMain.handle("plugins:set-enabled", (_e, id, enabled) =>
  plugins.setEnabled(capabilityRoots(), id, enabled),
);
ipcMain.handle("plugins:remove", (_e, id) => plugins.remove(getWorkspaceRoot(), id));
ipcMain.handle("plugins:install", async () => {
  const result = await dialog.showOpenDialog(liveWin(), {
    title: "Select a plugin folder to install",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
  return plugins.install(getWorkspaceRoot(), result.filePaths[0]);
});
ipcMain.handle("plugins:invoke", (_e, id, command, args) =>
  plugins.invoke(capabilityRoots(), id, command, args, pluginServices),
);
ipcMain.handle("plugins:tools", () => plugins.tools());
ipcMain.handle("plugins:dispatch", (_e, hook, payload, options) =>
  plugins.dispatch(capabilityRoots(), hook, payload && typeof payload === "object" ? payload : {}, {
    allowDisabled: Boolean(options && options.allowDisabled),
    pluginId:
      options && (options.pluginId || options.id) ? String(options.pluginId || options.id) : "",
    services: {
      ...pluginServices,
      authorizeHook: async ({ id, name, hook: hookName, risk, payload: args }) => {
        const toolId = `plugin:${id}:${hookName}`;
        let decision = applyOwnerPermissionOverlay(
          toolId,
          risk,
          toolAuthority.decide(toolId, risk, toolPolicy()),
        );
        if (decision === "deny") return { ok: false, granted: false };
        if (decision === "ask") {
          const answer = await askOwnerForTool(toolId, risk, args || {});
          persistToolDecision(toolId, risk, answer.granted, answer.remember);
          return { ok: answer.granted, granted: answer.granted };
        }
        return { ok: true, granted: true, name };
      },
    },
  }),
);

// ---- Tool permission gate ---------------------------------------------------
// A renderer call may NOT approve itself. Every `tool.exec` reaching the kernel
// is stripped of any caller-supplied approval, checked against the owner's
// stored policy (and an approval prompt when the policy says "ask") and only
// then carries a signed, single-use authorization the kernel can verify.
let toolRiskCache = { at: 0, risk: new Map() };

async function toolRisk(name) {
  if (Date.now() - toolRiskCache.at > 60_000) {
    try {
      const listed = await kernelRequest("tool.list", {}, 8000);
      toolRiskCache = {
        at: Date.now(),
        risk: new Map((listed?.tools || []).map((t) => [t.name, t.risk])),
      };
    } catch {
      /* keep the previous map; unknown tools stay at the strictest tier */
    }
  }
  return toolRiskCache.risk.get(name) || "exec";
}

function toolPolicy() {
  const stored = readSettings().toolPolicy;
  return stored && typeof stored === "object" ? stored : {};
}

function persistToolDecision(name, risk, granted, remember) {
  if (!remember) return;
  // Owner rules cannot be turned off: never persist allow for write/exec.
  if (granted && risk !== "safe") return;
  writeSettings({
    ...readSettings(),
    toolPolicy: { ...toolPolicy(), [name]: granted ? "allow" : "deny" },
  });
}

async function askOwnerForTool(name, risk, args) {
  const target = liveWin();
  if (!target) return { granted: false, remember: false };
  const { response, checkboxChecked } = await dialog.showMessageBox(target, {
    type: "warning",
    buttons: ["Allow once", "Deny"],
    defaultId: 1,
    cancelId: 1,
    title: "FRIDAY needs your permission",
    message: `Allow FRIDAY to run “${name}”?`,
    detail: toolAuthority.describe(name, risk, args),
    checkboxLabel: "Remember this choice for this tool",
    checkboxChecked: false,
  });
  return { granted: response === 0, remember: Boolean(checkboxChecked) };
}

async function authorizeToolCall(name, args) {
  const risk = await toolRisk(name);
  let decision = applyOwnerPermissionOverlay(
    name,
    risk,
    toolAuthority.decide(name, risk, toolPolicy()),
  );
  if (risk === "safe" && decision === "allow") return { allowed: true, authorization: null, risk };
  if (decision === "deny")
    return { allowed: false, risk, reason: `“${name}” is blocked by your permission settings.` };
  if (decision === "ask") {
    const answer = await askOwnerForTool(name, risk, args);
    persistToolDecision(name, risk, answer.granted, answer.remember);
    if (!answer.granted) return { allowed: false, risk, reason: `You denied “${name}”.` };
    decision = "allow";
  }
  return {
    allowed: true,
    risk,
    authorization: toolAuthority.issue(TOOL_AUTHORITY_SECRET, {
      tool: name,
      args: args || {},
      risk,
      requester: "desktop",
    }),
  };
}

// Kernel call for non-streaming features (history, memory, runner).
//
// The renderer may only reach an explicitly allowlisted method, and it can
// never supply its own approval: the authorization is minted here, by the
// owner-backed policy, or not at all.
ipcMain.handle("kernel:rpc", async (_e, method, params) => {
  const name = String(method || "");
  if (!kernelMethods.isAllowedKernelMethod(name))
    return { ok: false, error: `kernel method not allowed: ${name}`, denied: true };
  const payload = params && typeof params === "object" ? { ...params } : {};
  for (const field of kernelMethods.CALLER_FORBIDDEN_FIELDS) delete payload[field];
  if (name === "chat.complete" || name === "chat.stream") {
    const privacy = await confirmKernelChat(payload, name);
    if (!privacy.allowed)
      return { ok: false, error: privacy.message, privacyBlocked: true, denied: true };
    // Only mark confirmed when the firewall treated this as an external send
    // (the owner was asked, or connected+non-sensitive auto-sent). A local
    // guess must not stamp confirmation onto a later cloud fallback.
    payload.privacyConfirmed = Boolean(privacy.decision?.external);
    if (!payload.routeMode && !payload.route_mode) {
      payload.routeMode = modelRouteMode();
    }
  }
  if (name === "tool.exec") {
    const verdict = await authorizeToolCall(String(payload.name || ""), payload.args || {});
    if (!verdict.allowed)
      return { ok: false, error: verdict.reason, risk: verdict.risk, denied: true };
    if (verdict.authorization) payload.authorization = verdict.authorization;
  }
  return kernelRequest(name, payload);
});

ipcMain.handle("permissions:tool-policy", () => ({
  policy: toolPolicy(),
  defaults: toolAuthority.RISK_DEFAULT,
}));
ipcMain.handle("permissions:set-tool-policy", (_e, name, decision) => {
  const next = { ...toolPolicy() };
  if (!toolAuthority.DECISIONS.includes(decision)) delete next[name];
  else next[name] = decision;
  writeSettings({ ...readSettings(), toolPolicy: next });
  return { policy: next };
});

// ---- Phone companion (local network only) ----------------------------------
// The kernel binds to the LAN only while this is on, so flipping it needs a
// restart of the local service; the existing restart notice carries that.
ipcMain.handle("companion:get", () => ({
  enabled: Boolean(readSettings().companionEnabled),
}));
ipcMain.handle("companion:cognize-ack", (_e, sessionId) => ({
  ok: sendSessionKernel("companion.cognize_ack", { sessionId: String(sessionId || "") }),
}));
ipcMain.handle("companion:cognize-done", (_e, payload) => {
  const data = payload && typeof payload === "object" ? payload : {};
  return {
    ok: sendSessionKernel("companion.cognize_done", {
      sessionId: String(data.sessionId || ""),
      text: data.text ? String(data.text) : "",
      error: data.error ? String(data.error) : "",
    }),
  };
});
ipcMain.handle("companion:set", (_e, enabled) => {
  const next = Boolean(enabled);
  const current = Boolean(readSettings().companionEnabled);
  if (next !== current) {
    writeSettings({ ...readSettings(), companionEnabled: next });
    noteRestartRequired(next ? "phone companion enabled" : "phone companion disabled");
  }
  return { enabled: next };
});

// The renderer owns ONE navigation/feature registry (src/lib/friday/navigation.ts).
// It is published here so the phone companion builds its menu from the same
// list instead of hardcoding sections. New feature → new phone entry, free.
ipcMain.handle("companion:publish-features", (_e, payload) => {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.features)
      ? payload.features
      : [];
  const caps = Array.isArray(payload?.capabilities) ? payload.capabilities : [];
  const live =
    payload && typeof payload === "object" && payload.live && typeof payload.live === "object"
      ? payload.live
      : undefined;
  try {
    const target = path.join(paths.ensureDir("config"), "companion-features.json");
    // The renderer republishes on every capability-registry notification, and
    // most of those carry the SAME list. Writing regardless — with a fresh
    // `at` timestamp — changed the file every time, so the workspace watcher
    // fired and the "config reloaded" toast reappeared forever. The file is
    // now written ONLY when its meaningful content really differs, and the
    // volatile timestamp is gone so identical content stays byte-identical.
    // Coarse live state (voice / doctor / connectors) rides in this same file
    // so the phone reads one source of truth; the watcher ignores this path.
    const body = JSON.stringify(
      { features: list, capabilities: caps, ...(live ? { live } : {}) },
      null,
      2,
    );
    const wrote = paths.writeIfChanged(target, body);
    return { ok: true, count: list.length, capabilities: caps.length, unchanged: !wrote };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

/**
 * FIRST-RUN BOOTSTRAP STATE.
 *
 * Backed by <root>/config/first-run.json, exactly the contract in
 * installer/first-run/index.ts, so the flag survives restarts and upgrades and
 * the real setup pass never runs twice.
 */
function firstRunFile() {
  // Never create <userData>/config/first-run.json before the Setup-written
  // root is known — that would make a later real root look like a first run,
  // or worse, mark bootstrap complete in the fallback store.
  if (!paths.root() && !getWorkspaceRoot()) return null;
  return path.join(paths.ensureDir("config"), "first-run.json");
}

ipcMain.handle("first-run:state", () => {
  const file = firstRunFile();
  if (!file) return { completed: false, completedAt: null, version: null, steps: [] };
  try {
    const raw = fs.readFileSync(file, "utf8");
    const saved = JSON.parse(raw);
    return {
      completed: Boolean(saved?.completed),
      completedAt: saved?.completedAt ?? null,
      version: saved?.version ?? null,
      steps: Array.isArray(saved?.steps) ? saved.steps : [],
    };
  } catch {
    return { completed: false, completedAt: null, version: null, steps: [] };
  }
});

ipcMain.handle("first-run:complete", (_e, payload) => {
  const file = firstRunFile();
  if (!file) return { ok: false, error: "No FRIDAY folder has been selected yet." };
  const next = {
    completed: true,
    completedAt: Date.now(),
    version: productVersion(),
    steps: Array.isArray(payload?.steps) ? payload.steps : [],
  };
  try {
    fs.writeFileSync(file, JSON.stringify(next, null, 2), "utf8");
    return { ok: true, state: next };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// Off-LAN access. Off by default; private device network only (see
// electron/remote-access.cjs for the exact exposure this creates).
ipcMain.handle("companion:remote-get", async () => {
  let phones = 0;
  try {
    const status = await kernelRequest("companion.status", {}, 6000);
    phones = (status?.phones || []).length;
  } catch {
    phones = 0;
  }
  return remoteAccess.state({
    enabled: Boolean(readSettings().companionRemoteEnabled),
    port: KERNEL_PORT,
    pairedPhones: phones,
  });
});
ipcMain.handle("companion:remote-set", async (_e, enabled) => {
  const next = Boolean(enabled);
  if (next !== Boolean(readSettings().companionRemoteEnabled)) {
    writeSettings({ ...readSettings(), companionRemoteEnabled: next });
  }
  let phones = 0;
  try {
    const status = await kernelRequest("companion.status", {}, 6000);
    phones = (status?.phones || []).length;
  } catch {
    phones = 0;
  }
  return remoteAccess.state({ enabled: next, port: KERNEL_PORT, pairedPhones: phones });
});

ipcMain.handle("telemetry:snapshot", () => telemetry.snapshot());
ipcMain.handle("telemetry:clear", () => telemetry.clearLogs());
ipcMain.handle("telemetry:files", () => telemetry.listFiles());
ipcMain.handle("telemetry:read-file", (_e, rel) => telemetry.readLogFile(rel));

ipcMain.handle("app:version", () => productVersion());

ipcMain.handle("app:paths", () => ({
  install: path.dirname(app.getPath("exe")),
  userData: app.getPath("userData"),
  workspace: getWorkspaceRoot(),
  canonical: paths.describe(),
}));
ipcMain.handle("boot:steps", () => bootSteps);

// The desktop declares the open conversation so a phone turn joins it.
ipcMain.handle("session:set-active", async (_e, sessionId) => {
  try {
    return await kernelRequest("session.active", { sessionId: String(sessionId || "main") }, 8000);
  } catch (error) {
    return { sessionId: null, error: error.message };
  }
});

ipcMain.handle("bridge:config", () => ({
  url: `ws://${KERNEL_HOST}:${KERNEL_PORT}/bridge`,
  token: BRIDGE_TOKEN,
}));

ipcMain.handle("workspace:get", () => getWorkspaceRoot());

// ------------------------------------------------------------ preferences --
// Canonical settings file. Stored inside the workspace so a reinstall or an
// update keeps every knob the user set; userData is the fallback when no
// workspace has been picked yet.
function preferencesFile() {
  return paths.preferencesFile();
}

function ownerPrefToggle(key, fallback) {
  try {
    const raw = JSON.parse(fs.readFileSync(preferencesFile(), "utf8"));
    const value = raw && raw.toggles ? raw.toggles[key] : undefined;
    return typeof value === "boolean" ? value : fallback;
  } catch {
    return fallback;
  }
}

function applyOwnerPreferenceEffects(value) {
  try {
    const toggles =
      value && value.toggles && typeof value.toggles === "object" ? value.toggles : {};
    const fields = value && value.fields && typeof value.fields === "object" ? value.fields : {};
    if (typeof toggles.startup === "boolean") {
      app.setLoginItemSettings({ openAtLogin: Boolean(toggles.startup) });
    }
    const target = liveWin();
    if (target && typeof toggles.alwaysOnTop === "boolean") {
      target.setAlwaysOnTop(Boolean(toggles.alwaysOnTop));
    }
    if (toggles.repoWatch === false) {
      if (watcher) {
        watcher.stop();
        watcher = null;
      }
    } else if (toggles.repoWatch === true && !watcher) {
      startWatching(getWorkspaceRoot());
    }
    if (fields.sampleSeconds != null && fields.sampleSeconds !== "") {
      systemMonitor.setSampleMs(Number(fields.sampleSeconds) * 1000);
    }
  } catch (error) {
    log(`preference side effects: ${error?.message || error}`);
  }
}

function applyOwnerPermissionOverlay(name, risk, decision) {
  if (risk === "safe" && ownerPrefToggle("safeTools", true) === false && decision === "allow") {
    return "ask";
  }
  if (
    ownerPrefToggle("installApproval", true) &&
    /(^|[:.])(install|download)/i.test(String(name || "")) &&
    decision === "allow"
  ) {
    return "ask";
  }
  if (
    ownerPrefToggle("pcControlApproval", true) &&
    /(mouse|keyboard|screenshot|window|desktop|pc\.)/i.test(String(name || "")) &&
    decision === "allow"
  ) {
    return "ask";
  }
  return decision;
}

ipcMain.handle("prefs:get", () => {
  try {
    return JSON.parse(fs.readFileSync(preferencesFile(), "utf8"));
  } catch {
    return null;
  }
});

ipcMain.handle("prefs:set", (_e, value) => {
  if (!value || typeof value !== "object") throw new Error("Invalid preferences payload.");
  const file = preferencesFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  applyOwnerPreferenceEffects(value);
  return true;
});

ipcMain.on("window:busy", (_e, busy) => {
  app.__fridayBusy = Boolean(busy);
});

ipcMain.handle("security:encryption", () => {
  try {
    const credentials = require("./credentials.cjs");
    return { available: Boolean(credentials.encryptionAvailable()) };
  } catch {
    return { available: false };
  }
});

ipcMain.handle("window:open-devtools", () => {
  const target = liveWin();
  if (!target) return false;
  target.webContents.openDevTools({ mode: "detach" });
  return true;
});

ipcMain.handle("window:set-always-on-top", (_e, enabled) => {
  const target = liveWin();
  if (!target) return false;
  const on = Boolean(enabled);
  target.setAlwaysOnTop(on);
  return on;
});

// ------------------------------------------------------- voice model files --
// Imported voice models live beside the other workspace resources so a
// reinstall or an update keeps them. Only the file name is trusted from the
// renderer; the destination directory is always FRIDAY's own resources folder.
function voicesDir() {
  return paths.ensureDir("voices");
}

function insideVoicesDir(candidate) {
  const dir = voicesDir();
  const resolved = path.resolve(String(candidate || ""));
  return resolved.startsWith(path.resolve(dir) + path.sep) ? resolved : null;
}

ipcMain.handle("voice:import", (_e, payload) => {
  const name = String(payload?.name || "").trim();
  const data = String(payload?.dataBase64 || "");
  if (!name || !data) throw new Error("Voice import needs a file name and its contents.");
  const safe = path
    .basename(name)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
  if (!safe) throw new Error("Unsupported voice file name.");
  const target = path.join(voicesDir(), safe);
  fs.writeFileSync(target, Buffer.from(data, "base64"));
  return { path: target, name: safe, size: fs.statSync(target).size };
});

ipcMain.handle("voice:remove", (_e, filePath) => {
  const resolved = insideVoicesDir(filePath);
  if (!resolved) return false;
  try {
    fs.rmSync(resolved, { force: true });
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle("voice:list", () => {
  try {
    return fs
      .readdirSync(voicesDir(), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const full = path.join(voicesDir(), entry.name);
        return { path: full, name: entry.name, size: fs.statSync(full).size };
      });
  } catch {
    return [];
  }
});

// ----------------------------------------------------------- durable state --
// Chat history, memory, brain state, model choices and the task ledger are
// mirrored to real files so they survive cache clears, reinstalls and updates.
function stateFile(namespace) {
  const safe = String(namespace || "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
  if (!safe) throw new Error("Invalid state namespace.");
  return paths.stateFile(safe);
}

// Identity of the store the renderer may cache. Answered synchronously so the
// renderer can compare it before any engine reads its browser copy; a mismatch
// means that copy belongs to a different (or deleted) FRIDAY folder.
ipcMain.on("state:identity", (event) => {
  try {
    const record = paths.storageIdentity({ create: true });
    event.returnValue = { id: record.id, root: record.root || null };
  } catch {
    event.returnValue = null;
  }
});

ipcMain.handle("state:identity", () => {
  try {
    const record = paths.storageIdentity({ create: true });
    return { id: record.id, root: record.root || null };
  } catch {
    return null;
  }
});

ipcMain.handle("state:get", (_e, namespace) => {
  try {
    return JSON.parse(fs.readFileSync(stateFile(namespace), "utf8"));
  } catch {
    return null;
  }
});

ipcMain.handle("state:set", (_e, namespace, value) => {
  const file = stateFile(namespace);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
  return true;
});

ipcMain.handle("workspace:pick", async () => {
  const result = await dialog.showOpenDialog(liveWin(), {
    title: "Select your FRIDAY workspace folder",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: getWorkspaceRoot() || app.getPath("home"),
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

// Folders whose contents belong to the user and must follow the workspace when
// the folder is changed. The old folder is never deleted — it stays as a
// recovery copy and the user is told where it is.
const MIGRATED_FOLDERS = [
  "database",
  "memory",
  "config",
  "data",
  "conversations",
  path.join("resources", "voices"),
  "models",
];

/** Real copy (not a reference) of the previous folder's data into the new one. */
async function migrateWorkspaceData(from, to) {
  const report = { from, to, copied: [], skipped: [], failed: [] };
  for (const relative of MIGRATED_FOLDERS) {
    const source = path.join(from, relative);
    const target = path.join(to, relative);
    if (!fs.existsSync(source)) {
      report.skipped.push(relative);
      continue;
    }
    send("workspace:migrate", { phase: "copy", folder: relative, from, to });
    try {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.cp(source, target, {
        recursive: true,
        force: false, // never overwrite data already present in the new folder
        errorOnExist: false,
      });
      report.copied.push(relative);
    } catch (error) {
      const message = error?.message || String(error);
      report.failed.push({ folder: relative, error: message });
      log(`workspace migration failed for ${relative}: ${message}`);
    }
  }
  send("workspace:migrate", { phase: report.failed.length ? "failed" : "done", ...report });
  return report;
}

ipcMain.handle("workspace:set", async (_e, root) => {
  if (typeof root !== "string" || !root.trim() || !path.isAbsolute(root)) {
    throw new Error("Choose a valid absolute folder path.");
  }
  const resolvedRoot = path.resolve(root.trim());
  const stat = await fs.promises.stat(resolvedRoot).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error("The selected folder does not exist or cannot be opened.");
  }
  const previousRoot = getWorkspaceRoot();
  const moving = Boolean(previousRoot) && path.resolve(previousRoot) !== resolvedRoot;
  // Copying is never silent: the user decides between copying the previous
  // folder's data, using the new folder as it is, or staying where they are.
  let decision = "fresh";
  if (moving) {
    const hasOldData = paths.describeExisting(previousRoot).length > 0;
    if (hasOldData) {
      const { response } = await dialog.showMessageBox(liveWin(), {
        type: "question",
        buttons: ["Copy my data", "Use the new folder as-is", "Cancel"],
        defaultId: 0,
        cancelId: 2,
        title: "Change FRIDAY folder",
        message: `Copy your existing FRIDAY data to ${resolvedRoot}?`,
        detail:
          `${previousRoot} contains: ${paths.describeExisting(previousRoot).join(", ")}.\n` +
          "Nothing is deleted from the old folder either way.",
      });
      if (response === 2) return previousRoot;
      decision = response === 0 ? "copy" : "reuse";
    }
  }
  setWorkspaceRoot(resolvedRoot);
  screenVision.setRoot(resolvedRoot);
  camera.setRoot(resolvedRoot);
  // Answer the first-run screen straight away. Creating the layout, starting
  // the watcher and restarting the kernel all touch the disk, so they run
  // after the reply instead of blocking the UI thread while the user waits.
  setImmediate(async () => {
    try {
      // One canonical layout, created through the path service.
      paths.ensureStructure(resolvedRoot);
      ensureCanonicalConfig(resolvedRoot);
      ensureRootFiles(resolvedRoot, { version: productVersion() });
      // A different root means different models, keys and endpoints: never
      // serve the previous folder's cached catalogue.
      routableCache = { at: 0, models: [] };
      providerHealth.clear();
      void rebuildRootIndexes(resolvedRoot);
      if (moving && decision === "copy") {
        send("workspace:migrate", { phase: "start", from: previousRoot, to: resolvedRoot });
        const report = await migrateWorkspaceData(previousRoot, resolvedRoot);
        if (report.failed.length) {
          log(
            `workspace data could not be fully copied from ${previousRoot}; ` +
              `the old folder is intact and can be used to recover.`,
          );
        } else {
          log(
            `workspace data copied to ${resolvedRoot}. The previous folder ` +
              `${previousRoot} was left in place — delete it once the new one is verified.`,
          );
        }
      }
      startWatching(resolvedRoot);
      initSelfMaintenance(resolvedRoot);
      restartKernel();
    } catch (error) {
      log(`workspace setup failed: ${error?.stack || error}`);
      send("workspace:migrate", {
        phase: "failed",
        from: previousRoot,
        to: resolvedRoot,
        failed: [{ folder: "*", error: error?.message || String(error) }],
      });
    }
  });
  return resolvedRoot;
});

ipcMain.handle("workspace:verify", (_e, root) => verifyWorkspace(root || getWorkspaceRoot()));
ipcMain.handle("workspace:repair", (_e, root) =>
  repairWorkspace(root || getWorkspaceRoot(), { version: productVersion() }),
);
ipcMain.handle("workspace:scan", (_e, force) => {
  const root = getWorkspaceRoot();
  if (!root) return null;
  if (!force && lastScan && lastScan.root === root) return lastScan;
  return rescan(root);
});
ipcMain.handle("workspace:reveal", (_e, relative) => {
  const root = getWorkspaceRoot();
  if (!root) return false;
  const target = relative ? resolveFolder(root, relative) || path.join(root, relative) : root;
  shell.openPath(target);
  return true;
});

// Detection only — the Install Manager never installs behind the user's back.
ipcMain.handle("providers:detect", async () => {
  lastProviders = await detectProviders({ keyStore: keyStoreRoot() });
  send("providers:detected", lastProviders);
  return lastProviders;
});
ipcMain.handle("providers:ollama-models", () => listOllamaModels());

// ------------------------------------------------------------ models manager
// Real inventory, real pulls, real health checks. Nothing here is simulated.
const modelJobs = new Map(); // jobId -> AbortController

const modelsContext = () => ({
  // Provider keys are read from the same place they are written.
  userData: keyStoreRoot(),
  workspace: getWorkspaceRoot(),
});

ipcMain.handle("models:inventory", () => modelsApi.inventory(modelsContext()));
ipcMain.handle("models:search", (_e, query, options) =>
  modelsApi.searchOnlineModels(query || "", { ...modelsContext(), ...(options || {}) }),
);
ipcMain.handle("models:ai-suggest", (_e, payload) =>
  modelsApi.aiModelSuggestions({ ...modelsContext(), ...(payload || {}) }),
);
ipcMain.handle("models:test-provider", (_e, id, apiKey, options) => {
  if (options && options.chat) {
    return modelsApi.testProviderChat(id, {
      ...modelsContext(),
      apiKey: apiKey || null,
      policy: modelUsagePolicy(),
      modelId: options.modelId || null,
    });
  }
  return modelsApi.testProvider(id, { ...modelsContext(), apiKey: apiKey || null });
});
ipcMain.handle("models:sync-catalog", () => {
  const due = modelAccess.planKnowledgeRefresh(Date.now());
  return {
    due: due.map((row) => ({
      id: row.id,
      source: row.source,
      expired: Boolean(row.expired),
      checkedAt: row.checkedAt,
    })),
  };
});
ipcMain.handle("models:heal", () => {
  const federation = require("./provider-federation.cjs");
  const healed = federation.healSnapshot({ ids: [], disabled: [] }, { dead: [], recovered: [] });
  return {
    ok: true,
    disabled: healed.disabled || [],
    note: "No dead models are recorded.",
  };
});
ipcMain.handle("models:preview-route", async (_e, prompt) => {
  const text = String(prompt || "").slice(0, 4000);
  let models = routableCache.models;
  if (!Array.isArray(models) || models.length === 0) {
    const fresh = await refreshRoutable(false);
    models = fresh?.models || [];
  }
  const preview = modelRouter.previewRoute(models, text);
  const plan = preview.plan || {};
  return {
    task: preview.judged?.task || "unknown",
    source: preview.judged?.source || "rules",
    preset: preview.judged?.preset || null,
    strategy: plan.strategy || null,
    candidates: Array.isArray(plan.candidates) ? plan.candidates.slice(0, 8) : [],
    why: typeof plan.why === "string" ? plan.why : "unknown",
  };
});
ipcMain.handle("models:set-key", async (_e, id, apiKey) => {
  const result = modelsApi.writeKey(keyStoreRoot(), id, apiKey || null);
  // A new or removed key changes what is routable: rediscover now and let the
  // selector refresh itself instead of waiting for the cache to expire.
  if (modelsApi.invalidateProviderCache) modelsApi.invalidateProviderCache(id);
  providerHealth.clear();
  await refreshRoutable(true);
  void syncKernelModels(true);
  emitModelLifecycle("API_KEY_CHANGED", { provider: id });
  // The AI provider panel reads the same key store, so refresh it immediately
  // instead of showing "not configured" until the next detection sweep.
  try {
    lastProviders = await detectProviders({ keyStore: keyStoreRoot() });
    send("providers:detected", lastProviders);
  } catch {
    /* detection is best-effort; the key is already stored */
  }
  return result;
});
// Custom provider base URL. Stored next to the keys and used by discovery,
// key validation and the chat surface handed to the router.
ipcMain.handle("models:set-endpoint", async (_e, id, endpoint) => {
  const result = modelsApi.writeEndpoint(keyStoreRoot(), id, endpoint || null);
  if (!result.ok) return result;
  if (modelsApi.invalidateProviderCache) modelsApi.invalidateProviderCache(id);
  providerHealth.clear();
  await refreshRoutable(true);
  void syncKernelModels(true);
  emitModelLifecycle("PROVIDER_CONNECTED", { provider: id });
  return result;
});
ipcMain.handle("models:endpoints", () => modelsApi.readEndpoints(keyStoreRoot()));

ipcMain.handle("models:keys", () =>
  Object.keys(modelsApi.readKeys(keyStoreRoot())).reduce((acc, id) => ({ ...acc, [id]: true }), {}),
);
ipcMain.handle("models:show", (_e, model) => modelsApi.ollamaShow(model));
ipcMain.handle("models:running", () => modelsApi.ollamaRunning());
ipcMain.handle("models:remove", async (_e, model) => {
  const result = await modelsApi.ollamaDelete(model);
  if (result?.ok) announceModelInstalled("ollama");
  return result;
});
ipcMain.handle("models:unload", (_e, model) => modelsApi.ollamaUnload(model));
ipcMain.handle("models:run-probe", (_e, model, prompt) => modelsApi.ollamaProbeRun(model, prompt));

// Routable catalogue, kernel registration, auto selection and engine control.
ipcMain.handle("models:routable", async (_e, force) => refreshRoutable(Boolean(force)));
ipcMain.handle("models:sync-kernel", (_e, force) => syncKernelModels(Boolean(force)));
ipcMain.handle("models:select", async (_e, task, preferred) => {
  const resolvedTask = task || "chat";
  const ordered = await resolveChatModels(Array.isArray(preferred) ? preferred : [], resolvedTask);
  return {
    task: resolvedTask,
    candidates: ordered.map(({ meta = {}, api_key: _key, ...model }) => {
      const { api_key: _metaKey, ...publicMeta } = meta;
      return { ...model, ...publicMeta };
    }),
  };
});
ipcMain.handle("privacy:last", () => lastEgress);
ipcMain.handle("privacy:classify", (_e, text) => privacyFirewall.classify(String(text || "")));
ipcMain.handle("models:health", async (_e, modelId) => {
  const { models } = await refreshRoutable();
  const spec = models.find((m) => m.id === modelId || m.meta.modelName === modelId);
  if (!spec) return { ok: false, error: `"${modelId}" is not reachable on this machine` };
  // A health probe is a real provider request, so it passes the same billing
  // firewall as chat — testing a paid model must never spend unauthorised money.
  const auth = await authoriseProviderRequest({
    model: spec,
    label: `health probe ${spec.id}`,
    content: "FRIDAY health probe",
  });
  if (!auth.allowed) {
    send("models:billing-blocked", {
      requestId: null,
      modelId: spec.id,
      label: spec.label || null,
      billingClass: auth.verdict.billingClass,
      reason: auth.verdict.reason,
    });
    return {
      ok: false,
      blocked: true,
      error: auth.message,
      modelId: spec.id,
      provider: spec.meta.providerId,
    };
  }
  const probe = await modelsApi.probeModel(spec);
  return { ...probe, modelId: spec.id, provider: spec.meta.providerId };
});

ipcMain.handle("models:policy", () => ({ policy: modelUsagePolicy() }));
ipcMain.handle("models:route-mode", () => ({ mode: modelRouteMode() }));
ipcMain.handle("models:quality-target", () => ({ qualityTarget: modelQualityTarget() }));
ipcMain.handle("models:route-strategy", () => ({ strategy: modelRouteStrategy() }));
ipcMain.handle("models:selection", () => ({ ids: modelSelection() }));
ipcMain.handle("system:network", (_e, force) => checkNetwork(Boolean(force)));

ipcMain.handle("models:set-route-mode", (_e, mode) => setModelRouteMode(mode));
ipcMain.handle("models:set-quality-target", (_e, value) => setModelQualityTarget(value));
ipcMain.handle("models:set-route-strategy", (_e, value) => setModelRouteStrategy(value));
ipcMain.handle("models:set-selection", (_e, ids) => setModelSelection(ids));
ipcMain.handle("models:set-policy", (_e, value) => setModelUsagePolicy(value));
// ------------------------------------------------------------ billing safety
// Paid AI usage is off by default and can only be unlocked here. Every answer
// carries the effective policy so the UI can never claim more than is allowed.
ipcMain.handle("billing:get", () => ({
  billing: billingState(),
  policy: modelUsagePolicy(),
  requestedPolicy: modelRouter.normalisePolicy(readSettings().modelUsagePolicy),
  summary: billingPolicy.describeBilling(billingState()),
}));
ipcMain.handle("billing:set", (_e, patch) => setBillingState(patch || {}));
ipcMain.handle("billing:grant", (_e, scope) => grantPaidUsage(scope));
ipcMain.handle("billing:kill-switch", (_e, on) => setPaidKillSwitch(on));
// Per-provider cost tier: auto | free (only free models) | paid (only paid).
ipcMain.handle("providers:access", () => modelsApi.readAccessTiers(keyStoreRoot()));
ipcMain.handle("providers:set-access", (_e, id, tier, declaration) => {
  const result = modelsApi.writeAccessTier(keyStoreRoot(), String(id), tier);
  let declarations = null;
  if (declaration && typeof declaration === "object") {
    declarations = modelsApi.writeOwnerDeclaration(keyStoreRoot(), {
      providerId: String(id),
      ...declaration,
    });
  }
  routableCache = { ...routableCache, at: 0 };
  emitModelLifecycle("MODEL_UPDATED", { provider: String(id), reason: "access-tier" });
  return declarations ? { ...result, declarations } : result;
});
/** The dynamic registry the chat model selector renders, free/paid classified. */
ipcMain.handle("models:registry", async (_e, force) => {
  const { models, at } = await refreshRoutable(Boolean(force));
  const policy = modelUsagePolicy();
  const now = Date.now();
  const view = modelRouter.usableModels(models, {
    policy,
    health: providerHealth,
    now,
    task: "chat",
  });
  return {
    at,
    policy,
    hint: view.hint,
    hiddenPaid: view.hiddenPaid,
    hiddenUnknown: view.hiddenUnknown,
    providersWithoutFree: view.providersWithoutFree,
    billing: billingState(),
    billingSummary: billingPolicy.describeBilling(billingState()),
    models: view.rows.map((row) => {
      const described = row.model;
      // The renderer never receives credentials: the key stays in the main
      // process and only the provider adapter ever sees it.
      const { meta, api_key: _key, ...rest } = described;
      return {
        ...rest,
        providerId: meta?.providerId || described.providerId,
        providerName: row.providerName,
        endpoint: meta?.endpoint || null,
        customEndpoint: Boolean(meta?.customEndpoint),
        modelName: meta?.modelName || described.providerModelId,
        resident: meta?.resident,
        sizeGb: meta?.sizeGb,
        label: row.choiceLabel,
        choiceLabel: row.choiceLabel,
        badge: row.badge,
        visibility: row.visibility,
        disabledReason: row.disabledReason,
        marks: row.marks,
        reason: row.reason,
        eligible: row.visibility === "show",
        priority: modelRouter.scoreModel(described, { task: "chat", policy, now }),
      };
    }),
  };
});
ipcMain.handle("models:health-state", () => providerHealth.snapshot());

// The authoritative provider registry — System Status, Models, Diagnostics and
// routing all read this one record so no screen can drift from another.
async function providerRegistrySnapshot() {
  const inventory = await modelsApi.inventory(modelsContext());
  return providerRegistry.buildRegistry({
    inventory,
    cloudSpecs: modelsApi.CLOUD,
    storedKeyIds: Object.keys(modelsApi.readKeys(keyStoreRoot())),
    env: process.env,
    health: providerHealth.snapshot(),
  });
}
ipcMain.handle("providers:registry", () => providerRegistrySnapshot());
ipcMain.handle("providers:mode-readiness", async (_e, mode) =>
  providerRegistry.modeReadiness(await providerRegistrySnapshot(), mode),
);
ipcMain.handle("models:engines", () => modelsApi.engineStatus());
ipcMain.handle("models:engine-start", async (_e, id, selectedModel = null) => {
  const selected =
    selectedModel ||
    modelSelection().find((modelId) => {
      const value = String(modelId);
      return (
        value.startsWith(`${String(id)}:`) ||
        value.startsWith("file:") ||
        /\.(gguf|safetensors)$/i.test(value)
      );
    }) ||
    null;
  const result = await modelsApi.startEngine(id, { selectedModel: selected });
  if (result.ok) announceModelInstalled(id);
  return result;
});
ipcMain.handle("models:engine-stop", async (_e, id) => {
  const result = await modelsApi.stopEngine(id);
  if (result.ok) announceModelInstalled(id);
  return result;
});

/**
 * A model is only "Ready" when it actually answers.
 *
 * Presence in `ollama list` proves bytes landed, not that they are usable: a
 * truncated download, a bad quantization for this GPU or a broken Modelfile
 * all still show up as installed. So every freshly installed local model gets
 * one real, tiny prompt; only a real response earns the ready state.
 */
async function verifyLocalModel(name, jobId, model) {
  send("models:pull-progress", {
    jobId,
    model,
    status: "verifying — sending a test prompt",
    progress: 99,
  });
  try {
    const probe = await modelsApi.ollamaProbeRun(name);
    if (probe.ok && String(probe.response || "").trim()) {
      return {
        verified: true,
        state: "ready",
        latencyMs: probe.latencyMs ?? null,
        tokensPerSec: probe.tokensPerSec ?? null,
      };
    }
    return {
      verified: false,
      state: "installed-not-responding",
      error: probe.error || "the model returned an empty response to the test prompt",
    };
  } catch (err) {
    return {
      verified: false,
      state: "installed-not-responding",
      error: String(err?.message || err),
    };
  }
}

/** Everything that must happen once a model really lands on this machine. */
function announceModelInstalled(provider) {
  void refreshRoutable(true).then(() => {
    void syncKernelModels(true);
    emitModelLifecycle("MODEL_DISCOVERED", { provider });
  });
}

ipcMain.handle("models:pull", async (_e, model, jobId) => {
  const id = jobId || `pull-${Date.now()}`;
  if (modelJobs.has(id)) return { ok: false, error: "job already running" };
  const controller = new AbortController();
  modelJobs.set(id, controller);
  send("models:pull-progress", { jobId: id, model, status: "starting", progress: 0 });
  try {
    const result = await modelsApi.ollamaPull(
      model,
      (event) => send("models:pull-progress", { jobId: id, model, ...event }),
      controller.signal,
    );
    const verification = result.ok ? await verifyLocalModel(model, id, model) : null;
    const payload = { ...result, ...(verification || {}) };
    send("models:pull-done", { jobId: id, model, ...payload });
    // The chat model list, the kernel router and the models page all read the
    // same registry, so one refresh keeps every surface live instead of stale
    // until the next navigation.
    if (result.ok) announceModelInstalled("ollama");
    return { jobId: id, ...payload };
  } catch (err) {
    const error = String(err?.message || err);
    send("models:pull-done", { jobId: id, model, ok: false, error });
    return { jobId: id, ok: false, error };
  } finally {
    modelJobs.delete(id);
  }
});

/**
 * Multi-source download: the renderer passes the ordered sources from the
 * catalog and FRIDAY keeps the first one that really delivers the bytes.
 */
ipcMain.handle("models:download", async (_e, payload) => {
  const { modelId, sources = [], jobId } = payload || {};
  if (!modelId) return { ok: false, error: "modelId is required" };
  const id = jobId || `dl-${Date.now()}`;
  if (modelJobs.has(id)) return { ok: false, error: "job already running" };
  const controller = new AbortController();
  modelJobs.set(id, controller);
  const ctx = modelsContext();
  const dir = paths.ensureDir("models");
  send("models:pull-progress", { jobId: id, model: modelId, status: "starting", progress: 0 });
  try {
    const result = await modelDownload.downloadModel(
      { modelId, sources, dir },
      (event) => send("models:pull-progress", { jobId: id, model: modelId, ...event }),
      controller.signal,
      { ollamaPull: modelsApi.ollamaPull },
    );
    // Only a model Ollama can actually serve can be test-prompted; a raw file
    // download that was not registered is reported exactly as what it is.
    const runnable =
      result.ok &&
      (result.via === "ollama" ? result.ref || modelId : result.registered ? modelId : null);
    const verification = runnable ? await verifyLocalModel(runnable, id, modelId) : null;
    const finalResult = { ...result, ...(verification || {}) };
    send("models:pull-done", { jobId: id, model: modelId, ...finalResult });
    if (result.ok) announceModelInstalled(result.via === "ollama" ? "ollama" : "local");
    return { jobId: id, ...finalResult };
  } catch (err) {
    const error = String(err?.message || err);
    send("models:pull-done", { jobId: id, model: modelId, ok: false, error });
    return { jobId: id, ok: false, error };
  } finally {
    modelJobs.delete(id);
  }
});

ipcMain.handle("models:cancel", (_e, jobId) => {
  const controller = modelJobs.get(jobId);
  if (!controller) return { ok: false, error: "no such job" };
  controller.abort();
  modelJobs.delete(jobId);
  return { ok: true };
});

ipcMain.handle("components:detect", async () => {
  lastComponents = { detectedAt: Date.now(), components: await detectComponents() };
  return lastComponents;
});
// Static hardware description changes only when hardware changes, and every
// probe spawns a process — so it is cached and never re-run per UI tick.
let hardwareAt = 0;
let hardwareJob = null;
ipcMain.handle("hardware:detect", async (_e, force = false) => {
  if (!force && lastHardware && Date.now() - hardwareAt < 30000) return lastHardware;
  hardwareJob ??= detectHardware()
    .then((hw) => {
      lastHardware = hw;
      hardwareAt = Date.now();
      return hw;
    })
    .finally(() => {
      hardwareJob = null;
    });
  return hardwareJob;
});

// Live measured telemetry. The renderer subscribes once; the main process
// samples on a single interval and broadcasts to every screen.
ipcMain.handle("system:metrics", () => systemMonitor.snapshot());
ipcMain.handle("system:metrics-subscribe", () => systemMonitor.subscribe());
ipcMain.handle("system:metrics-unsubscribe", () => {
  systemMonitor.unsubscribe();
  return true;
});

// Live FRIDAY service health (kernel, workspace, database, local engines).
ipcMain.handle("system:health", () => serviceHealth.snapshot());
ipcMain.handle("system:health-subscribe", () => serviceHealth.subscribe());
ipcMain.handle("system:health-unsubscribe", () => {
  serviceHealth.unsubscribe();
  return true;
});

let sensorsCache = { at: 0, value: null };
let sensorsJob = null;
ipcMain.handle("system:sensors", async () => {
  const { detectSensors } = require("./hardware.cjs");
  if (sensorsCache.value && Date.now() - sensorsCache.at < 15000) return sensorsCache.value;
  sensorsJob ??= detectSensors()
    .then((value) => {
      sensorsCache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      sensorsJob = null;
    });
  return sensorsJob;
});
// Windows Security posture. PowerShell probes are slow, so one shared job is
// cached for a minute — the panel never spawns a process per render.
let securityCache = { at: 0, value: null };
let securityJob = null;
ipcMain.handle("system:security", async () => {
  const { detectSecurity } = require("./hardware.cjs");
  if (securityCache.value && Date.now() - securityCache.at < 60000) return securityCache.value;
  securityJob ??= detectSecurity()
    .then((value) => {
      securityCache = { at: Date.now(), value };
      return value;
    })
    .catch(() => securityCache.value)
    .finally(() => {
      securityJob = null;
    });
  return securityJob;
});
ipcMain.handle("system:open-security", () => {
  const { openWindowsSecurity } = require("./hardware.cjs");
  return { ok: openWindowsSecurity() };
});
ipcMain.handle("components:open-source", (_e, url) => {
  if (typeof url === "string" && /^https:\/\//.test(url)) shell.openExternal(url);
  return true;
});

// The application entry in the Updates panel comes from the SAME verified
// GitHub release channel the Settings → Updates screen uses (TEST prereleases
// from test-build.yml, OFFICIAL releases from release.yml). There is no second
// update feed: one detect → download → owner approval → install → restart path.
async function releaseChannelAppUpdate(currentVersion) {
  const root = getWorkspaceRoot();
  if (!root) return null;
  const check = await githubSync.checkUpdate(root, {
    channel: "release",
    currentVersion,
  });
  if (!check?.ok || !check.updateAvailable) return null;
  return {
    available: check.version,
    channel: check.updateChannel,
    testBuild: Boolean(check.testBuild),
    notes: check.title ? `${check.title}\n\n${check.notes || ""}`.trim() : check.notes || "",
  };
}

ipcMain.handle("updates:check", () =>
  checkAllUpdates({
    version: productVersion(),
    scan: lastScan,
    appUpdate: releaseChannelAppUpdate,
  }),
);

ipcMain.handle("updates:apply", (_e, update) =>
  applyUpdate({
    root: getWorkspaceRoot(),
    update,
    onProgress: (progress) => send("updates:progress", progress),
    // Downloading is the checksum-verified release download; installing stays
    // behind the explicit owner approval in github:install-update.
    installApp: async (info) => {
      const root = getWorkspaceRoot();
      const wantTest = info?.testBuild === true;
      const check = await githubSync.checkUpdate(root, {
        channel: "release",
        updateChannel: wantTest ? "test" : "stable",
        currentVersion: productVersion(),
      });
      if (!check?.ok) {
        return { ok: false, error: check?.error || "The release could not be read." };
      }
      const asset = githubSync.installerAsset(check?.assets || []);
      // Private releases often have an API asset URL and no anonymous browser URL.
      if (!asset?.url && !asset?.apiUrl) {
        return { ok: false, error: "This release does not publish a Windows installer." };
      }
      const progress = (p) => {
        send("updates:progress", p);
        send("github:download-progress", p);
      };
      const result = await githubSync.downloadInstaller({
        root,
        url: asset.url,
        apiUrl: asset.apiUrl,
        assetId: asset.id,
        name: asset.name,
        bytes: asset.bytes,
        sha256: githubSync.expectedChecksum(check?.manifest, asset.name),
        onProgress: progress,
      });
      return { ...result, requiresApproval: true, testBuild: Boolean(check?.testBuild) };
    },
  }),
);
ipcMain.handle("updates:rollback", (_e, entry) => rollbackUpdate(entry || {}));

// ---- Restart coordination --------------------------------------------------
// One authoritative set of reasons a restart is pending. It is deduplicated,
// survives navigation and is cleared by an actual restart, so the UI can show
// a single persistent notice instead of a prompt per file event.
const restartReasons = new Map();

function noteRestartRequired(reason) {
  const key = String(reason || "configuration change");
  if (restartReasons.has(key)) return restartState();
  restartReasons.set(key, Date.now());
  const state = restartState();
  send("app:restart-required", state);
  return state;
}

function restartState() {
  return {
    required: restartReasons.size > 0,
    reasons: [...restartReasons.entries()].map(([reason, at]) => ({ reason, at })),
  };
}

ipcMain.handle("app:restart-state", () => restartState());

/** Real relaunch. Owned processes are stopped first so nothing is orphaned. */
ipcMain.handle("app:restart", (_e, reason) => {
  log(`restarting FRIDAY: ${reason || "requested by the user"}`);
  restartReasons.clear();
  try {
    stopOwnedProcesses();
  } catch (error) {
    log(`restart cleanup failed: ${error?.message || error}`);
  }
  app.relaunch();
  // Give the cleanup a tick so the kernel exits before the new instance starts.
  setTimeout(() => app.exit(0), 250);
  return true;
});

// Restarts are always confirmed first.
ipcMain.handle("app:confirm-restart", async (_e, reason) => {
  const { response } = await dialog.showMessageBox(liveWin(), {
    type: "question",
    buttons: ["Restart now", "Later"],
    defaultId: 0,
    cancelId: 1,
    title: "Restart FRIDAY",
    message: "A restart is required to finish applying changes.",
    detail: reason || "",
  });
  if (response !== 0) return false;
  restartReasons.clear();
  try {
    stopOwnedProcesses();
  } catch {
    /* the relaunch continues even if a child refuses to stop */
  }
  app.relaunch();
  setTimeout(() => app.exit(0), 250);
  return true;
});

ipcMain.handle("startup:get", () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle("startup:set", (_e, enabled) => {
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
  return app.getLoginItemSettings().openAtLogin;
});

// ---- Install Manager & Doctor ---------------------------------------------
// All of this runs asynchronously in the main process; the renderer only ever
// receives compact results and stream events, so the UI never blocks.
const toolchain = require("./toolchain.cjs");
const diagnostics = require("./diagnostics.cjs");

const diagnosticsContext = () => ({
  root: getWorkspaceRoot(),
  userData: app.getPath("userData"),
  install: app.isPackaged ? process.resourcesPath : app.getAppPath(),
  // Real locations the project root can be resolved from (see project.cjs).
  appPath: app.getAppPath(),
  resourcesPath: process.resourcesPath,
  exePath: app.getPath("exe"),
  appVersion: productVersion(),
  isPackaged: app.isPackaged,
  kernelPort: KERNEL_PORT,
  kernelRunning: Boolean(kernel && !kernel.killed),
  logPath: logFile(),
  packaged: app.isPackaged,
});

let diagnosticsInflight = null;

ipcMain.handle("doctor:run", async (_e, options) => {
  const deep = Boolean(options && options.deep);
  // De-duplicate concurrent scans triggered by impatient clicking.
  if (diagnosticsInflight) return diagnosticsInflight;
  diagnosticsInflight = diagnostics.runDiagnostics(diagnosticsContext(), { deep }).finally(() => {
    diagnosticsInflight = null;
  });
  return diagnosticsInflight;
});

ipcMain.handle("doctor:fix", async (_e, id) => {
  send("doctor:fix-progress", { id, phase: "Repairing" });
  const result = await diagnostics.applyFix(diagnosticsContext(), String(id), { restartKernel });
  send("doctor:fix-progress", { id, phase: result.ok ? "Done" : "Failed", ...result });
  return result;
});

ipcMain.handle("doctor:rollback", (_e, entries) =>
  diagnostics.rollbackFix(Array.isArray(entries) ? entries : []),
);

ipcMain.handle("doctor:export", async (_e, payload) => {
  const root = getWorkspaceRoot() || app.getPath("documents");
  const dir = path.join(root, "debug", "reports");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `friday-diagnostics-${Date.now()}.md`);
  fs.writeFileSync(file, String(payload || ""), "utf8");
  shell.showItemInFolder(file);
  return file;
});

ipcMain.handle("tools:detect", (_e, force) => toolchain.detectTools({ force: Boolean(force) }));
ipcMain.handle("tools:latest", () => toolchain.latestVersions());
ipcMain.handle("tools:active-jobs", () => toolchain.activeJobs());
ipcMain.handle("tools:cancel", (_e, job) => toolchain.cancelJob(job || {}));
ipcMain.handle("tools:run", (_e, job) =>
  toolchain.runJob(
    {
      id: String(job?.id || ""),
      action: String(job?.action || "install"),
      root: job?.root || getWorkspaceRoot(),
    },
    (event) => send("tools:progress", event),
  ),
);

// ---- Import & in-app build -------------------------------------------------
// A FRIDAY ZIP (or folder) is staged, classified and diffed first; nothing is
// written into the workspace until the renderer confirms the apply step.
const importScans = new Map();
const rememberImportScan = (scan) => {
  if (!scan?.ok || !scan.id) return scan;
  const root = getWorkspaceRoot();
  importer.saveScan(root, scan);
  importScans.set(scan.id, { ...scan, workspaceRoot: path.resolve(root) });
  while (importScans.size > 20) importScans.delete(importScans.keys().next().value);
  return scan;
};
const importScan = (value) => {
  const id = typeof value === "string" ? value : value?.id;
  const root = getWorkspaceRoot();
  if (!id || !root) return null;
  const cached = importScans.get(id);
  if (cached?.workspaceRoot === path.resolve(root) && fs.existsSync(cached.contentRoot))
    return cached;
  const restored = importer.loadScans(root).find((scan) => scan.id === id) || null;
  if (restored) importScans.set(id, restored);
  return restored;
};

ipcMain.handle("import:pick-zip", async () => {
  const result = await dialog.showOpenDialog(liveWin(), {
    title: "Select a zip to import",
    properties: ["openFile"],
    filters: [{ name: "FRIDAY package", extensions: ["zip"] }],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
  return { ok: true, file: result.filePaths[0] };
});

ipcMain.handle("import:pick-folder", async () => {
  const result = await dialog.showOpenDialog(liveWin(), {
    title: "Select a folder to import",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
  return { ok: true, folder: result.filePaths[0] };
});

ipcMain.handle("import:stage-bytes", (_e, name, bytes) => {
  try {
    return importer.stageBytes({ root: getWorkspaceRoot(), name, bytes });
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
});

// One file of a multi-file / folder upload. The renderer reuses `id` per batch
// so every file of one drop lands in the same staging folder.
ipcMain.handle("import:stage-file", (_e, id, relative, bytes) => {
  try {
    return importer.stageFile({ root: getWorkspaceRoot(), id, relative, bytes });
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
});

ipcMain.handle("import:download", async (_e, url, name, token) =>
  importer.downloadArchive({
    root: getWorkspaceRoot(),
    url: String(url || ""),
    name,
    token: token ? String(token) : undefined,
  }),
);

// Optional sandbox pass: copy the project, typecheck and test before applying.
ipcMain.handle("import:verify", async (_e, scanOrId) => {
  const scan = importScan(scanOrId);
  if (!scan) return { ok: false, error: "This import is no longer staged — scan it again." };
  const root = buildRunner.sourceRoot(buildContext());
  if (!root) {
    return {
      ok: false,
      skipped: true,
      error: "Sandbox verification needs the FRIDAY source project.",
    };
  }
  return sandbox.verify({
    root,
    areas: (scan.areas || []).map((a) => a.area || a),
    onProgress: (progress) => send("import:progress", { id: scan.id, ...progress }),
  });
});

ipcMain.handle("import:reveal", (_e, target) => {
  const root = getWorkspaceRoot();
  const full =
    typeof target === "string" && path.isAbsolute(target)
      ? target
      : path.join(root || "", String(target || ""));
  if (full && fs.existsSync(full)) shell.showItemInFolder(full);
  return true;
});

ipcMain.handle("import:scan", async (_e, source) => {
  const scan = await importer.scanImport({
    root: getWorkspaceRoot(),
    source: String(source || ""),
    onProgress: (progress) => send("import:progress", progress),
  });
  return rememberImportScan(scan);
});

ipcMain.handle("import:apply", async (_e, scanOrId, options) => {
  const scan = importScan(scanOrId);
  if (!scan) return { ok: false, error: "This import is no longer staged — scan it again." };
  const areas = Array.isArray(options?.areas) ? options.areas : null;
  const result = await importer.applyImport({
    root: getWorkspaceRoot(),
    scan,
    areas,
    onProgress: (progress) => send("import:progress", progress),
  });
  if (result.ok) {
    // Picked up by the existing watcher/rescan path — no second scanner.
    scheduleRescan(getWorkspaceRoot(), 300);
  }
  return result;
});

ipcMain.handle("import:verify-packs", async (_e, scanOrId) => {
  const scan = importScan(scanOrId);
  if (!scan)
    return { ok: false, error: "This import is no longer staged — scan it again.", packs: [] };
  return importer.verifyStagedPacks({ root: getWorkspaceRoot(), scan });
});

ipcMain.handle("import:rollback", (_e, backup) =>
  importer.rollbackImport({ root: getWorkspaceRoot(), backup: String(backup || "") }),
);

// ---- GitHub update source --------------------------------------------------
// FRIDAY's own repository (public or private) as an update feed. Downloads go
// through the importer above, so every GitHub update is backed up, diffed and
// rollback-able exactly like a manually uploaded ZIP.
const githubSync = require("./github-sync.cjs");
let githubTimer = null;

ipcMain.handle("github:config", () =>
  githubSync.publicConfig(githubSync.readConfig(getWorkspaceRoot())),
);

ipcMain.handle("github:set-config", async (_e, patch) => {
  const next = { ...(patch || {}) };
  // An empty token string means "keep the stored token"; null clears it.
  if (next.token === "" || next.token === undefined) delete next.token;
  if (next.token === null) next.token = "";
  const result = githubSync.writeConfig(getWorkspaceRoot(), next);
  scheduleGithubChecks();
  // Await the live session so the renderer reads CONNECTED (or the real error)
  // after save, not a stale snapshot from before reconnectGithub finished.
  if (result.ok) await reconnectGithub();
  return result;
});

ipcMain.handle("github:test", (_e, override) =>
  githubSync.testConnection(getWorkspaceRoot(), override || {}),
);

ipcMain.handle("github:check", async (_e, override) => {
  // A TEST build may look for updates too — that is the only way it can leave
  // the test channel. It is still never polled in the background (see
  // scheduleGithubChecks) and never installs anything by itself: every install
  // stays an explicit, confirmed action in Settings → Updates.
  // The running version decides whether a published release is an upgrade,
  // so FRIDAY never offers to install what she already runs (or older).
  // An INSTALLED FRIDAY only ever looks at published releases — raw source is a
  // development channel and can never update the packaged app.
  const result = await githubSync.checkUpdate(getWorkspaceRoot(), {
    currentVersion: productVersion(),
    ...(BUILD_CHANNEL.isTest ? { updateChannel: "test" } : {}),
    ...(override || {}),
    ...(app.isPackaged ? { channel: "release" } : {}),
    ...(BUILD_CHANNEL.isTest ? { channel: "release" } : {}),
  });
  // The renderer hides the source "Download & apply" action for a packaged app.
  return { ...(result || {}), packaged: app.isPackaged };
});

ipcMain.handle("github:pull", async (_e, ref, options = {}) => {
  // Source ZIPs are a DEVELOPER channel (Import & Build). An installed,
  // packaged FRIDAY is only ever updated by a verified release installer
  // (github:download-build → github:install-update), never by source.
  if (app.isPackaged) {
    return {
      ok: false,
      sourceUpdateBlocked: true,
      error:
        "An installed FRIDAY updates from published release installers only. Use Import & Build for source packages.",
    };
  }
  const scan = await githubSync.pullUpdate({
    root: getWorkspaceRoot(),
    importer,
    ref: ref ? String(ref) : null,
    onProgress: (progress) => send("import:progress", progress),
  });
  return rememberImportScan(scan);
});

ipcMain.handle("github:record", (_e, payload) =>
  githubSync.recordApplied(getWorkspaceRoot(), payload || {}),
);

// ---- Release control (GitHub Actions) ---------------------------------------
// FRIDAY never builds a release locally: "Build & Release" starts the same
// .github/workflows/release.yml a human runs from the Actions tab, so version,
// changelog, EXE and cleanup are produced by one system only.
const githubRelease = require("./github-release.cjs");

ipcMain.handle("github:releases", (_e, override) =>
  githubRelease.listReleases(getWorkspaceRoot(), override || {}),
);

ipcMain.handle("github:installer-bundles", (_e, override) =>
  githubRelease.listInstallerBundles(getWorkspaceRoot(), override || {}),
);

ipcMain.handle("github:analyze", (_e, override) =>
  githubRelease.analyzeChanges(getWorkspaceRoot(), override || {}),
);

ipcMain.handle("github:dispatch-release", (_e, input) => {
  // A test EXE must never create a GitHub Release or a version tag.
  if (BUILD_CHANNEL.isTest) return buildChannel.blocked("Creating a release");
  // Nor may a FRIDAY sitting on the TEST update channel promote anything: test
  // artifacts never become official releases, and never automatically.
  const cfg = githubSync.readConfig(getWorkspaceRoot());
  if (githubSync.normalizeUpdateChannel(cfg.updateChannel) === "test") {
    return {
      ok: false,
      testChannel: true,
      error:
        "FRIDAY is on the TEST update channel. Switch Settings → Updates back to Stable before publishing an official release.",
    };
  }
  return githubRelease.dispatchRelease(getWorkspaceRoot(), input || {});
});

// Which release stage is legitimate right now: prepare the PR, or publish the
// merged main commit. FRIDAY reads this, it never merges anything itself.
ipcMain.handle("github:release-status", (_e, override) =>
  githubRelease.releaseStatus(getWorkspaceRoot(), override || {}),
);

// A branch/PR TEST EXE. Allowed on the test channel — it creates no official
// version, tag or stable release.
ipcMain.handle("github:dispatch-test-build", (_e, input) =>
  githubRelease.dispatchTestBuild(getWorkspaceRoot(), input || {}),
);

ipcMain.handle("github:release-runs", (_e, override) =>
  githubRelease.releaseRuns(getWorkspaceRoot(), override || {}),
);

// ---- Release installer channel ---------------------------------------------
// An installed FRIDAY updates from VERIFIED GitHub RELEASES only — never from
// raw repository source. The artifact is checksum-checked against the release
// manifest, the FRIDAY data is backed up, and the pending update is recorded so
// the next launch can health-check it and roll back if it did not come up.
const updateSafety = require("./update-safety.cjs");
const githubPush = require("./github-push.cjs");

ipcMain.handle("github:download-installer", async (_e, payload) => {
  // A TEST build downloads updates too (TEST → newer TEST, TEST → Stable).
  // Verification, backup, channel confirmation and rollback are enforced by
  // github:install-update exactly as they are for a Stable build.
  const root = getWorkspaceRoot();
  // The checksum must come from the manifest of the SAME release the asset
  // belongs to. A Stable ⇄ Test download therefore re-reads the release on the
  // channel it is crossing to, never the currently selected one.
  const wantTest = payload?.testBuild === true;
  const check = await githubSync.checkUpdate(root, {
    channel: "release",
    updateChannel: wantTest ? "test" : "stable",
    currentVersion: productVersion(),
  });
  const pool = [...(check?.assets || []), ...(check?.otherChannel?.assets || [])];
  const listed = githubSync.installerAsset(pool);
  const matched =
    pool.find((a) => payload?.name && a.name === payload.name) ||
    pool.find((a) => payload?.url && (a.url === payload.url || a.apiUrl === payload.url)) ||
    listed;
  const asset = {
    ...listed,
    ...matched,
    url: payload?.url || matched?.url || listed?.url,
    apiUrl: payload?.apiUrl || matched?.apiUrl || listed?.apiUrl,
    id: payload?.id || matched?.id || listed?.id,
    name: payload?.name || matched?.name || listed?.name,
    bytes: payload?.bytes || matched?.bytes || listed?.bytes,
  };
  if (!asset?.url && !asset?.apiUrl) {
    return {
      ok: false,
      error:
        check && check.ok === false
          ? check.error || "The release could not be read."
          : "This release does not publish a Windows installer.",
    };
  }
  const expected =
    githubSync.expectedChecksum(check?.manifest, asset.name) ||
    githubSync.expectedChecksum(check?.otherChannel?.manifest, asset.name);
  const progress = (info) => {
    send("import:progress", info);
    send("github:download-progress", info);
  };
  return githubSync.downloadInstaller({
    root,
    url: asset.url,
    apiUrl: asset.apiUrl,
    assetId: asset.id,
    name: asset.name,
    bytes: asset.bytes,
    sha256: expected,
    onProgress: progress,
  });
});

/**
 * Install a downloaded release: verify → backup → record → run installer.
 * Any failed step stops here and leaves the installed FRIDAY untouched.
 */
ipcMain.handle("github:install-update", async (_e, payload = {}) => {
  const root = getWorkspaceRoot();
  const file = String(payload.file || "");
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };
  if (!file || !fs.existsSync(file)) return { ok: false, error: "The installer file is missing." };

  // Channel gate. A test build is installable ONLY from the TEST channel and
  // only when the owner said so explicitly — it can never arrive on stable by
  // itself. Crossing channels (Stable → TEST, TEST → Stable) is allowed, but
  // only as a deliberate act: the request must carry acceptChannelSwitch.
  const channel = githubSync.normalizeUpdateChannel(githubSync.readConfig(root).updateChannel);
  const wantsTest = payload.testBuild === true;
  const targetChannel = wantsTest ? "test" : "stable";
  const crossing = targetChannel !== channel;
  if (crossing && payload.acceptChannelSwitch !== true) {
    return {
      ok: false,
      channelMismatch: true,
      requiresChannelSwitch: true,
      fromChannel: channel,
      toChannel: targetChannel,
      error: wantsTest
        ? "This is a TEST build. Confirm the switch to the Test channel to install it."
        : "This is an official Stable release. Confirm the switch back to the Stable channel to install it.",
    };
  }
  if (wantsTest && payload.acceptTest !== true) {
    return {
      ok: false,
      requiresTestConfirmation: true,
      error: "Confirm that you want to install a TEST build over this FRIDAY.",
    };
  }

  const verified = updateSafety.verifyArtifact({
    file,
    expected: payload.sha256 || null,
    version: payload.version || null,
    currentVersion: productVersion(),
    // A deliberate channel switch may install a build that is not strictly
    // newer (TEST 1.3.2-test.1 → Stable 1.3.2, or back); every other path
    // still refuses a downgrade.
    channelSwitch: crossing,
  });
  if (!verified.ok) return verified;
  // An unsigned/unmanifested release may only proceed when the owner accepted it.
  if (!verified.verified && payload.acceptUnverified !== true) {
    return {
      ok: false,
      unverified: true,
      error: "This release publishes no checksum manifest. Confirm before installing.",
    };
  }

  // Release sqlite/python handles before copying `database/` and before NSIS
  // replaces files. A live kernel on Windows locks friday.sqlite3.
  await stopKernel();
  const backup = updateSafety.backupState({ root, version: payload.version });
  if (!backup.ok) {
    await resumeKernel("kernel resume after failed update backup");
    return backup;
  }
  const pending = updateSafety.beginInstall({
    root,
    version: payload.version || null,
    currentVersion: productVersion(),
    installer: file,
    backup: backup.backup,
    sha256: verified.sha256,
  });
  if (!pending.ok) {
    await resumeKernel("kernel resume after failed update record");
    return pending;
  }

  if (process.platform !== "win32") {
    await resumeKernel("kernel resume after staged installer");
    return { ok: true, staged: true, backup: backup.backup, message: "Installer staged." };
  }
  try {
    const child = require("child_process").spawn(file, [], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
  } catch (error) {
    updateSafety.cancelInstall({ root });
    await resumeKernel("kernel resume after installer launch failure");
    return { ok: false, error: String(error.message || error) };
  }
  // Move channels only after Windows accepted the installer process. A failed
  // launch must leave both update state and the selected channel unchanged.
  if (crossing) {
    const moved = githubSync.writeConfig(root, { updateChannel: targetChannel });
    if (!moved.ok) {
      updateSafety.cancelInstall({ root });
      await resumeKernel("kernel resume after channel-switch failure");
      return moved;
    }
  }
  setTimeout(() => app.quit(), 1200);
  return { ok: true, launched: file, backup: backup.backup, verified: verified.verified };
});

/** Pending/stable update state and the rollback the owner can trigger. */
ipcMain.handle("github:update-state", () => {
  const root = getWorkspaceRoot();
  return {
    ok: true,
    pending: updateSafety.pendingUpdate(root),
    stable: root ? updateSafety.stable(root) : null,
    version: productVersion(),
  };
});

ipcMain.handle("github:rollback", async (_e, backup) => {
  // The kernel holds database/friday.sqlite3; restoring PROTECTED folders
  // while it is alive fails on Windows (EBUSY) and can copy a torn sqlite.
  await stopKernel();
  const result = updateSafety.rollback({
    root: getWorkspaceRoot(),
    backup: backup || null,
  });
  await resumeKernel("kernel resume after rollback");
  return result;
});

// ---- Source push (explicit, never automatic) -------------------------------
ipcMain.handle("github:source-status", () => githubPush.sourceStatus(getWorkspaceRoot()));
ipcMain.handle("github:source-sync", () => githubPush.syncState(getWorkspaceRoot()));
ipcMain.handle("github:push-source", (_e, input = {}) =>
  githubPush.pushSource(getWorkspaceRoot(), { ...input, confirm: input.confirm === true }),
);
// Commit + push, then wait until GitHub really reports the new commit — used
// before a release so CI never builds stale source.
ipcMain.handle("github:push-and-sync", (_e, input = {}) =>
  githubPush.pushAndWait(getWorkspaceRoot(), { ...input, confirm: input.confirm === true }),
);

ipcMain.handle("github:run-installer", async (_e, file) => {
  const target = String(file || "");
  if (!target || !fs.existsSync(target)) {
    return { ok: false, error: "The installer file could not be found." };
  }
  if (process.platform !== "win32") {
    return { ok: false, error: "Running the installer is a Windows-only step." };
  }
  await stopKernel();
  try {
    const child = require("child_process").spawn(target, [], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
  } catch (error) {
    await resumeKernel("kernel resume after installer launch failure");
    return { ok: false, error: String(error.message || error) };
  }
  // The installer closes FRIDAY itself, but quitting first avoids a locked EXE.
  setTimeout(() => app.quit(), 1200);
  return { ok: true, launched: target };
});

/** Background polling — off unless the owner turns autoCheck on. */
function scheduleGithubChecks() {
  if (githubTimer) {
    clearInterval(githubTimer);
    githubTimer = null;
  }
  const root = getWorkspaceRoot();
  if (!root) return;
  // Portable test builds are outside the stable channel — no background polling.
  if (BUILD_CHANNEL.isTest) return;
  const cfg = githubSync.readConfig(root);
  if (!cfg.autoCheck || !cfg.repo) return;
  const every = Math.max(1, Number(cfg.intervalHours) || 6) * 3600_000;
  githubTimer = setInterval(async () => {
    try {
      const root = getWorkspaceRoot();
      const result = await githubSync.checkUpdate(root, {
        currentVersion: productVersion(),
        ...(app.isPackaged ? { channel: "release" } : {}),
      });
      if (!result?.ok || !result.updateAvailable) return;
      send("github:update-available", result);
      // A packaged FRIDAY is only ever replaced by a verified release the owner
      // approves — background polling notifies, it never installs.
      if (app.isPackaged || result.channel === "release") return;
      const live = githubSync.readConfig(root);
      // The TEST channel is never silent: a test build is only ever installed
      // by an explicit action in Settings → Updates.
      if (githubSync.normalizeUpdateChannel(live.updateChannel) === "test") return;
      // Development source channel: FRIDAY may apply it herself, with a backup.
      if (live.autoApply) {
        const scan = await githubSync.pullUpdate({ root, importer, ref: result.ref });
        if (!scan?.ok) return;
        rememberImportScan(scan);
        const applied = await importer.applyImport({ root, scan });
        if (applied?.ok) {
          githubSync.recordApplied(root, {
            ref: result.ref,
            applied: applied.applied,
            areas: applied.areas,
            backup: applied.backup,
            notes: result.title,
          });
          scheduleRescan(root, 300);
          send("github:update-available", {
            ...result,
            applied: applied.applied,
            autoApplied: true,
          });
        }
      }
    } catch {
      /* offline — the next tick tries again */
    }
  }, every);
  if (githubTimer.unref) githubTimer.unref();
}

/**
 * Startup reconnect. The owner enters the GitHub token once; on every launch
 * FRIDAY loads it from the encrypted credential store and re-establishes the
 * session herself. A failure never clears the credential.
 */
async function reconnectGithub() {
  const root = getWorkspaceRoot();
  if (!root) return githubSync.connection();
  const state = await githubSync.connect(root);
  send("github:connection", state);
  return state;
}

ipcMain.handle("github:connection", (_e, refresh) =>
  refresh ? reconnectGithub() : githubSync.connection(),
);

/**
 * Post-update health check. If a release was installed, this launch proves it
 * came up; if the running version is not the one that was installed, the
 * pending record is marked failed and the renderer is offered the rollback.
 */
function checkUpdateHealth() {
  const root = getWorkspaceRoot();
  if (!root) return null;
  try {
    const health = updateSafety.healthCheck({ root, version: productVersion() });
    if (health.state === "updated" || health.state === "failed")
      send("github:update-health", health);
    return health;
  } catch {
    return null;
  }
}

app.whenReady().then(() => {
  setTimeout(scheduleGithubChecks, 8000);
  setTimeout(() => void reconnectGithub(), 9000);
  setTimeout(checkUpdateHealth, 10000);
});

// ---- Friday Hub workbench --------------------------------------------------
// Everything the Hub inspects stays in its staged copy until the owner picks
// which capabilities to adopt. The staged copy can be listed, previewed,
// edited and tested first — the live FRIDAY tree is only touched by
// hub:extract, which backs up exactly like a full import.
const hubLab = require("./hub-lab.cjs");

// ------------------------------------------------------- Friday Hub · dev flow
// Repo control only: inspect, validate, branch, push, pull request. Nothing
// here releases or installs — that stays with github-release/github-sync.
const devFlow = require("./dev-workflow.cjs");

const devDir = () => buildRunner.sourceRoot(buildContext()) || getWorkspaceRoot();

/** Selected Hub repo checkout. FRIDAY herself still uses `devDir()` for source-push. */
function hubDir() {
  const target = githubSync.hubTarget(getWorkspaceRoot());
  if (target.role === "linked" && target.dir) return target.dir;
  return devDir();
}

function hubOverride() {
  return githubSync.hubTarget(getWorkspaceRoot()).cfg || {};
}

async function afterHubSelect() {
  const listed = githubSync.listConnections(getWorkspaceRoot());
  const checkout = await devFlow.ensureCheckout(getWorkspaceRoot());
  return { ...listed, checkout };
}

ipcMain.handle("dev:workspace", () => devFlow.workspace(getWorkspaceRoot(), hubDir()));
ipcMain.handle("dev:diff", (_e, file) =>
  devFlow.diff(getWorkspaceRoot(), { dir: hubDir(), file: file ? String(file) : null }),
);
ipcMain.handle("dev:validate", async (_e, payload = {}) => {
  const target = BrowserWindow.getAllWindows()[0];
  return devFlow.validate(getWorkspaceRoot(), {
    dir: hubDir(),
    steps: Array.isArray(payload.steps) ? payload.steps : null,
    onProgress: (step) => target?.webContents.send("dev:validate-progress", step),
  });
});
ipcMain.handle("dev:branch", (_e, payload = {}) =>
  devFlow.createBranch(getWorkspaceRoot(), { ...payload, dir: hubDir() }),
);
ipcMain.handle("dev:checkout-branch", (_e, payload = {}) =>
  devFlow.checkoutBranch(getWorkspaceRoot(), { ...payload, dir: hubDir() }),
);
ipcMain.handle("dev:publish", (_e, payload = {}) =>
  devFlow.publishBranch(getWorkspaceRoot(), { ...payload, dir: hubDir() }),
);
ipcMain.handle("dev:open-pr", (_e, payload = {}) =>
  devFlow.openPullRequest(getWorkspaceRoot(), payload || {}),
);
ipcMain.handle("dev:pull-requests", () => devFlow.pullRequests(getWorkspaceRoot()));
ipcMain.handle("dev:change-sets", () => ({
  ok: true,
  changeSets: devFlow.changeSets(getWorkspaceRoot()),
}));
ipcMain.handle("dev:queue-change-set", (_e, entry = {}) =>
  devFlow.queueChangeSet(getWorkspaceRoot(), entry || {}),
);
ipcMain.handle("dev:update-change-set", (_e, id, patch = {}) =>
  devFlow.updateChangeSet(getWorkspaceRoot(), String(id || ""), patch || {}),
);
ipcMain.handle("dev:remove-change-set", (_e, id) =>
  devFlow.removeChangeSet(getWorkspaceRoot(), String(id || "")),
);
ipcMain.handle("dev:list-files", () =>
  devFlow.listWorkingFiles(getWorkspaceRoot(), { dir: hubDir() }),
);
ipcMain.handle("dev:read-file", (_e, file) =>
  devFlow.readWorkingFile(getWorkspaceRoot(), { dir: hubDir(), file }),
);
ipcMain.handle("dev:write-file", (_e, payload = {}) =>
  devFlow.writeWorkingFile(getWorkspaceRoot(), { ...payload, dir: hubDir() }),
);
ipcMain.handle("dev:commit-files", (_e, payload = {}) =>
  devFlow.commitWorkingTree(getWorkspaceRoot(), { ...payload, dir: hubDir() }),
);

// Manual Revert Center — two independent safety actions. Neither depends on a
// recovery branch; neither merges, resets or force-pushes.
ipcMain.handle("dev:history", (_e, payload = {}) =>
  devFlow.history(getWorkspaceRoot(), { ...payload, dir: hubDir() }),
);
ipcMain.handle("dev:merged-prs", () => devFlow.mergedPullRequests(getWorkspaceRoot()));
ipcMain.handle("dev:commit", (_e, sha) =>
  devFlow.commitDetail(getWorkspaceRoot(), { dir: hubDir(), sha }),
);
ipcMain.handle("dev:restore-preview", (_e, sha) =>
  devFlow.restorePreview(getWorkspaceRoot(), { dir: hubDir(), sha }),
);
ipcMain.handle("dev:revert-commit", (_e, payload = {}) =>
  devFlow.revertCommit(getWorkspaceRoot(), { ...payload, dir: hubDir() }),
);
ipcMain.handle("dev:restore-commit", (_e, payload = {}) =>
  devFlow.restoreToCommit(getWorkspaceRoot(), { ...payload, dir: hubDir() }),
);

// Hub multi-repo list — separate from Settings → Updates (`github:check`).
ipcMain.handle("github:hub-connections", () => githubSync.listConnections(getWorkspaceRoot()));
ipcMain.handle("github:hub-add-connection", async (_e, payload = {}) => {
  const added = await githubSync.addConnection(getWorkspaceRoot(), payload || {});
  if (!added.ok) return added;
  const checkout = await devFlow.ensureCheckout(getWorkspaceRoot());
  return { ...added, checkout };
});
ipcMain.handle("github:hub-remove-connection", (_e, id) =>
  githubSync.removeConnection(getWorkspaceRoot(), String(id || "")),
);
ipcMain.handle("github:hub-select-connection", async (_e, id) => {
  const selected = githubSync.selectConnection(getWorkspaceRoot(), String(id || ""));
  if (!selected.ok) return selected;
  return afterHubSelect();
});
ipcMain.handle("github:hub-test-connection", (_e, id) =>
  githubSync.testHubConnection(getWorkspaceRoot(), String(id || "")),
);
ipcMain.handle("github:hub-workflows", () =>
  githubRelease.listWorkflows(getWorkspaceRoot(), hubOverride()),
);
ipcMain.handle("github:hub-dispatch-workflow", (_e, payload = {}) =>
  githubRelease.dispatchWorkflow(getWorkspaceRoot(), payload || {}, hubOverride()),
);
ipcMain.handle("github:hub-releases", () =>
  githubRelease.listReleases(getWorkspaceRoot(), hubOverride()),
);
ipcMain.handle("github:create-repo", async (_e, payload = {}) => {
  const created = await githubRelease.createRepository(getWorkspaceRoot(), payload || {});
  if (!created.ok) return created;
  const token = githubSync.readConfig(getWorkspaceRoot()).token || "";
  const added = await githubSync.addConnection(getWorkspaceRoot(), {
    repo: created.repo,
    token,
    label: created.repo,
  });
  if (!added.ok) return { ...created, connected: false, connectError: added.error };
  const checkout = await devFlow.ensureCheckout(getWorkspaceRoot());
  return { ...created, connected: true, ...added, checkout };
});
ipcMain.handle("github:package-push", (_e, payload = {}) =>
  devFlow.bootstrapFromSource(getWorkspaceRoot(), { ...payload, dir: hubDir() }),
);

const stagedDir = (scanId) => {
  const scan = importScan(String(scanId || ""));
  return scan && scan.contentRoot && fs.existsSync(scan.contentRoot) ? scan.contentRoot : null;
};

ipcMain.handle("hub:files", (_e, scanId) => {
  const dir = stagedDir(scanId);
  if (!dir) return { ok: false, error: "This import is no longer staged — bring it in again." };
  return hubLab.listStaged({ dir });
});

ipcMain.handle("hub:read", (_e, scanId, file) => {
  const dir = stagedDir(scanId);
  if (!dir) return { ok: false, error: "This import is no longer staged — bring it in again." };
  return hubLab.readStaged({ dir, file: String(file || "") });
});

ipcMain.handle("hub:write", (_e, scanId, file, content) => {
  const dir = stagedDir(scanId);
  if (!dir) return { ok: false, error: "This import is no longer staged — bring it in again." };
  return hubLab.writeStaged({ dir, file: String(file || ""), content });
});

ipcMain.handle("hub:analyze", (_e, scanId) => {
  const dir = stagedDir(scanId);
  if (!dir) return { ok: false, error: "This import is no longer staged — bring it in again." };
  return hubLab.analyze({ root: getWorkspaceRoot(), dir });
});

ipcMain.handle("hub:extract", (_e, scanId, groups) => {
  const dir = stagedDir(scanId);
  if (!dir) return { ok: false, error: "This import is no longer staged — bring it in again." };
  const result = hubLab.extract({
    root: getWorkspaceRoot(),
    dir,
    groups: Array.isArray(groups) ? groups : [],
  });
  if (result.ok && result.applied) scheduleRescan(getWorkspaceRoot(), 300);
  return result;
});

// Open the staged import as a real isolated sandbox project so it can be run,
// tested and previewed with the runtime FRIDAY already ships.
ipcMain.handle("hub:workbench", (_e, scanId, name) => {
  const dir = stagedDir(scanId);
  if (!dir) return { ok: false, error: "This import is no longer staged — bring it in again." };
  const created = sandboxLab.createProject(labRoot(), {
    name: `hub-${String(name || "import")}`,
    template: "blank",
  });
  if (!created.ok) return created;
  const imported = sandboxLab.importFolder(labRoot(), { id: created.project.id, folder: dir });
  if (!imported.ok) return imported;
  return { ok: true, project: created.project, files: imported.files };
});

// ---- Builds ----------------------------------------------------------------
// Building a new FRIDAY version needs the FRIDAY *source* project. When FRIDAY
// runs from an installed EXE the owner points at it once and it is remembered.
const buildRootFile = () => {
  const root = getWorkspaceRoot();
  return root ? path.join(root, "config", "build-root.json") : null;
};

function savedBuildRoot() {
  try {
    const file = buildRootFile();
    if (!file || !fs.existsSync(file)) return null;
    const saved = JSON.parse(fs.readFileSync(file, "utf8")).root;
    return typeof saved === "string" && fs.existsSync(saved) ? saved : null;
  } catch {
    return null;
  }
}

function rememberBuildRoot(dir) {
  try {
    const file = buildRootFile();
    if (!file) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ root: dir, at: Date.now() }, null, 2));
    return true;
  } catch {
    return false;
  }
}

const buildContext = () => ({
  appPath: app.getAppPath(),
  projectRoot: savedBuildRoot() || getWorkspaceRoot(),
});

ipcMain.handle("build:start", (_e, kind, options) => {
  const opts =
    kind && typeof kind === "object"
      ? kind
      : {
          kind: String(kind || "exe"),
          ...(options && typeof options === "object" ? options : {}),
        };
  const clientId = opts.clientId ? String(opts.clientId) : "";
  const onProgress = (progress) =>
    send("build:progress", clientId ? { ...progress, clientId } : progress);
  if (String(opts.identity || "friday") === "other") {
    return importFactory.startBuild({
      kind: String(opts.kind || "zip"),
      name: opts.name,
      version: opts.version,
      sourceDir: opts.sourceDir,
      scanId: opts.scanId,
      clientId,
      workspaceRoot: getWorkspaceRoot(),
      resolveScan: importScan,
      onProgress,
    });
  }
  return buildRunner.startBuild({
    kind: String(opts.kind || kind || "exe"),
    context: buildContext(),
    onProgress,
  });
});
ipcMain.handle("build:cancel", (_e, id) => {
  const key = String(id || "");
  if (key.startsWith("factory-")) return importFactory.cancelBuild(key);
  return buildRunner.cancelBuild(key);
});
ipcMain.handle("build:active", () => [
  ...buildRunner.activeBuilds(),
  ...importFactory.activeBuilds(),
]);
ipcMain.handle("build:artifacts", () => {
  const root = buildRunner.sourceRoot(buildContext());
  const official = root ? buildRunner.artifacts(root) : [];
  const kept = importFactory.listKept(getWorkspaceRoot());
  return [...kept, ...official].sort((a, b) => (b.at || 0) - (a.at || 0));
});
ipcMain.handle("build:reveal", (_e, file) => {
  if (typeof file === "string" && fs.existsSync(file)) shell.showItemInFolder(file);
  return true;
});
ipcMain.handle("factory:inspect", (_e, dir) => importFactory.inspectSource(dir));
ipcMain.handle("factory:pick-source", async () => {
  const result = await dialog.showOpenDialog(liveWin(), {
    title: "Select a project folder to package (not FRIDAY's GitHub repo)",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
  return importFactory.inspectSource(result.filePaths[0]);
});
ipcMain.handle("factory:keep", (_e, file) =>
  importFactory.keepArtifact({ workspaceRoot: getWorkspaceRoot(), file: String(file || "") }),
);
ipcMain.handle("factory:save-as", async (_e, file) => {
  const from = String(file || "");
  if (!from || !fs.existsSync(from))
    return { ok: false, error: "That artifact is no longer on disk." };
  const result = await dialog.showSaveDialog(liveWin(), {
    title: "Keep a copy of this artifact",
    defaultPath: path.basename(from),
  });
  if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
  fs.copyFileSync(from, result.filePath);
  return { ok: true, path: result.filePath };
});
ipcMain.handle("factory:install-exe", async (_e, file) => {
  const verdict = importFactory.installArtifact(String(file || ""));
  if (!verdict.ok) return verdict;
  const err = await shell.openPath(verdict.file);
  if (err) return { ok: false, error: err };
  return { ok: true, file: verdict.file };
});
ipcMain.handle("factory:list-kept", () => importFactory.listKept(getWorkspaceRoot()));
// Where builds will run from, and whether that folder really is buildable.
ipcMain.handle("build:root", () => {
  const root = buildRunner.sourceRoot(buildContext());
  return {
    ok: Boolean(root),
    root,
    saved: savedBuildRoot(),
    ...(root ? buildRunner.preflight(root) : {}),
  };
});
ipcMain.handle("build:pick-root", async () => {
  const result = await dialog.showOpenDialog(liveWin(), {
    title: "Select your FRIDAY source project folder",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
  const picked = result.filePaths[0];
  const root = buildRunner.sourceRoot({ projectRoot: picked });
  if (!root) {
    return {
      ok: false,
      error:
        "That folder is not a FRIDAY source project (package.json + scripts\\build-windows.cmd were not found).",
    };
  }
  rememberBuildRoot(root);
  return { ok: true, root, ...buildRunner.preflight(root) };
});

// ---- Self-maintenance ------------------------------------------------------
// FRIDAY watches her own project, works out the impact of every change,
// verifies it in a sandbox and only then adopts it — with a rollback ready.

/** The real post-change health probe: kernel reachable + workspace intact. */
async function selfHealthCheck() {
  const details = [];
  const kernelOk = await waitForKernel(8000);
  details.push(kernelOk ? "kernel responding" : "kernel not responding");
  const root = getWorkspaceRoot();
  const workspace = root ? verifyWorkspace(root) : null;
  const workspaceOk = workspace ? workspace.ok !== false : false;
  details.push(workspaceOk ? "workspace layout intact" : "workspace layout incomplete");
  const windowOk = Boolean(win && !win.isDestroyed());
  details.push(windowOk ? "window alive" : "window lost");
  return { ok: kernelOk && workspaceOk && windowOk, detail: details.join(" · ") };
}

function initSelfMaintenance(root) {
  if (!root) return;
  // Local LoRA/QLoRA training lives beside self-maintenance: same workspace
  // root, same logging, and it never runs without the owner's approval.
  finetune.init({ send, log, projectRoot: app.isPackaged ? null : path.join(__dirname, "..") });
  selfMaintenance.init({
    root,
    send,
    log,
    health: selfHealthCheck,
    buildContext,
  });
  // Index in the background; offline edits surface as soon as it is ready.
  selfMaintenance
    .ensureIndex({ root })
    .then(() => selfMaintenance.detectOfflineChanges(root))
    .then((changes) => {
      if (changes?.length) return selfMaintenance.assessBatch(changes);
      return null;
    })
    .catch((error) => log(`self-maintenance index failed: ${error.message}`));
}

ipcMain.handle("self:state", () => selfMaintenance.snapshot());
ipcMain.handle("self:index", async (_e, rebuild) => {
  await selfMaintenance.ensureIndex({ root: getWorkspaceRoot(), rebuild: Boolean(rebuild) });
  return selfMaintenance.summarizeIndex();
});
ipcMain.handle("self:scan", async () => {
  const changes = await selfMaintenance.detectOfflineChanges(getWorkspaceRoot());
  const assessment = changes.length ? await selfMaintenance.assessBatch(changes) : null;
  return { changes: changes.length, assessment };
});
ipcMain.handle("self:apply", (_e, payload) =>
  selfMaintenance.apply({
    id: String(payload?.id || ""),
    mode: payload?.mode === "auto" ? "auto" : "manual",
    onProgress: (progress) => send("self:progress", progress),
  }),
);
ipcMain.handle("self:rollback", (_e, backup) => selfMaintenance.rollback({ backup }));
// Verify-only: the same sandbox checks as an apply, with nothing written, so a
// self-improvement candidate can be compared against the current baseline
// BEFORE the owner is asked to approve it.
ipcMain.handle("self:verify", (_e, payload) =>
  selfMaintenance.verifyOnly({ areas: Array.isArray(payload?.areas) ? payload.areas : [] }),
);
ipcMain.handle("self:health", () => selfHealthCheck());

// ---------------------------------------------------------------- fine-tuning
// Entirely local: FRIDAY's own verified experience data trains a LoRA/QLoRA
// adapter on this PC. `finetune:start` is only ever reached after the renderer
// has taken the owner through the governance approval gate.
ipcMain.handle("finetune:state", () => finetune.snapshot());
ipcMain.handle("finetune:probe", () => finetune.probe());
ipcMain.handle("finetune:start", (_e, payload) => finetune.start(payload || {}));
ipcMain.handle("finetune:cancel", () => finetune.cancel());
ipcMain.handle("finetune:adapters", () => finetune.listAdapters());
ipcMain.handle("finetune:activate", (_e, id) => finetune.activate(id ? String(id) : null));
ipcMain.handle("finetune:remove", (_e, id) => finetune.remove(String(id || "")));

// Read-only access to FRIDAY's own project source, so self-diagnosis and an
// approved fix can be based on the real file instead of a guess. There is no
// matching write channel on purpose: source writes stay behind self:apply and
// the governance approval gate.
ipcMain.handle("self:read-source", (_e, relative) =>
  sourceAccess.readSource(getWorkspaceRoot(), relative),
);
ipcMain.handle("self:list-source", (_e, relative) =>
  sourceAccess.listSources(getWorkspaceRoot(), relative || ""),
);
ipcMain.handle("self:search-source", (_e, query, options) =>
  sourceAccess.searchSource(getWorkspaceRoot(), query, options || {}),
);

// ---- Connectivity graph -----------------------------------------------------
// One derived answer to "is every feature still wired to FRIDAY?": IPC channels
// ↔ preload bridge, kernel bridge methods ↔ callers, routes ↔ navigation and
// capability trees ↔ discovery. Recomputed whenever the project changes, so a
// feature added later shows up without anyone maintaining a list.
ipcMain.handle("connectivity:graph", () =>
  connectivityGraph.connectivity(projectPaths.resolveProjectRoot({ appPath: app.getAppPath() })),
);
ipcMain.handle("connectivity:refresh", () => {
  const graph = connectivityGraph.connectivity(
    projectPaths.resolveProjectRoot({ appPath: app.getAppPath() }),
    { refresh: true },
  );
  send("connectivity:changed", { at: graph.at, ok: graph.ok, summary: graph.summary });
  return graph;
});

// ---- FRIDAY's own browser ---------------------------------------------------
// Search, read, download and screenshot the web from the main process, so the
// renderer never fights CORS and every visit is logged in one place.
ipcMain.handle("browser:search", (_e, query, limit) =>
  fridayBrowser.search(query, { limit: Number(limit) || 8 }),
);
ipcMain.handle("browser:open", (_e, url, options) => fridayBrowser.open(url, options || {}));
ipcMain.handle("browser:download", (_e, url, name) =>
  fridayBrowser.download(url, { root: getWorkspaceRoot(), name: name || null }),
);
ipcMain.handle("browser:screenshot", (_e, url) => fridayBrowser.screenshot(url));
ipcMain.handle("browser:history", (_e, limit) => fridayBrowser.recent(Number(limit) || 40));
ipcMain.handle("browser:interact", (_e, payload) => fridayBrowser.interact(payload || {}));
ipcMain.handle("documents:extract", (_e, payload) => {
  const documents = require("./document-extract.cjs");
  return documents.extract(payload || {});
});
ipcMain.handle("library:list", () => fridayLibrary.list());
ipcMain.handle("library:ingest", (_e, payload) => fridayLibrary.ingest(payload || {}));
ipcMain.handle("library:get", (_e, id) => fridayLibrary.get(id));
ipcMain.handle("library:delete", (_e, id) => fridayLibrary.remove(id));
ipcMain.handle("library:reveal", (_e, id) => fridayLibrary.reveal(id));
ipcMain.handle("library:zip", (_e, ids) => fridayLibrary.zipSelected(ids || []));
ipcMain.handle("library:scan", () => fridayLibrary.scan());
ipcMain.handle("library:write", (_e, payload) => fridayLibrary.writeText(payload || {}));
ipcMain.handle("library:pin", (_e, payload) =>
  fridayLibrary.pin(payload?.id, Boolean(payload?.pinned)),
);
ipcMain.handle("library:patch", (_e, payload) => fridayLibrary.patch(payload?.id, payload || {}));
ipcMain.handle("projects:pick-folder", async () => {
  const result = await dialog.showOpenDialog(liveWin(), {
    title: "Select a project folder (does not change Folders / FRIDAY_ROOT)",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: getWorkspaceRoot() || app.getPath("home"),
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});
ipcMain.handle("projects:list", () => fridayProjects.list());
ipcMain.handle("projects:save", (_e, payload) => fridayProjects.save(payload || {}));
ipcMain.handle("projects:get", (_e, id) => fridayProjects.get(id));
ipcMain.handle("projects:set-active", (_e, id) => fridayProjects.setActive(id ?? null));
ipcMain.handle("projects:duplicate", (_e, id) => fridayProjects.duplicate(id));
ipcMain.handle("projects:archive", (_e, payload) =>
  fridayProjects.archive(payload?.id, Boolean(payload?.archived)),
);
ipcMain.handle("projects:delete", (_e, id) => fridayProjects.remove(id));
ipcMain.handle("projects:reveal", (_e, id) => fridayProjects.reveal(id));
ipcMain.handle("projects:write-file", (_e, payload) =>
  fridayProjects.writeFileInProject(payload || {}),
);
ipcMain.handle("projects:list-files", (_e, id) => fridayProjects.listFiles(id));
ipcMain.handle("projects:read-file", (_e, payload) =>
  fridayProjects.readFileInProject(payload || {}),
);

// ---- Screen awareness (permission-gated, real desktopCapturer) --------------
ipcMain.handle("screen:state", () => screenVision.getState());
ipcMain.handle("screen:set-state", (_e, patch) => screenVision.setState(patch || {}));
ipcMain.handle("screen:sources", () => screenVision.sources());
ipcMain.handle("screen:capture", (_e, options) => screenVision.capture(options || {}));
ipcMain.handle("diagram:ocr", (_e, dataUrl) => diagramOcr.recognizeDataUrl(dataUrl));
ipcMain.handle("camera:state", () => camera.getState());
ipcMain.handle("camera:set-state", (_e, patch) => camera.setState(patch || {}));
ipcMain.handle("camera:capture", (_e, options) => camera.capture(options || {}));
ipcMain.handle("camera:ingest", (_e, payload) => camera.ingest(payload || {}));
ipcMain.handle("camera:clip", (_e, options) => camera.clip(options || {}));

// ---- FRIDAY Browser (live Chromium tabs, same session as above) -------------
ipcMain.handle("browser:settings-get", () => liveBrowser.getSettings());
ipcMain.handle("browser:settings-set", (_e, patch) => liveBrowser.setSettings(patch || {}));
ipcMain.handle("browser:visits", (_e, limit) => liveBrowser.getHistory(Number(limit) || 200));
ipcMain.handle("browser:visit-add", (_e, entry) => liveBrowser.addHistory(entry || {}));
ipcMain.handle("browser:visits-clear", () => liveBrowser.clearHistory());
ipcMain.handle("browser:bookmarks", () => liveBrowser.getBookmarks());
ipcMain.handle("browser:bookmark-add", (_e, entry) => liveBrowser.addBookmark(entry || {}));
ipcMain.handle("browser:bookmark-remove", (_e, url) =>
  liveBrowser.removeBookmark(String(url || "")),
);
ipcMain.handle("browser:tabs-get", () => liveBrowser.getTabs());
ipcMain.handle("browser:tabs-set", (_e, state) => liveBrowser.setTabs(state || {}));
ipcMain.handle("browser:live-publish", (_e, state) => liveBrowser.publishLive(state || {}));
ipcMain.handle("browser:live-get", () => liveBrowser.getLive());
ipcMain.handle("browser:live-command", (_e, payload) => liveBrowser.command(payload || {}));
ipcMain.handle("browser:command-result", (_e, id, result) =>
  liveBrowser.resolveCommand(id, result),
);
ipcMain.handle("browser:downloads", () => liveBrowser.listDownloads());
ipcMain.handle("browser:downloads-clear", () => liveBrowser.clearDownloads());
ipcMain.handle("browser:clear-data", (_e, kinds) => liveBrowser.clearData(kinds));
ipcMain.handle("browser:cookie-count", () => liveBrowser.cookieCount());
ipcMain.handle("browser:clear-origin-cookies", (_e, url) => liveBrowser.clearOriginCookies(url));
ipcMain.handle("browser:active-guest", (_e, id) => liveBrowser.setActiveGuest(id));
ipcMain.handle("browser:reveal-download", (_e, file) => {
  try {
    shell.showItemInFolder(String(file || ""));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});
ipcMain.handle("browser:open-external", (_e, url) => {
  const target = String(url || "");
  if (!/^https?:\/\//i.test(target))
    return { ok: false, error: "Only http(s) URLs can be opened." };
  void shell.openExternal(target);
  return { ok: true };
});

// ---- Capability discovery (manifest-driven auto-registration) --------------
// extraResources (skills/tools/agents/modules/plugins/workflows) land in
// process.resourcesPath next to app.asar — not inside app.getAppPath().
const packagedCapabilityRoot = () =>
  app.isPackaged && process.resourcesPath ? process.resourcesPath : app.getAppPath();
const capabilityRoots = () => ({
  appRoot: packagedCapabilityRoot(),
  workspaceRoot: getWorkspaceRoot(),
});
let stopCapabilityWatch = null;

/**
 * Rebuild the root's own indexes from what is really on disk: registry.json
 * (validated components), integrity.json (structure + digests) and boot.json
 * (this boot's outcome). Runs off the first paint; a failure is logged, never
 * fatal — FRIDAY still starts with a stale registry.
 */
async function rebuildRootIndexes(root, { ms = 0 } = {}) {
  if (!root) return null;
  const version = productVersion();
  try {
    rootRegistry.ensureRootDescriptors(root, { version });
    const scan = capabilityIndex.list({
      appRoot: packagedCapabilityRoot(),
      workspaceRoot: root,
    });
    const registry = rootRegistry.rebuildRegistry(root, scan, { version });
    const layout = paths.describe();
    const folders = paths.NAMES.map((name) => layout[name]).filter(Boolean);
    const integrity = rootRegistry.writeIntegrity(root, folders, { version });
    rootRegistry.writeBootRecord(root, {
      version,
      ms,
      ok: integrity?.ok !== false && registry.totals.invalid === 0,
      components: registry.totals.components,
      invalid: registry.totals.invalid,
      notes: integrity?.folders?.missing?.length
        ? [`missing folders: ${integrity.folders.missing.join(", ")}`]
        : [],
    });
    return { registry, integrity };
  } catch (error) {
    log(`root registry rebuild failed: ${error?.message || error}`);
    return null;
  }
}
ipcMain.handle("root:registry", () => rebuildRootIndexes(getWorkspaceRoot()));

ipcMain.handle("capabilities:list", () => capabilityIndex.list(capabilityRoots()));
ipcMain.handle("capabilities:set-enabled", async (_e, id, enabled) => {
  const key = String(id || "");
  const result = capabilityIndex.setEnabled(capabilityRoots(), key, enabled);
  if (result.ok && key.startsWith("plugins/")) {
    plugins.setEnabled(capabilityRoots(), key, enabled);
  }
  if (result.ok && key.startsWith("modules/")) {
    try {
      await fridayModules.setEnabled(capabilityRoots(), key, enabled, {
        kernelToggle: (name, on) => kernelRequest("module.toggle", { name, enabled: on }, 8000),
      });
    } catch (error) {
      log(`module.toggle after Enable failed: ${error?.message || error}`);
    }
  }
  return result;
});
ipcMain.handle("capabilities:reload", () => {
  stopCapabilityWatch?.();
  stopCapabilityWatch = capabilityIndex.watch(capabilityRoots(), (info) =>
    send("capabilities:changed", info),
  );
  return capabilityIndex.list(capabilityRoots());
});

// Test-before-enable. A pack is written disabled; it is only enabled after it
// really ran inside sandbox.runIsolated(), with any missing dependency
// installed through the Install Manager's own jobs first.
async function verifyInstalledCapability(id) {
  const roots = capabilityRoots();
  const dir = capabilityIndex.packPath(roots.workspaceRoot, id);
  const tree = String(id).split("/")[0];
  const result = await capabilityVerify.verifyCapability(
    { root: roots.workspaceRoot },
    { id, tree, dir },
    { emit: (event) => send("capabilities:verifying", { id, ...event }) },
  );
  capabilityIndex.markVerified(roots, id, result);
  send("capabilities:verified", { id, ...result });
  send("capabilities:changed", { verified: id, enabled: result.ok });
  return result;
}

async function verifyInstalledCapabilities(ids) {
  const verification = [];
  for (const id of ids) verification.push(await verifyInstalledCapability(id));
  return verification;
}

// Marketplace installs — real folders written into the selected workspace.
ipcMain.handle("capabilities:install", async (_e, pack) => {
  const result = capabilityIndex.installPack(capabilityRoots(), pack);
  if (!result.ok) return result;
  send("capabilities:changed", { tree: result.tree, installed: result.id });
  const verification = await verifyInstalledCapability(result.id);
  return { ...result, enabled: verification.ok, verification };
});
// Owner-driven retry after they followed a manual guide or fixed the pack.
ipcMain.handle("capabilities:verify", async (_e, id) => {
  const target = String(id || "");
  if (!capabilityIndex.packPath(capabilityRoots().workspaceRoot, target))
    return { ok: false, error: "That capability is not installed in this workspace." };
  return verifyInstalledCapability(target);
});
ipcMain.handle("capabilities:uninstall", (_e, id) => {
  const result = capabilityIndex.uninstallPack(capabilityRoots(), id);
  if (result.ok) send("capabilities:changed", { removed: result.id });
  return result;
});
ipcMain.handle("capabilities:install-url", async (_e, url) => {
  const result = await capabilityIndex.installFromUrl(capabilityRoots(), url);
  if (!result.ok) return result;
  send("capabilities:changed", { installed: result.installed });
  const verification = await verifyInstalledCapabilities(result.installed || []);
  return { ...result, verification, enabled: verification.every((v) => v.ok) };
});
// `tree` is the page the owner imported from (skills, tools, modules,
// workflows, plugins, agents). A pack file that omits `tree` inherits it, so
// one import flow serves every capability page instead of plugins only.
// ONE install path for every import source. A manifest file and a GitHub repo
// both end up here, so validation and folder writing never fork.
async function installCapabilityPayload(payload, hint) {
  let packs = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.packs)
      ? payload.packs
      : [payload];
  // Skills page is skills-only: heal skill-shaped packs and refuse plugins/tools/…
  if (
    String(hint || "")
      .trim()
      .toLowerCase() === "skills"
  ) {
    const prepared = skillPack.prepareSkillsOnly(packs);
    if (!prepared.ok) return prepared;
    packs = prepared.packs;
  }
  if (
    String(hint || "")
      .trim()
      .toLowerCase() === "tools"
  ) {
    const prepared = toolPack.prepareToolsOnly(packs);
    if (!prepared.ok) return prepared;
    packs = prepared.packs;
  }
  if (
    String(hint || "")
      .trim()
      .toLowerCase() === "agents"
  ) {
    const prepared = agentPack.prepareAgentsOnly(packs);
    if (!prepared.ok) return prepared;
    packs = prepared.packs;
  }
  if (
    String(hint || "")
      .trim()
      .toLowerCase() === "modules"
  ) {
    const prepared = modulePack.prepareModulesOnly(packs);
    if (!prepared.ok) return prepared;
    packs = prepared.packs;
  }
  if (
    String(hint || "")
      .trim()
      .toLowerCase() === "plugins"
  ) {
    const prepared = pluginPack.preparePluginsOnly(packs);
    if (!prepared.ok) return prepared;
    packs = prepared.packs;
  }
  if (
    String(hint || "")
      .trim()
      .toLowerCase() === "workflows"
  ) {
    const prepared = workflowPack.prepareWorkflowsOnly(packs);
    if (!prepared.ok) return prepared;
    packs = prepared.packs;
  }
  const installed = [];
  for (const pack of packs) {
    // ONE routing decision, made by capabilities.cjs::resolveTree from the
    // contract's TREES: the pack's own declaration wins, the import page is
    // only a hint, and an ambiguous manifest is inferred from its shape.
    const one = capabilityIndex.installPack(capabilityRoots(), pack, hint);

    if (!one.ok) return one;
    installed.push(one.id);
  }
  if (!installed.length) return { ok: false, error: "No capability packs were found." };
  send("capabilities:changed", { installed });
  // Same contract as a marketplace install: nothing is enabled until it has
  // really run in the sandbox.
  const verification = await verifyInstalledCapabilities(installed);
  return { ok: true, installed, verification, enabled: verification.every((v) => v.ok) };
}

/** Zip / folder / git clone — classify, keep one tree, same writer. */
async function installClassifiedSource(sourcePath, hint) {
  const root = getWorkspaceRoot();
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return { ok: false, error: "The selected import could not be found." };
  }
  const scan = await importer.scanImport({ root, source: sourcePath });
  if (!scan.ok) return scan;
  const tree = String(hint || "")
    .trim()
    .toLowerCase();
  let payload = [];
  if (tree === "agents") {
    const collected = agentPack.collectAgentPacksFromDir(scan.contentRoot);
    const prepared = agentPack.prepareAgentsOnly(collected.packs, {
      nonAgentKinds: collected.nonAgentKinds,
    });
    if (!prepared.ok) return prepared;
    payload = prepared.packs;
  } else if (tree === "modules") {
    const collected = modulePack.collectModulePacksFromDir(scan.contentRoot);
    const prepared = modulePack.prepareModulesOnly(collected.packs, {
      nonModuleKinds: collected.nonModuleKinds,
    });
    if (!prepared.ok) return prepared;
    payload = prepared.packs;
  } else if (tree === "plugins") {
    const collected = pluginPack.collectPluginPacksFromDir(scan.contentRoot);
    const prepared = pluginPack.preparePluginsOnly(collected.packs, {
      nonPluginKinds: collected.nonPluginKinds,
    });
    if (!prepared.ok) return prepared;
    payload = prepared.packs;
  } else if (tree === "workflows") {
    const collected = workflowPack.collectWorkflowPacksFromDir(scan.contentRoot);
    const prepared = workflowPack.prepareWorkflowsOnly(collected.packs, {
      nonWorkflowKinds: collected.nonWorkflowKinds,
    });
    if (!prepared.ok) return prepared;
    payload = prepared.packs;
  } else if (tree === "tools") {
    const collected = toolPack.collectToolPacksFromDir(scan.contentRoot);
    const prepared = toolPack.prepareToolsOnly(collected.packs, {
      nonToolKinds: collected.nonToolKinds,
    });
    if (!prepared.ok) return prepared;
    payload = prepared.packs;
  } else {
    const collected = skillPack.collectSkillPacksFromDir(scan.contentRoot);
    const prepared = skillPack.prepareSkillsOnly(collected.packs, {
      nonSkillKinds: collected.nonSkillKinds,
    });
    if (!prepared.ok) return prepared;
    payload = prepared.packs;
  }
  return await installCapabilityPayload(payload, hint);
}

/** Zip / folder / git clone on the Skills page — classify, keep skills, same writer. */
async function installSkillSource(sourcePath, hint) {
  return await installClassifiedSource(sourcePath, hint || "skills");
}

ipcMain.handle("capabilities:install-file", async (_e, tree) => {
  const hint = String(tree || "").trim();
  const result = await dialog.showOpenDialog({
    title: hint
      ? `Import a ${hint} pack (manifest .json)`
      : "Import a capability pack (manifest .json)",
    properties: ["openFile"],
    filters: [{ name: "Capability pack", extensions: ["json"] }],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, error: "cancelled" };
  let payload = null;
  try {
    payload = JSON.parse(fs.readFileSync(result.filePaths[0], "utf8"));
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
  return await installCapabilityPayload(payload, hint);
});

// Import the same kind of manifest straight out of a GitHub repository. The
// fetch goes through the GitHub connector's own read-only actions (so it uses
// the owner's already-verified token, proxy and TLS settings), and the install
// is the exact same installCapabilityPayload() call the file import uses.
ipcMain.handle("capabilities:install-github", async (_e, tree, url) => {
  const hint = String(tree || "").trim();
  const target = String(url || "").trim();
  if (!target) return { ok: false, error: "Paste a GitHub repository URL." };
  const root = getWorkspaceRoot();
  const ref = /\/(?:tree|blob)\/([^/]+)/.exec(target)?.[1] || "";
  const inner = /\/(?:tree|blob)\/[^/]+\/(.+)$/.exec(target)?.[1] || "";

  const read = async (filePath) =>
    connectors.callConnector(root, "github", "read-file", {
      repo: target,
      path: filePath,
      ref,
    });

  let payload = null;
  if (/\.json($|\?)/i.test(inner)) {
    const file = await read(inner);
    if (!file.ok) return file;
    payload = safeJson(file.data?.content);
    if (!payload) return { ok: false, error: `${inner} is not valid JSON.` };
  } else {
    const listing = await connectors.callConnector(root, "github", "list-contents", {
      repo: target,
      path: inner,
      ref,
    });
    if (!listing.ok) return listing;
    const files = (listing.data?.entries || []).filter(
      (entry) => entry.type === "file" && /\.json$/i.test(entry.name),
    );
    const preferred = files.filter((entry) =>
      /^(friday\.pack|pack|manifest|capabilities|skill|tool|module|plugin|agent|workflow)\.json$/i.test(
        entry.name,
      ),
    );
    const chosen = (preferred.length ? preferred : files).slice(0, 25);
    if (!chosen.length)
      return { ok: false, error: "That repository folder has no capability manifest (.json)." };
    const packs = [];
    for (const entry of chosen) {
      const file = await read(entry.path);
      if (!file.ok) return file;
      const parsed = safeJson(file.data?.content);
      if (!parsed) continue;
      // A repo file called skill.json / agent.json / tool.json already says
      // which tree it is; keep that name so resolveTree can use it when the
      // manifest itself never declares one.
      const manifestName = String(entry.name).replace(/\.json$/i, "");
      const tag = (pack) =>
        pack && typeof pack === "object" && !pack.tree ? { ...pack, manifestName } : pack;
      if (Array.isArray(parsed)) packs.push(...parsed.map(tag));
      else if (Array.isArray(parsed.packs)) packs.push(...parsed.packs.map(tag));
      else packs.push(tag(parsed));
    }

    // Skills page: pull sibling skill.mjs so a folder-shaped GitHub skill
    // is not healed down to a stub when the code file is right next to it.
    if (hint === "skills") {
      const siblings = [];
      for (const entry of chosen) {
        if (!/skill\.json$/i.test(entry.name)) continue;
        const mjsPath = String(entry.path || entry.name).replace(/skill\.json$/i, "skill.mjs");
        const codeFile = await read(mjsPath);
        const code = codeFile?.ok ? String(codeFile.data?.content || "") : "";
        if (!code) continue;
        siblings.push({ path: String(entry.path || entry.name), code });
      }
      skillPack.attachSiblingSkillCode(packs, siblings);
    }
    if (hint === "tools") {
      const siblings = [];
      for (const entry of chosen) {
        if (!/tool\.json$/i.test(entry.name)) continue;
        const cjsPath = String(entry.path || entry.name).replace(/tool\.json$/i, "index.cjs");
        const codeFile = await read(cjsPath);
        const code = codeFile?.ok ? String(codeFile.data?.content || "") : "";
        if (!code) continue;
        siblings.push({ path: String(entry.path || entry.name), code });
      }
      toolPack.attachSiblingToolCode(packs, siblings);
    }

    payload = packs;
  }
  return await installCapabilityPayload(payload, hint);
});

ipcMain.handle("capabilities:install-skill-zip", async () => {
  const hint = "skills";
  const result = await dialog.showOpenDialog({
    title: "Import skill zip (skill.json / skill.mjs only)",
    properties: ["openFile"],
    filters: [{ name: "Skill zip", extensions: ["zip"] }],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, error: "cancelled" };
  return await installSkillSource(result.filePaths[0], hint);
});

ipcMain.handle("capabilities:install-skill-folder", async () => {
  const hint = "skills";
  const result = await dialog.showOpenDialog({
    title: "Import skill folder (skill.json / skill.mjs only)",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, error: "cancelled" };
  return await installSkillSource(result.filePaths[0], hint);
});

ipcMain.handle("capabilities:install-skill-git", async (_e, url) => {
  const hint = "skills";
  const root = getWorkspaceRoot();
  const staged = await skillPack.stageGitClone(root, url, importer.downloadArchive);
  if (!staged.ok) return staged;
  const source = staged.dir || staged.file;
  return await installSkillSource(source, hint);
});

ipcMain.handle("capabilities:install-tool-zip", async () => {
  const hint = "tools";
  const result = await dialog.showOpenDialog({
    title: "Import tool zip (tool.json / index.cjs only)",
    properties: ["openFile"],
    filters: [{ name: "Tool zip", extensions: ["zip"] }],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, error: "cancelled" };
  return await installClassifiedSource(result.filePaths[0], hint);
});

ipcMain.handle("capabilities:install-tool-folder", async () => {
  const hint = "tools";
  const result = await dialog.showOpenDialog({
    title: "Import tool folder (tool.json / index.cjs only)",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, error: "cancelled" };
  return await installClassifiedSource(result.filePaths[0], hint);
});

ipcMain.handle("capabilities:install-tool-git", async (_e, url) => {
  const hint = "tools";
  const root = getWorkspaceRoot();
  const staged = await skillPack.stageGitClone(root, url, importer.downloadArchive);
  if (!staged.ok) return staged;
  const source = staged.dir || staged.file;
  return await installClassifiedSource(source, hint);
});

ipcMain.handle("capabilities:install-agent-zip", async () => {
  const hint = "agents";
  const result = await dialog.showOpenDialog({
    title: "Import agent zip (manifest.json / agent.json only)",
    properties: ["openFile"],
    filters: [{ name: "Agent zip", extensions: ["zip"] }],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, error: "cancelled" };
  return await installClassifiedSource(result.filePaths[0], hint);
});

ipcMain.handle("capabilities:install-agent-folder", async () => {
  const hint = "agents";
  const result = await dialog.showOpenDialog({
    title: "Import agent folder (manifest.json / agent.json only)",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, error: "cancelled" };
  return await installClassifiedSource(result.filePaths[0], hint);
});

ipcMain.handle("capabilities:install-agent-git", async (_e, url) => {
  const hint = "agents";
  const root = getWorkspaceRoot();
  const staged = await skillPack.stageGitClone(root, url, importer.downloadArchive);
  if (!staged.ok) return staged;
  const source = staged.dir || staged.file;
  return await installClassifiedSource(source, hint);
});

ipcMain.handle("capabilities:install-module-zip", async () => {
  const hint = "modules";
  const result = await dialog.showOpenDialog({
    title: "Import module zip (manifest.json / module.json / main.py)",
    properties: ["openFile"],
    filters: [{ name: "Module zip", extensions: ["zip"] }],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, error: "cancelled" };
  return await installClassifiedSource(result.filePaths[0], hint);
});

ipcMain.handle("capabilities:install-module-folder", async () => {
  const hint = "modules";
  const result = await dialog.showOpenDialog({
    title: "Import module folder (manifest.json / module.json / main.py)",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, error: "cancelled" };
  return await installClassifiedSource(result.filePaths[0], hint);
});

ipcMain.handle("capabilities:install-module-git", async (_e, url) => {
  const hint = "modules";
  const root = getWorkspaceRoot();
  const staged = await skillPack.stageGitClone(root, url, importer.downloadArchive);
  if (!staged.ok) return staged;
  const source = staged.dir || staged.file;
  return await installClassifiedSource(source, hint);
});

ipcMain.handle("capabilities:install-plugin-zip", async () => {
  const hint = "plugins";
  const result = await dialog.showOpenDialog({
    title: "Import plugin zip (plugin.json / hooks + index.cjs)",
    properties: ["openFile"],
    filters: [{ name: "Plugin zip", extensions: ["zip"] }],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, error: "cancelled" };
  return await installClassifiedSource(result.filePaths[0], hint);
});

ipcMain.handle("capabilities:install-plugin-folder", async () => {
  const hint = "plugins";
  const result = await dialog.showOpenDialog({
    title: "Import plugin folder (plugin.json / hooks + index.cjs)",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, error: "cancelled" };
  return await installClassifiedSource(result.filePaths[0], hint);
});

ipcMain.handle("capabilities:install-plugin-git", async (_e, url) => {
  const hint = "plugins";
  const root = getWorkspaceRoot();
  const staged = await skillPack.stageGitClone(root, url, importer.downloadArchive);
  if (!staged.ok) return staged;
  const source = staged.dir || staged.file;
  return await installClassifiedSource(source, hint);
});

ipcMain.handle("capabilities:install-workflow-zip", async () => {
  const hint = "workflows";
  const result = await dialog.showOpenDialog({
    title: "Import workflow zip (workflow.json / steps + schedule)",
    properties: ["openFile"],
    filters: [{ name: "Workflow zip", extensions: ["zip"] }],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, error: "cancelled" };
  return await installClassifiedSource(result.filePaths[0], hint);
});

ipcMain.handle("capabilities:install-workflow-folder", async () => {
  const hint = "workflows";
  const result = await dialog.showOpenDialog({
    title: "Import workflow folder (workflow.json / steps + schedule)",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, error: "cancelled" };
  return await installClassifiedSource(result.filePaths[0], hint);
});

ipcMain.handle("capabilities:install-workflow-git", async (_e, url) => {
  const hint = "workflows";
  const root = getWorkspaceRoot();
  const staged = await skillPack.stageGitClone(root, url, importer.downloadArchive);
  if (!staged.ok) return staged;
  const source = staged.dir || staged.file;
  return await installClassifiedSource(source, hint);
});

function safeJson(raw) {
  try {
    const value = JSON.parse(String(raw || ""));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

// ---- External service connectors -----------------------------------------
// Same contract as the cloud model providers: credentials stay in the main
// process, and "connected" is only written after a real authenticated call.
ipcMain.handle("connectors:list", () => connectors.listConnectors(getWorkspaceRoot()));
ipcMain.handle("connectors:connect", async (_e, id, values) => {
  const result = await connectors.connect(getWorkspaceRoot(), String(id || ""), values || {});
  if (result.ok) send("connectors:changed", { id: String(id || ""), connected: true });
  return result;
});
ipcMain.handle("connectors:disconnect", (_e, id) => {
  const result = connectors.disconnect(getWorkspaceRoot(), String(id || ""));
  if (result.ok) send("connectors:changed", { id: String(id || ""), connected: false });
  return result;
});
ipcMain.handle("connectors:verify", async (_e, id) => {
  const result = await connectors.verifyConnector(getWorkspaceRoot(), String(id || ""));
  send("connectors:changed", { id: String(id || ""), connected: Boolean(result.ok) });
  return result;
});
ipcMain.handle("connectors:call", async (_e, id, action, params) =>
  connectors.callConnector(
    getWorkspaceRoot(),
    String(id || ""),
    String(action || ""),
    params || {},
  ),
);
ipcMain.handle("connectors:oauth-start", async (_e, id, values) => {
  const result = await connectors.startOAuth(getWorkspaceRoot(), String(id || ""), values || {});
  if (result.ok) send("connectors:changed", { id: String(id || ""), connected: true });
  return result;
});
ipcMain.handle("connectors:phone-send", async (_e, id, values) => {
  const result = await connectors.startPhoneVerify(
    getWorkspaceRoot(),
    String(id || ""),
    values || {},
  );
  send("connectors:changed", { id: String(id || ""), connected: false });
  return result;
});
ipcMain.handle("connectors:phone-confirm", async (_e, id, values) => {
  const result = await connectors.confirmPhone(getWorkspaceRoot(), String(id || ""), values || {});
  send("connectors:changed", { id: String(id || ""), connected: Boolean(result.ok) });
  return result;
});

// ---- Startup orchestration (scan → services → verify → readiness) ----------
// One canonical flow, run at boot and re-runnable from the UI. `lastStartup`
// is the single source of truth every screen reads, so a rerun keeps the whole
// app synchronized.
let lastStartup = null;
let startupJob = null;

function startupContext() {
  return {
    workspaceRoot: getWorkspaceRoot(),
    boot,
    log,
    listCapabilities: () => capabilityIndex.list(capabilityRoots()),
    engineStatus: () => modelsApi.engineStatus(),
    startEngine: (id) => modelsApi.startEngine(id),
    kernelAlive: () => waitForKernel(15000),
    routableModels: async () => (await refreshRoutable(true)).models.length,
  };
}

function runStartup() {
  // Never two passes at once — a second caller joins the running one.
  if (startupJob) return startupJob;
  startupJob = startupFlow
    .runStartupFlow(startupContext())
    .then((report) => {
      lastStartup = report;
      send("startup:state", report);
      // Models the flow just brought online must reach the kernel too.
      if (report.modelsAvailable) void syncKernelModels(true);
      return report;
    })
    .catch((error) => {
      const failed = {
        at: Date.now(),
        ready: false,
        state: "blocked",
        blockers: [String(error?.message || error)],
        warnings: [],
        services: [],
      };
      lastStartup = failed;
      send("startup:state", failed);
      return failed;
    })
    .finally(() => {
      startupJob = null;
    });
  return startupJob;
}

ipcMain.handle("startup:state", () => lastStartup);
ipcMain.handle("startup:run", () => runStartup());

// ---- FRIDAY's own skills ----------------------------------------------------
ipcMain.handle("skills:list", () => fridaySkills.list(capabilityRoots()));
ipcMain.handle("skills:read", (_e, id) => fridaySkills.read(capabilityRoots(), id));
ipcMain.handle("skills:write", (_e, skill) => fridaySkills.write(getWorkspaceRoot(), skill || {}));
ipcMain.handle("skills:remove", (_e, id) => fridaySkills.remove(getWorkspaceRoot(), id));
ipcMain.handle("skills:rollback", (_e, id) => fridaySkills.rollback(getWorkspaceRoot(), id));
ipcMain.handle("skills:set-enabled", (_e, id, enabled) =>
  fridaySkills.setEnabled(capabilityRoots(), id, enabled),
);
ipcMain.handle("skills:verify", (_e, candidate) =>
  fridaySkills.verifyCandidate(getWorkspaceRoot(), candidate || {}),
);
ipcMain.handle("skills:invoke", async (_e, id, input, options) => {
  const skillId = String(id || "");
  const args = input && typeof input === "object" ? input : {};
  const listed = fridaySkills.list(capabilityRoots());
  const skill = (listed.skills || []).find((entry) => entry.id === skillId);
  const risk =
    skill?.risk === "safe" || skill?.risk === "write" || skill?.risk === "exec"
      ? skill.risk
      : "exec";
  {
    let decision = applyOwnerPermissionOverlay(
      skillId,
      risk,
      toolAuthority.decide(skillId, risk, toolPolicy()),
    );
    if (decision === "deny")
      return {
        ok: false,
        error: `“${skillId}” is blocked by your permission settings.`,
        denied: true,
        risk,
      };
    if (decision === "ask") {
      const answer = await askOwnerForTool(skillId, risk, args);
      persistToolDecision(skillId, risk, answer.granted, answer.remember);
      if (!answer.granted)
        return { ok: false, error: `You denied “${skillId}”.`, denied: true, risk };
    }
  }
  return fridaySkills.invoke(capabilityRoots(), skillId, args, {
    allowDisabled: Boolean(options && options.allowDisabled),
  });
});

ipcMain.handle("toolpacks:list", () => fridayTools.list(capabilityRoots()));
ipcMain.handle("toolpacks:write", (_e, pack) => fridayTools.write(getWorkspaceRoot(), pack || {}));
ipcMain.handle("toolpacks:verify", (_e, candidate) =>
  fridayTools.verifyCandidate(getWorkspaceRoot(), candidate || {}),
);
ipcMain.handle("toolpacks:invoke", async (_e, id, input, options) => {
  const toolId = String(id || "");
  const args = input && typeof input === "object" ? input : {};
  const listed = fridayTools.list(capabilityRoots());
  const tool = (listed.tools || []).find(
    (entry) => entry.id === toolId || String(entry.id).endsWith(`/${toolId}`),
  );
  const risk =
    tool?.risk === "safe" || tool?.risk === "write" || tool?.risk === "exec" ? tool.risk : "exec";
  {
    let decision = applyOwnerPermissionOverlay(
      toolId,
      risk,
      toolAuthority.decide(toolId, risk, toolPolicy()),
    );
    if (decision === "deny")
      return {
        ok: false,
        error: `“${toolId}” is blocked by your permission settings.`,
        denied: true,
        risk,
      };
    if (decision === "ask") {
      const answer = await askOwnerForTool(toolId, risk, args);
      persistToolDecision(toolId, risk, answer.granted, answer.remember);
      if (!answer.granted)
        return { ok: false, error: `You denied “${toolId}”.`, denied: true, risk };
    }
  }
  return fridayTools.invoke(capabilityRoots(), toolId, args, {
    allowDisabled: Boolean(options && options.allowDisabled),
  });
});

ipcMain.handle("agents:list", () => fridayAgents.list(capabilityRoots()));
ipcMain.handle("agents:plan", (_e, id, input, options) =>
  fridayAgents.plan(
    capabilityRoots(),
    String(id || ""),
    input && typeof input === "object" ? input : {},
    {
      allowDisabled: Boolean(options && options.allowDisabled),
    },
  ),
);
ipcMain.handle("agents:run", (_e, id, input, options) =>
  fridayAgents.run(
    capabilityRoots(),
    String(id || ""),
    input && typeof input === "object" ? input : {},
    {
      allowDisabled: Boolean(options && options.allowDisabled),
    },
  ),
);
ipcMain.handle("modules:list", () => fridayModules.list(capabilityRoots()));
ipcMain.handle("modules:invoke", async (_e, id, input, options) => {
  const moduleId = String(id || "");
  const args = input && typeof input === "object" ? input : {};
  const listed = fridayModules.list(capabilityRoots());
  const pack = (listed.modules || []).find(
    (entry) => entry.id === moduleId || String(entry.id).endsWith(`/${moduleId}`),
  );
  const risk =
    pack?.risk === "safe" || pack?.risk === "write" || pack?.risk === "exec" ? pack.risk : "exec";
  {
    let decision = applyOwnerPermissionOverlay(
      moduleId,
      risk,
      toolAuthority.decide(moduleId, risk, toolPolicy()),
    );
    if (decision === "deny")
      return {
        ok: false,
        error: `“${moduleId}” is blocked by your permission settings.`,
        denied: true,
        risk,
      };
    if (decision === "ask") {
      const answer = await askOwnerForTool(moduleId, risk, args);
      persistToolDecision(moduleId, risk, answer.granted, answer.remember);
      if (!answer.granted)
        return { ok: false, error: `You denied “${moduleId}”.`, denied: true, risk };
    }
  }
  return fridayModules.invoke(capabilityRoots(), moduleId, args, {
    allowDisabled: Boolean(options && options.allowDisabled),
  });
});

// ---- Sandbox ----------------------------------------------------------------
ipcMain.handle("sandbox:run", (_e, options) =>
  sandbox.runIsolated({ ...(options || {}), root: getWorkspaceRoot() }),
);

// ---- Sandbox Lab -------------------------------------------------------------
// A real isolated dev/test runtime under <workspace>/sandbox. Nothing here can
// touch the production FRIDAY source without an explicit approved apply.
const sandboxLab = require("./sandbox-lab.cjs");

const labRoot = () => getWorkspaceRoot();
const labSource = () => buildRunner.sourceRoot(buildContext());

ipcMain.handle("sandbox-lab:summary", () => sandboxLab.summary(labRoot(), labSource()));
ipcMain.handle("sandbox-lab:detect", () => sandboxLab.detectRuntime());
ipcMain.handle("sandbox-lab:install-runtime", (_e, id) =>
  sandboxLab.installRuntime(String(id || ""), (event) => send("sandbox-lab:runtime", event)),
);
ipcMain.handle("sandbox-lab:create", (_e, options) =>
  sandboxLab.createProject(labRoot(), { ...(options || {}), sourceRoot: labSource() }),
);
ipcMain.handle("sandbox-lab:remove", (_e, id, keepFiles) =>
  sandboxLab.removeProject(labRoot(), String(id || ""), { keepFiles: Boolean(keepFiles) }),
);
ipcMain.handle("sandbox-lab:files", (_e, id) => sandboxLab.listFiles(labRoot(), String(id || "")));
ipcMain.handle("sandbox-lab:plan-checks", (_e, id) =>
  sandboxLab.planProjectChecks(labRoot(), String(id || "")),
);
ipcMain.handle("sandbox-lab:read", (_e, id, file) =>
  sandboxLab.readFile(labRoot(), String(id || ""), String(file || "")),
);
ipcMain.handle("sandbox-lab:write", (_e, id, file, content) =>
  sandboxLab.writeFile(labRoot(), String(id || ""), String(file || ""), content),
);
ipcMain.handle("sandbox-lab:delete", (_e, id, file) =>
  sandboxLab.deleteFile(labRoot(), String(id || ""), String(file || "")),
);
ipcMain.handle("sandbox-lab:import-folder", async (_e, id) => {
  const result = await dialog.showOpenDialog(liveWin(), {
    title: "Import a folder into the sandbox project",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
  return sandboxLab.importFolder(labRoot(), { id: String(id || ""), folder: result.filePaths[0] });
});
ipcMain.handle("sandbox-lab:exec", (_e, options) =>
  sandboxLab.runCommand(labRoot(), options || {}, (event) => send("sandbox-lab:output", event)),
);
// Sandbox isolation engines — detect, install from open-source sources and
// choose which one a project runs under.
ipcMain.handle("sandbox-lab:engines", () => sandboxLab.detectEngines());
ipcMain.handle("sandbox-lab:install-engine", async (_e, id) => {
  const engineId = String(id || "");
  const result = await sandboxLab.installEngine(engineId, (event) =>
    send("sandbox-lab:runtime", event),
  );
  // A Windows-feature engine (WSL, Windows Sandbox) only finishes after a
  // Windows restart. Route that through the one authoritative restart notice
  // so it survives navigation, exactly like the phone-companion toggle does.
  if (result?.ok && result.restartRequired)
    noteRestartRequired(`${engineId} installed - restart Windows to finish enabling it`);
  return result;
});

// "Installed but not running" is repairable: really start the daemon
// (Docker Desktop, the Podman machine) and wait for its own ready probe.
ipcMain.handle("sandbox-lab:start-engine", (_e, id) =>
  sandboxLab.startEngineService(String(id || ""), (event) => send("sandbox-lab:runtime", event)),
);

ipcMain.handle("sandbox-lab:set-engine", (_e, id, engine) =>
  sandboxLab.setProjectEngine(labRoot(), String(id || ""), String(engine || "process")),
);
ipcMain.handle("sandbox-lab:launch-engine", (_e, id, dir) =>
  sandboxLab.launchEngine(String(id || ""), { dir: dir ? String(dir) : undefined }),
);
ipcMain.handle("sandbox-lab:cancel", (_e, runId) => sandboxLab.cancelRun(String(runId || "")));

// ---- real workspace terminal (replaces the old simulated shell) ----------
const terminal = require("./terminal.cjs");
/** The FRIDAY venv interpreter, so `python` runs in FRIDAY's own environment. */
async function terminalPython() {
  try {
    const found = await require("./python.cjs").resolvePython(null);
    return found?.executable || null;
  } catch {
    return null;
  }
}
ipcMain.handle("terminal:exec", async (_e, options) =>
  terminal.runCommand(
    getWorkspaceRoot(),
    { ...(options || {}), python: await terminalPython() },
    (event) => send("terminal:output", event),
  ),
);
ipcMain.handle("terminal:cancel", (_e, runId) => terminal.cancelRun(String(runId || "")));
ipcMain.handle("terminal:write", (_e, runId, data) =>
  terminal.writeStdin(String(runId || ""), String(data ?? "")),
);
ipcMain.handle("terminal:runs", () => terminal.listRuns());
ipcMain.handle("terminal:shells", async () =>
  terminal.listShells({ root: getWorkspaceRoot(), python: await terminalPython() }),
);
ipcMain.handle("terminal:cd", (_e, cwd, target) =>
  terminal.resolveCd(getWorkspaceRoot(), String(cwd || ""), String(target || "")),
);
ipcMain.handle("terminal:cwd", () => ({ root: getWorkspaceRoot() }));

ipcMain.handle("sandbox-lab:log", (_e, id) => sandboxLab.readLog(labRoot(), String(id || "")));
ipcMain.handle("sandbox-lab:diff", (_e, id) =>
  sandboxLab.diffToSource(labRoot(), String(id || ""), labSource()),
);
ipcMain.handle("sandbox-lab:apply", (_e, options) =>
  sandboxLab.applyAndVerify(
    labRoot(),
    { ...(options || {}), sourceRoot: labSource() },
    (progress) => send("sandbox-lab:apply-progress", progress),
  ),
);
ipcMain.handle("sandbox-lab:rollback", (_e, applyId) =>
  sandboxLab.rollbackApply(labRoot(), String(applyId || "")),
);
ipcMain.handle("sandbox-lab:reveal", (_e, target) => {
  const base = sandboxLab.paths(labRoot() || app.getPath("documents")).base;
  const full =
    target && path.isAbsolute(String(target))
      ? String(target)
      : path.join(base, String(target || ""));
  shell.showItemInFolder(full);
  return { ok: true, path: full };
});
ipcMain.handle("sandbox-lab:config", (_e, patch) =>
  patch ? sandboxLab.setConfig(labRoot(), patch) : sandboxLab.config(labRoot()),
);

// ---- Identity ---------------------------------------------------------------
// The compiled persona + rule book is mirrored to disk so the Python kernel
// injects the exact same identity as the renderer, for every model.
ipcMain.handle("identity:write", (_e, prompt) => {
  const root = getWorkspaceRoot();
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };
  try {
    const dir = path.join(root, "brain-data", "personality");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "identity.txt"), String(prompt || ""), "utf8");
    return { ok: true, file: path.join(dir, "identity.txt") };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
});

// ---- Environment / dependency registry -------------------------------------
// Same module the setup scripts and the readiness test use, so the desktop app
// and the browser build always report identical component health.
ipcMain.handle("env:registry", () => envRegistry.readRegistry());
ipcMain.handle("env:refresh", async () => {
  // Probing spawns real processes; keep it off the UI thread's critical path.
  await Promise.resolve();
  return envRegistry.refreshRegistry();
});
ipcMain.handle("env:repair", async (_e, id) => {
  await Promise.resolve();
  const result = id ? envRegistry.repairComponent(String(id)) : envRegistry.repairAll();
  send("env:repaired", result);
  return result;
});
ipcMain.handle("env:readiness", () =>
  runReadiness({
    win: liveWin(),
    waitForKernel,
    kernelUrl: `http://${KERNEL_HOST}:${KERNEL_PORT}`,
    kernelRequest,
    getWorkspaceRoot,
  }),
);

// ---- Lifecycle -------------------------------------------------------------
app
  .whenReady()
  .then(async () => {
    log(`FRIDAY ${productVersion()} starting · packaged=${app.isPackaged}`);
    // Voice needs the microphone. Electron denies every permission request by
    // default when no handler is installed, which is what made the renderer's
    // getUserMedia report "Microphone unavailable" even with Windows itself
    // allowing it. Only "media" is granted here — screen capture runs in the
    // main process through desktopCapturer and never asks the session, so
    // "display-capture" deliberately stays denied. FRIDAY's embedded browser
    // keeps its own stricter handler on its own session (browser-live.cjs).
    try {
      session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
        if (permission === "media") {
          callback(true);
          return;
        }
        callback(false);
      });
      session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === "media");
      log("session permissions: microphone/camera allowed, everything else denied");
    } catch (err) {
      log(`permission handler install failed: ${String(err?.message || err)}`);
    }

    const bootStartedAt = Date.now();
    boot("Detecting installation", "ok", path.dirname(app.getPath("exe")));
    // Setup writes HKCU WorkspacePath. Resolve that pointer BEFORE the window
    // exists so the first workspace:get / first-run:state IPC sees the real
    // root — otherwise a fresh install races into the folder-picker while
    // registry lookup is still in flight, and first-run.json can land in the
    // userData fallback.
    const root = await resolveWorkspaceRoot();
    // A folder that was moved or restored from a backup may be missing parts of
    // the canonical layout; recreate only what is absent, never overwrite.
    // ensureStructure repairs the layout INSIDE the root only; the storage
    // manager then records which models/voices/runtime/character resources are
    // already present (so nothing is downloaded twice) and clears stale
    // installer/update temporaries. User data is never touched.
    if (root) {
      const storage = storageManager.prepare(root, { version: productVersion() });
      if (storage) {
        boot(
          "Checking storage",
          "ok",
          `${storage.reusable.length} resources reused` +
            (storage.cleaned.removed.length
              ? `, ${storage.cleaned.removed.length} temporary items cleaned`
              : ""),
        );
      }
    }
    // Deterministic order: canonical paths → config → root descriptors, all
    // validated in-process BEFORE the kernel or any other subsystem reads them.
    if (root) {
      const config = ensureCanonicalConfig(root);
      ensureRootFiles(root, { version: productVersion() });
      boot(
        "Loading configuration",
        "ok",
        config.repaired.length
          ? `repaired ${config.repaired.join(", ")}`
          : path.join(root, "config"),
      );
    }
    // Screen-vision state follows the chosen folder like everything else.
    screenVision.setRoot(root);
    camera.setRoot(root);

    try {
      createWindow();
    } catch (err) {
      log(`window creation failed: ${err?.stack || err}`);
      dialog.showErrorBox("FRIDAY failed to start", String(err?.stack || err));
      return;
    }

    // FRIDAY lives in the tray: closing the window only hides it, so there is
    // always a visible way back in and one explicit way out.
    tray.init({
      iconPath: appIconPath(),
      log,
      onOpen: () => showFridayWindow(),
      onQuit: () => quitFriday(),
      onPauseToggle: (paused) => {
        tray.setState({ paused });
        // The renderer owns the microphone; it really stops/starts it and then
        // reports the resulting state back through voice:state.
        send("voice:pause", { paused });
      },
    });

    liveBrowser.init({ send, workspaceRoot: getWorkspaceRoot });

    // Watch every capability tree so a newly dropped agent/skill/tool/plugin
    // manifest appears in the UI without a restart.
    stopCapabilityWatch?.();
    stopCapabilityWatch = capabilityIndex.watch(capabilityRoots(), (info) =>
      send("capabilities:changed", info),
    );

    // Start the kernel before scans and runtime detection. Those jobs may take
    // seconds on a large workspace, but chat and navigation must be ready now.
    await startKernel(root);
    // startKernel already recorded a warn when spawn/config failed. Do not
    // overwrite that with "ok" — the boot list is what the owner sees.
    if (kernel) {
      boot("Starting services", "ok", `kernel on ${KERNEL_HOST}:${KERNEL_PORT}`);
    }
    startModelRegistryRefresh();

    // Workspace plugins activate in the background so they can never slow down
    // or block the first paint, but the order is deterministic: plugins are
    // always loaded before the startup flow evaluates readiness, and a failing
    // plugin is reported by name instead of silently degrading FRIDAY.
    const pluginsLoaded = root
      ? plugins
          .loadEnabled(capabilityRoots(), pluginServices)
          .then((results) => {
            const failed = results.filter((r) => !r.ok);
            boot(
              "Activating plugins",
              !results.length ? "ok" : failed.length ? "warn" : "ok",
              results.length
                ? `${results.length - failed.length}/${results.length} loaded${
                    failed.length ? ` · failed: ${failed.map((f) => f.id).join(", ")}` : ""
                  }`
                : "none enabled",
            );
            return results;
          })
          .catch((error) => {
            boot("Activating plugins", "warn", String(error?.message || error));
            return [];
          })
          .then((results) => {
            void plugins
              .dispatch(
                capabilityRoots(),
                "on-app-start",
                { at: Date.now() },
                { services: pluginServices },
              )
              .catch((error) => log(`plugin on-app-start failed: ${error?.message || error}`));
            return results;
          })
      : Promise.resolve([]);

    if (root) {
      const verified = verifyWorkspace(root);
      boot(
        "Detecting workspace",
        verified.exists ? "ok" : "missing",
        verified.exists ? root : "No workspace configured",
      );
      if (verified.exists) {
        ensureRootFiles(root, { version: productVersion() });
        boot("Reading workspace.json", "ok");
        // Rebuild the root's own indexes: every component is re-validated
        // against disk, so nothing counts as installed just because a folder
        // exists. Off the first paint — never blocks the window.
        setImmediate(() => {
          void rebuildRootIndexes(root, { ms: Date.now() - bootStartedAt }).then((result) => {
            if (!result) return boot("Rebuilding registry", "warn", "registry not written");
            const { totals } = result.registry;
            boot(
              "Rebuilding registry",
              totals.invalid ? "warn" : "ok",
              `${totals.registered}/${totals.components} components validated`,
            );
          });
        });
        boot("Scanning folders", "ok", "running in background");

        void rescan(root)
          .then((scan) => {
            // The canonical config was already validated before the kernel
            // started; this step only reports the extra files the scan found.
            boot(
              "Reading workspace config files",
              scan?.settingsFiles?.length ? "ok" : "warn",
              `${scan?.settingsFiles?.length ?? 0} file(s)`,
            );
            boot("Loading plugins", "ok", `${scan?.plugins?.length ?? 0} found`);
            boot("Loading modules", "ok", `${scan?.modules?.length ?? 0} found`);
            boot("Loading agents", "ok", `${scan?.agents?.length ?? 0} found`);
            boot("Loading skills", "ok", `${scan?.skills?.length ?? 0} found`);
            boot("Loading workflows", "ok", `${scan?.workflows?.length ?? 0} found`);
          })
          .catch((error) => boot("Scanning folders", "warn", error.message));
        startWatching(root);
        initSelfMaintenance(root);
        boot("Watching for changes", "ok");
      }
    } else {
      boot("Detecting workspace", "missing", "Choose your FRIDAY folder to continue");
    }

    detectComponents()
      .then((components) => {
        lastComponents = { detectedAt: Date.now(), components };
        const missing = components.filter((c) => c.required && !c.installed).map((c) => c.name);
        boot("Detecting runtimes", missing.length ? "warn" : "ok", missing.join(", "));
      })
      .catch(() => boot("Detecting runtimes", "warn"));

    detectProviders({ keyStore: keyStoreRoot() })
      .then((result) => {
        lastProviders = result;
        send("providers:detected", result);
        const online = result.providers.filter((p) => p.status === "online").map((p) => p.name);
        boot(
          "Detecting AI providers",
          online.length ? "ok" : "warn",
          online.join(", ") || "none online",
        );
      })
      .catch(() => boot("Detecting AI providers", "warn"));

    detectHardware()
      .then((hw) => {
        lastHardware = hw;
        boot(
          "Checking acceleration",
          "ok",
          `${hw.plan.backend.toUpperCase()} · ${hw.cpu.cores} cores · ${hw.plan.reason}`,
        );
      })
      .catch(() => boot("Checking acceleration", "warn"));

    // The full startup flow runs after the window is interactive and after
    // plugins have registered their capabilities: scan → persistent state →
    // auto-start services → verify → readiness. It never blocks first paint,
    // and its result is broadcast to every screen.
    void pluginsLoaded.finally(() => setTimeout(() => void runStartup(), 400));

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showFridayWindow();
    });
  })
  .catch((err) => {
    // The window is already on screen at this point; the failure is reported
    // there and in the log instead of killing the process silently.
    log(`startup sequence failed: ${err?.stack || err}`);
    boot("Starting services", "warn", String(err?.message || err));
  });

app.on("second-instance", () => {
  showFridayWindow();
});

app.on("window-all-closed", () => {
  // The window is hidden, not destroyed, in normal use — this only fires when
  // FRIDAY is really shutting down. Everything is torn down by before-quit.
  if (app.__fridayQuitting || process.platform === "darwin") return;
  stopOwnedProcesses();
  app.quit();
});

app.on("before-quit", () => {
  app.__fridayQuitting = true;
  try {
    void plugins.dispatch(
      capabilityRoots(),
      "on-app-quit",
      { at: Date.now() },
      { services: pluginServices },
    );
  } catch {
    /* quitting must not wait on a plugin */
  }
  tray.destroy();
  character.dispose();
  systemMonitor.stop();
  serviceHealth.stop();
  stopModelRegistryRefresh();
  stopOwnedProcesses();
  void liveBrowser.shutdown();
});
