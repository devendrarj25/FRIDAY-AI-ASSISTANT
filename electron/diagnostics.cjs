/**
 * FRIDAY diagnostics (main process only).
 *
 * Every check below inspects the real machine or the real project — nothing is
 * assumed healthy. Checks are grouped so the Doctor UI can render them without
 * knowing anything about the underlying probes.
 *
 * Statuses: Ready | Running | Missing | Outdated | Error | Warning | Repairing
 */
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { execFile } = require("child_process");

const { detectTools, run, which, ping, pool } = require("./toolchain.cjs");
const project = require("./project.cjs");
const { resolvePython } = require("./python.cjs");

const WIN = process.platform === "win32";

/**
 * Numbered owner steps after the kernel auto-restart (0 / 2s / 8s, cap 3)
 * has given up. Same list the Doctor panel shows for the kernel check.
 */
function kernelOwnerSteps() {
  return [
    "FRIDAY already tried to restart the local AI service three times (immediately, then after 2 seconds, then after 8 seconds) and it still did not come back.",
    "Open Setup & Doctor and use Repair on “Python kernel bridge”. That reinstalls missing kernel Python packages, then starts the service again.",
    "If Repair still fails, open Logs and read the Python error. Typical causes: Python is missing, kernel requirements could not install, or port 8765 is blocked.",
    "If this is a packaged install, run the FRIDAY Setup EXE again over the same folder (Repair) — that restores kernel files without touching your data.",
    "When the kernel is listening again, FRIDAY recovers on her own. She does not keep restarting in a tight loop after three failures.",
  ];
}

const check = (o) => ({
  fixable: false,
  group: "System",
  cause: null,
  fix: null,
  command: null,
  docs: null,
  ...o,
});

/** A paid/cloud key the provider refused — FRIDAY must not rotate or invent one. */
const REJECTED_KEY = /rejected|401|403|invalid.?key|incorrect api key|unauthorized/i;

function keyRejected(error) {
  return REJECTED_KEY.test(String(error || ""));
}

const exists = (p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};

const readJson = (p) => {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(p, "utf8")) };
  } catch (err) {
    return { ok: false, error: String(err.message) };
  }
};

function portOpen(port, host = "127.0.0.1", timeout = 700) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

async function processCount(namePattern) {
  if (WIN) {
    const out = await run("tasklist", ["/fo", "csv", "/nh"], 8000);
    if (!out) return null;
    return out.split(/\r?\n/).filter((l) => namePattern.test(l)).length;
  }
  const out = await run("ps", ["-eo", "comm"], 6000);
  if (!out) return null;
  return out.split(/\r?\n/).filter((l) => namePattern.test(l)).length;
}

/* ------------------------------------------------------------------ checks */

async function runDiagnostics(ctx = {}, { deep = false } = {}) {
  const {
    root = null,
    userData = os.tmpdir(),
    install = process.cwd(),
    appVersion = "0.0.0",
    kernelPort = 8765,
    kernelRunning = false,
    logPath = null,
    packaged = false,
  } = ctx;

  // The manifest, node_modules and the component registries live in the real
  // project root, which is NOT `resources/` in a packaged build.
  const projectRoot = project.resolveProjectRoot({ ...ctx, install });

  const checks = [];
  const started = Date.now();

  // --- FRIDAY core / runtime ------------------------------------------------
  checks.push(
    check({
      id: "friday-core",
      label: "FRIDAY core runtime",
      group: "FRIDAY",
      status: "Running",
      detail: `v${appVersion} · ${process.platform} ${os.release()} · pid ${process.pid}`,
    }),
    check({
      id: "electron",
      label: "Electron / Node.js / Chromium",
      group: "FRIDAY",
      status: "Ready",
      detail: `Electron ${process.versions.electron || "n/a"} · Node ${process.versions.node} · Chromium ${process.versions.chrome || "n/a"}`,
    }),
  );

  // --- packaged app files ---------------------------------------------------
  // Each file is searched across the project root, resources/ and the
  // workspace, so a packaged layout does not look like a broken install.
  const appFiles = [
    "package.json",
    "kernel/main.py",
    "config/kernel.yaml",
    "config/models.yaml",
  ].map((rel) => [rel, project.locate(rel.split("/").join(path.sep), { ...ctx, install })]);
  const missingFiles = appFiles.filter(([, p]) => !p).map(([n]) => n);

  checks.push(
    check({
      id: "app-files",
      label: "Application files",
      group: "FRIDAY",
      status: missingFiles.length ? "Warning" : "Ready",
      detail: missingFiles.length
        ? `missing: ${missingFiles.join(", ")}`
        : `${appFiles.length} core files present · project root ${projectRoot}`,
      cause: missingFiles.length ? "Files were not copied by the installer or were deleted." : null,
      fix: missingFiles.length ? "Reinstall FRIDAY with the latest Setup executable." : null,
    }),
  );

  // --- toolchain / dependency versions -------------------------------------
  const { tools } = await detectTools({ force: deep });
  const byId = new Map(tools.map((t) => [t.id, t]));
  const need = ["Node.js LTS", "npm", "Python", "pip", "Git", "SQLite", "PowerShell 7", "Ollama"];
  checks.push(ocrDoctorRow(byId.get("Tesseract OCR") || null));

  need.forEach((id) => {
    const t = byId.get(id);
    if (!t) return;
    checks.push(
      check({
        id: `tool-${id}`,
        label: id,
        group: "Runtimes",
        status:
          t.status === "Running"
            ? "Running"
            : t.installed
              ? "Ready"
              : t.required
                ? "Missing"
                : "Warning",
        detail: t.installed ? `${t.version || "installed"} · ${t.path || ""}` : "not found on PATH",
        cause: t.installed ? null : `${id} is not installed or not on PATH.`,
        fix: t.installed ? null : `Install ${id} from Install Manager (source: ${t.source}).`,
        docs: t.url,
      }),
    );
  });

  // TypeScript / React / Vite come from the project manifest, not guesses.
  const manifestPath = project.locate("package.json", { ...ctx, install });
  const pkg = manifestPath
    ? readJson(manifestPath)
    : { ok: false, error: "package.json not found" };
  // In a packaged build the dependencies are bundled into the application
  // archive, so an absent node_modules/ is normal and must not read as broken.
  const bundled =
    packaged ||
    /app\.asar(?:$|[\\/])/.test(projectRoot) ||
    !exists(path.join(projectRoot, "node_modules"));
  if (pkg.ok) {
    const deps = { ...(pkg.value.dependencies || {}), ...(pkg.value.devDependencies || {}) };
    ["react", "vite", "typescript", "electron"].forEach((name) => {
      const declared = deps[name];
      const installedPkg = readJson(path.join(projectRoot, "node_modules", name, "package.json"));
      const present = installedPkg.ok;
      // Packaging rewrites package.json without devDependencies, so vite,
      // typescript and electron legitimately disappear from the shipped
      // manifest — that is normal, not a broken installation.
      const ok = declared ? present || bundled : bundled;
      checks.push(
        check({
          id: `dep-${name}`,
          label: `${name} dependency`,
          group: "Dependencies",
          status: ok ? "Ready" : declared ? "Missing" : "Warning",
          detail: present
            ? `${installedPkg.value.version} installed${declared ? ` · requires ${declared}` : ""}`
            : bundled
              ? "bundled in the application package"
              : declared
                ? `declared ${declared} — not found in node_modules`
                : "not declared in package.json",
          cause: ok ? null : "Dependencies were never installed or were pruned.",
          fix: ok ? null : "Run a dependency install in the project folder.",
          command: ok ? null : "npm install",
        }),
      );
    });
  } else {
    checks.push(
      check({
        id: "dep-manifest",
        label: "package.json",
        group: "Dependencies",
        status: "Error",
        detail: `${pkg.error} · searched: ${project
          .projectRootCandidates({ ...ctx, install })
          .join(", ")}`,
        cause: "The project manifest could not be found in the project root.",
        fix: "Reinstall FRIDAY, or set FRIDAY_PROJECT_ROOT to the folder that contains package.json.",
      }),
    );
  }

  // --- hardware -------------------------------------------------------------
  const { detectHardware } = require("./hardware.cjs");
  const hw = await detectHardware();
  const ramWarn = hw.memory.totalGb < 8;
  checks.push(
    check({
      id: "cpu",
      label: "CPU",
      group: "Hardware",
      status: hw.cpu.cores >= 4 ? "Ready" : "Warning",
      detail: `${hw.cpu.model} · ${hw.cpu.cores} threads`,
      cause: hw.cpu.cores >= 4 ? null : "Fewer than 4 threads — local models will be slow.",
      fix:
        hw.cpu.cores >= 4
          ? null
          : "Use smaller local models, or a cloud provider, on this machine.",
      steps:
        hw.cpu.cores >= 4
          ? undefined
          : [
              "FRIDAY cannot add CPU cores. This PC will stay slow for large local models.",
              "In Models, pick a small local model (about 3B or less) or a cloud provider whose key already answers.",
              "Close other heavy apps while a local model is loaded.",
              "Re-run Setup & Doctor. The CPU warning is information, not a driver FRIDAY can install.",
            ],
    }),
    check({
      id: "ram",
      label: "System memory",
      group: "Hardware",
      status: ramWarn ? "Warning" : "Ready",
      detail: `${hw.memory.totalGb} GB total · ${hw.memory.freeGb} GB free`,
      cause: ramWarn ? "Less than 8 GB RAM — only small models will load." : null,
      fix: ramWarn ? "Close other apps, or use a cloud model instead of a large local one." : null,
      steps: ramWarn
        ? [
            "FRIDAY cannot install RAM. This machine is below 8 GB, so large local models will fail or thrash.",
            "Close browsers, games and other memory-heavy apps, then rescan.",
            "In Models, use a small local model or a connected cloud provider.",
            "Adding physical RAM is a hardware step only you can do.",
          ]
        : undefined,
    }),
    check({
      id: "gpu",
      label: "GPU / VRAM",
      group: "Hardware",
      status: hw.plan.backend === "gpu" ? "Ready" : hw.gpus.length ? "Warning" : "Missing",
      detail: hw.gpus.length
        ? `${hw.gpus[0].name} · ${hw.gpus[0].vramTotalMb ?? "?"} MB VRAM · plan ${hw.plan.backend.toUpperCase()}`
        : "no discrete GPU detected — CPU inference",
      cause: hw.plan.backend === "gpu" ? null : hw.plan.reason,
      fix:
        hw.plan.backend === "gpu"
          ? null
          : "Install the latest GPU driver and the CUDA Toolkit, then rescan.",
      command: "nvidia-smi",
      steps:
        hw.plan.backend === "gpu"
          ? undefined
          : [
              "FRIDAY cannot install a GPU driver or grant herself hardware access — that is a Windows / vendor step.",
              "If this PC has an NVIDIA GPU: download the current Game Ready or Studio driver from NVIDIA, install it, then reboot Windows.",
              "For CUDA local models, install the CUDA Toolkit that matches that driver from developer.nvidia.com/cuda-downloads, then reboot again.",
              "Open a new terminal and run nvidia-smi — it must print the driver version, CUDA version and VRAM. If it is not recognised, the driver is not actually installed.",
              "Open Setup & Doctor and run a scan. FRIDAY re-reads nvidia-smi; she will never claim a GPU she cannot see.",
            ],
    }),
  );

  // --- AI providers & models -----------------------------------------------
  const { detectProviders } = require("./providers.cjs");
  const { engineStatus } = require("./models.cjs");
  const providers = await detectProviders({ keyStore: require("./friday-paths.cjs").base() });
  const list = Array.isArray(providers) ? providers : providers?.providers || [];
  const engines = await engineStatus();
  const runningEngines = engines.filter((e) => e.running);
  const startableEngines = engines.filter((e) => e.canStart && !e.running);
  const blockedEngines = engines.filter((e) => !e.running && !e.canStart);
  const models = list.reduce((n, p) => n + (p.models?.length || 0), 0);
  const providerDetail = runningEngines.length
    ? `${runningEngines.map((p) => p.name).join(", ")} online`
    : startableEngines.length
      ? `installed but not serving: ${startableEngines.map((e) => e.name).join(", ")}`
      : blockedEngines.length
        ? blockedEngines.map((e) => `${e.name}: ${e.hint}`).join(" · ")
        : "no local provider is currently serving";
  checks.push(
    check({
      id: "providers",
      label: "AI providers",
      group: "AI",
      status: runningEngines.length ? "Running" : startableEngines.length ? "Warning" : "Missing",
      detail: providerDetail,
      cause: runningEngines.length ? null : "No local AI runtime is running.",
      fix: runningEngines.length
        ? null
        : startableEngines.length
          ? `Start ${startableEngines.map((e) => e.name).join(", ")} from Doctor (same startEngine path as boot).`
          : blockedEngines[0]?.hint || "Install a local engine from Install Manager.",
      command: startableEngines[0] ? String(startableEngines[0].id) : null,
      fixable: startableEngines.length > 0,
    }),
    check({
      id: "models",
      label: "Local models",
      group: "AI",
      status: models > 0 ? "Ready" : "Missing",
      detail: models > 0 ? `${models} model(s) detected` : "no local models pulled",
      cause: models > 0 ? null : "FRIDAY has no local model to answer with.",
      fix: models > 0 ? null : "Pull a model from the Models page.",
      command: "ollama pull qwen2.5:7b",
      steps:
        models > 0
          ? undefined
          : [
              "FRIDAY will not invent a local model. One has to be pulled on this PC.",
              "Install a local engine from Install Manager if it is missing, then start it (Doctor starts any engine that `engineStatus().canStart` reports, using the same startEngine path as boot).",
              "Open Models and pull a small local model (for example qwen2.5:7b), or run: ollama pull qwen2.5:7b",
              "Alternatively paste a working cloud provider key in Models → Providers — FRIDAY only marks it connected when that provider answers.",
              "Run a Doctor scan (or say “what's wrong”) after the pull or key save.",
            ],
    }),
  );

  // --- cloud provider integrations -----------------------------------------
  // A connected key is not the same as a working integration: a provider can
  // move an endpoint or change its auth at any time. This check makes that
  // real state visible, and `applyFix("cloud-providers")` repairs it with the
  // provider's own documented endpoints — never by touching the owner's keys.
  const cloud = await inspectCloudProviders();
  const rejected = cloud.broken.filter((p) => keyRejected(p.error));
  const retryableBroken = cloud.broken.filter((p) => !keyRejected(p.error));
  const cloudSteps = [];
  if (retryableBroken.length) {
    cloudSteps.push(
      "FRIDAY will re-probe failing providers and switch to that provider's own alternate official endpoint when one answers. She never rotates or overwrites your API keys.",
    );
  }
  for (const provider of rejected) {
    cloudSteps.push(
      `${provider.name} rejected the stored API key (${provider.error || "401/403"}). Open Models → Providers, paste a current ${provider.name} key from that provider's billing/API dashboard (not an expired or project-restricted key), and save. FRIDAY marks it connected only when the provider actually answers.`,
    );
  }
  if (cloud.broken.length && !rejected.length) {
    cloudSteps.push(
      "If Repair does not clear this, check the provider's status page or set a working base URL in Models → Providers.",
    );
  }
  if (cloud.broken.length) {
    cloudSteps.push(
      "After you change a key or URL, run a Doctor scan (or say “what's wrong”) so FRIDAY re-checks for real.",
    );
  }
  checks.push(
    check({
      id: "cloud-providers",
      label: "Cloud AI providers",
      group: "AI",
      status: !cloud.configured.length
        ? "Ready"
        : cloud.broken.length
          ? cloud.broken.length === cloud.configured.length
            ? "Error"
            : "Warning"
          : "Ready",
      detail: !cloud.configured.length
        ? "no cloud provider key connected"
        : cloud.broken.length
          ? `${cloud.working.length}/${cloud.configured.length} connected provider(s) answering · failing: ${cloud.broken
              .map((p) => `${p.name} (${p.error})`)
              .join(", ")}`
          : `${cloud.working.length} connected provider(s) answering · ${cloud.models} model(s)`,
      cause: cloud.broken.length
        ? rejected.length && !retryableBroken.length
          ? "The provider rejected the stored API key. FRIDAY cannot invent or rotate a paid key."
          : "A connected provider did not answer its documented model-list endpoint."
        : null,
      fix: cloud.broken.length
        ? retryableBroken.length
          ? "Repair re-probes each failing provider and switches it to that provider's alternate official endpoint when one answers. A rejected API key must be replaced in Models → Providers."
          : "Replace the rejected API key in Models → Providers. FRIDAY never changes keys automatically."
        : null,
      fixable: retryableBroken.length > 0,
      steps: cloud.broken.length ? cloudSteps : undefined,
      meta: { providers: cloud.results, rejected: rejected.map((p) => p.id) },
    }),
  );

  // --- kernel, ports, services ---------------------------------------------
  const kernelPortOpen = await portOpen(kernelPort);
  checks.push(
    check({
      id: "kernel",
      label: "Python kernel bridge",
      group: "Services",
      status: kernelPortOpen ? "Running" : kernelRunning ? "Warning" : "Missing",
      detail: `127.0.0.1:${kernelPort} · ${kernelPortOpen ? "accepting connections" : "closed"}`,
      cause: kernelPortOpen ? null : "The kernel process is not listening.",
      fix: kernelPortOpen ? null : "Restart the kernel (safe fix) or start it manually.",
      command: "python kernel/main.py",
      fixable: !kernelPortOpen,
      steps: kernelPortOpen ? undefined : kernelOwnerSteps(),
    }),
  );
  const ollamaPort = await portOpen(11434);
  checks.push(
    check({
      id: "port-ollama",
      label: "Ollama service port",
      group: "Services",
      status: ollamaPort ? "Running" : "Warning",
      detail: `127.0.0.1:11434 · ${ollamaPort ? "listening" : "closed"}`,
      cause: ollamaPort ? null : "Ollama is installed but not serving, or not installed.",
      fix: ollamaPort ? null : "Start the Ollama service.",
      command: "ollama serve",
    }),
  );

  // --- duplicate processes --------------------------------------------------
  const dupPattern = WIN ? /FRIDAY\.exe/i : /friday/i;
  const fridayProcs = await processCount(dupPattern);
  const ollamaProcs = await processCount(/ollama/i);
  checks.push(
    check({
      id: "duplicates",
      label: "Duplicate processes",
      group: "Services",
      status: fridayProcs && fridayProcs > 12 ? "Warning" : "Ready",
      detail:
        fridayProcs === null
          ? "process list unavailable"
          : `${fridayProcs} FRIDAY process(es), ${ollamaProcs ?? 0} Ollama process(es)`,
      cause:
        fridayProcs && fridayProcs > 12
          ? "More FRIDAY processes than expected — a previous instance may still be running."
          : null,
      fix: fridayProcs && fridayProcs > 12 ? "Close other FRIDAY windows and restart." : null,
    }),
  );

  // --- database -------------------------------------------------------------
  // A first run legitimately has no database yet: that is "Pending", not a
  // failure. It only becomes an error when a file exists and is not SQLite.
  const dbCandidates = project.databaseCandidates(userData, root);
  const db = dbCandidates.find((p) => exists(p)) || null;
  let dbStatus = "Warning";
  let dbDetail = `not created yet — will be initialised at ${project.databasePath(userData)}`;
  let dbCause = "First run: the database is created when the kernel or a repair initialises it.";
  if (db) {
    try {
      const size = fs.statSync(db).size;
      const valid = project.isSqliteFile(db);
      dbStatus = valid ? "Ready" : "Error";
      dbDetail = valid
        ? `${db} · ${(size / 1024).toFixed(0)} KB`
        : `${db} · header is not a SQLite database (corrupted)`;
      dbCause = valid ? null : "The database file exists but is not readable as SQLite.";
    } catch (err) {
      dbStatus = "Error";
      dbDetail = String(err.message);
      dbCause = "The database file could not be read.";
    }
  }
  checks.push(
    check({
      id: "database",
      label: "SQLite database",
      group: "Storage",
      status: dbStatus,
      detail: dbDetail,
      cause: dbCause,
      fix:
        dbStatus === "Error"
          ? "Back up and recreate the database (safe fix backs the old file up first)."
          : dbStatus === "Ready"
            ? null
            : "Initialise the database now — the schema is applied and verified.",
      fixable: dbStatus !== "Ready",
    }),
  );

  // --- paths, configuration, permissions -----------------------------------
  checks.push(
    check({
      id: "workspace",
      label: "Primary folder",
      group: "Storage",
      status: root ? (exists(root) ? "Ready" : "Error") : "Missing",
      detail: root ? `${root}${exists(root) ? "" : " — folder no longer exists"}` : "not selected",
      cause: root
        ? exists(root)
          ? null
          : "The selected folder was moved or deleted."
        : "FRIDAY has no root folder to index or write into.",
      fix: root && exists(root) ? null : "Open Folders and choose a primary folder.",
    }),
  );

  const configFiles = [
    path.join(userData, "friday-settings.json"),
    root ? path.join(root, "config", "friday-settings.json") : null,
    root ? path.join(root, "workspace.json") : null,
  ].filter(Boolean);
  const badConfig = configFiles
    .filter((p) => exists(p))
    .map((p) => ({ p, parsed: readJson(p) }))
    .filter((x) => !x.parsed.ok);
  checks.push(
    check({
      id: "config",
      label: "Configuration files",
      group: "Storage",
      status: badConfig.length ? "Error" : "Ready",
      detail: badConfig.length
        ? badConfig.map((b) => `${path.basename(b.p)}: ${b.parsed.error}`).join(" · ")
        : `${configFiles.filter(exists).length} config file(s) valid`,
      cause: badConfig.length ? "A configuration file contains invalid JSON." : null,
      fix: badConfig.length ? "Back up and reset the corrupted file to defaults." : null,
      fixable: badConfig.length > 0,
      meta: { files: badConfig.map((b) => b.p) },
    }),
  );

  // write permission probes
  const writeProbe = (dir) => {
    if (!dir || !exists(dir)) return "missing";
    const probe = path.join(dir, `.friday-write-${process.pid}.tmp`);
    try {
      fs.writeFileSync(probe, "ok");
      fs.unlinkSync(probe);
      return "ok";
    } catch (err) {
      return String(err.code || err.message);
    }
  };
  const permUser = writeProbe(userData);
  const permRoot = root ? writeProbe(root) : "missing";
  checks.push(
    check({
      id: "permissions",
      label: "Write permissions",
      group: "Security",
      status:
        permUser === "ok" && (permRoot === "ok" || permRoot === "missing") ? "Ready" : "Error",
      detail: `user data: ${permUser} · workspace: ${permRoot}`,
      cause:
        permUser === "ok" && (permRoot === "ok" || permRoot === "missing")
          ? null
          : "FRIDAY cannot write to one of its folders.",
      fix: "Pick a writable workspace outside Program Files and protected folders. Elevate only an explicit machine-level repair.",
      steps:
        permUser === "ok" && (permRoot === "ok" || permRoot === "missing")
          ? undefined
          : [
              "FRIDAY cannot grant herself a Windows ACL or take ownership of a protected folder.",
              "If the workspace is under Program Files, a Controlled Folder Access path, or a OneDrive-locked folder, pick a writable folder in Folders (for example a folder you created in your user profile).",
              "Windows Settings → Privacy & security → Controlled folder access: allow FRIDAY.exe if that feature is on.",
              "Re-run Setup & Doctor. A remaining Access Denied is a Windows permission only you can change.",
            ],
    }),
  );

  // --- FRIDAY components ----------------------------------------------------
  const componentDirs = [
    ["agents", "agents"],
    ["skills", "skills"],
    ["tools", "tools"],
    ["plugins", "plugins"],
    ["modules", "modules"],
    ["workflows", "workflows"],
  ];
  componentDirs.forEach(([id, dir]) => {
    // Look in the workspace first (user-installed components), then in the
    // project root. An empty registry means "nothing installed yet" — Ready.
    const workspaceDir = root ? path.join(root, dir) : null;
    const projectDir = path.join(projectRoot, dir);
    const full = workspaceDir && exists(workspaceDir) ? workspaceDir : projectDir;
    let count = 0;
    let present = exists(full);
    if (present) {
      try {
        count = fs
          .readdirSync(full)
          .filter((n) => !n.startsWith(".") && !/^readme/i.test(n)).length;
      } catch {
        present = false;
      }
    }
    checks.push(
      check({
        id: `components-${id}`,
        label: `${id[0].toUpperCase()}${id.slice(1)} registry`,
        group: "Components",
        status: present ? "Ready" : "Missing",
        detail: present
          ? count > 0
            ? `${count} installed — Ready · ${dir}/`
            : `0 installed — Ready · ${dir}/`
          : `${dir}/ not found`,
        cause: present ? null : "The registry folder is missing.",
        fix: present ? null : "Recreate the folder (safe fix) or reinstall FRIDAY.",
        fixable: !present,
        meta: { dir: full },
      }),
    );
  });

  // --- network --------------------------------------------------------------
  const online = await ping("https://registry.npmjs.org/-/ping", 2500);
  checks.push(
    check({
      id: "network",
      label: "Internet connectivity",
      group: "Network",
      status: online ? "Ready" : "Warning",
      detail: online ? "registry.npmjs.org reachable" : "no outbound connection",
      cause: online ? null : "Downloads, updates and cloud providers will fail.",
      fix: online ? null : "Check your connection, proxy or firewall rules.",
      steps: online
        ? undefined
        : [
            "FRIDAY cannot change your Wi-Fi, proxy, or Windows firewall from here.",
            "Check that this PC is online (a browser should load any site).",
            "If you use a proxy or VPN, allow https://registry.npmjs.org and your cloud provider hosts.",
            "Windows Defender Firewall: allow FRIDAY.exe outbound on private networks.",
            "Re-run Setup & Doctor. If this check is still red, the remaining block is outside FRIDAY.",
          ],
    }),
  );

  // --- crashes / errors -----------------------------------------------------
  if (logPath && exists(logPath)) {
    try {
      const text = fs.readFileSync(logPath, "utf8").split(/\r?\n/).slice(-400);
      const errors = text.filter(
        (l) =>
          /error|exception|traceback|failed/i.test(l) &&
          !/Object has been destroyed|Render frame was disposed|closed or released|WebContents is not available|ignored late shutdown callback/i.test(
            l,
          ),
      );
      checks.push(
        check({
          id: "crashes",
          label: "Recent errors in log",
          group: "FRIDAY",
          status: errors.length > 20 ? "Warning" : errors.length ? "Warning" : "Ready",
          detail: errors.length
            ? `${errors.length} error line(s) in the last 400 · newest: ${errors[errors.length - 1].slice(0, 140)}`
            : "no errors in the recent log",
          cause: errors.length ? "FRIDAY recorded errors during recent runs." : null,
          fix: errors.length ? "Open the detailed log below and address the newest entry." : null,
          meta: { lines: errors.slice(-25) },
        }),
      );
    } catch {
      /* log unreadable — skip */
    }
  }

  // --- deep-only checks -----------------------------------------------------
  if (deep) {
    const outdated = tools.filter(
      (t) => t.installed && t.latestKnown && t.version && t.version !== t.latestKnown,
    );
    checks.push(
      check({
        id: "deep-tools",
        label: "Full toolchain sweep",
        group: "Runtimes",
        status: outdated.length ? "Outdated" : "Ready",
        detail: `${tools.filter((t) => t.installed).length}/${tools.length} catalog tools installed`,
        cause: outdated.length ? `${outdated.length} tool(s) behind the published version.` : null,
        fix: outdated.length ? "Open Install Manager and run the pending updates." : null,
      }),
    );
    const python = await resolvePython(projectRoot);
    const pyCheck = python
      ? await run(
          python.exe,
          [...python.prefix, "-c", "import sqlite3,json,yaml;print('ok')"],
          12000,
        )
      : null;
    checks.push(
      check({
        id: "deep-python",
        label: "Kernel Python imports",
        group: "Dependencies",
        status: pyCheck && /ok/.test(pyCheck) ? "Ready" : "Error",
        detail: pyCheck
          ? pyCheck.split(/\r?\n/).slice(-1)[0]
          : "python could not import sqlite3/json/yaml",
        cause:
          pyCheck && /ok/.test(pyCheck)
            ? null
            : "Kernel dependencies are missing from this Python.",
        fix: "Install the kernel requirements.",
        command: "python -m pip install -r kernel/requirements.txt",
      }),
    );
  }

  return { at: Date.now(), durationMs: Date.now() - started, deep, checks };
}

/* ------------------------------------------------ cloud provider integrity */

/** The one place provider keys live — the same store models.cjs writes to. */
const providerStore = () => require("./friday-paths.cjs").base();

/**
 * Real state of every cloud provider the owner has connected: each one is
 * probed through its own documented model-list endpoint with the stored key.
 * No key material is returned — only whether the integration answered.
 */
async function inspectCloudProviders() {
  const modelsApi = require("./models.cjs");
  const store = providerStore();
  let keys = {};
  try {
    keys = modelsApi.readKeys(store) || {};
  } catch {
    keys = {};
  }
  const configured = Object.keys(modelsApi.CLOUD).filter(
    (id) => keys[id] || (modelsApi.CLOUD[id].env && process.env[modelsApi.CLOUD[id].env]),
  );
  const results = await Promise.all(
    configured.map(async (id) => {
      const probe = await modelsApi.testProvider(id, { userData: store });
      return {
        id,
        name: modelsApi.CLOUD[id].name || id,
        online: Boolean(probe.online),
        models: probe.models || 0,
        latencyMs: probe.latencyMs ?? null,
        error: probe.error || null,
      };
    }),
  );
  return {
    configured,
    results,
    working: results.filter((r) => r.online),
    broken: results.filter((r) => !r.online),
    models: results.reduce((n, r) => n + (r.models || 0), 0),
  };
}

/**
 * Self-healing for a broken provider integration.
 *
 * Only two non-destructive moves are made, in this order:
 *   1. re-probe (transient outages clear themselves), and
 *   2. switch the provider to one of ITS OWN alternate official endpoints
 *      declared in the canonical CLOUD table, but only when that endpoint
 *      really answers with the owner's key.
 * A rejected key is reported, never rotated or deleted.
 */
async function healCloudProviders(say) {
  const modelsApi = require("./models.cjs");
  const { fetchCompat } = require("./net-fetch.cjs");
  const store = providerStore();
  const report = await inspectCloudProviders();

  if (!report.configured.length) {
    say("no cloud provider key is connected — nothing to repair");
    return { ok: true, repaired: [], failed: [] };
  }
  if (!report.broken.length) {
    say(`all ${report.configured.length} connected provider(s) answered`);
    return { ok: true, repaired: [], failed: [] };
  }

  const keys = modelsApi.readKeys(store) || {};
  const repaired = [];
  const failed = [];

  for (const provider of report.broken) {
    const spec = modelsApi.CLOUD[provider.id];
    const key = keys[provider.id] || (spec.env ? process.env[spec.env] : null);

    // 1. transient failure?
    const retry = await modelsApi.testProvider(provider.id, { userData: store });
    if (retry.online) {
      say(`${provider.name}: recovered on retry (${retry.models} model(s))`);
      repaired.push(provider.id);
      continue;
    }

    if (/rejected|401|403/i.test(String(provider.error || ""))) {
      say(
        `${provider.name}: the provider rejected the stored API key — replace it in Models → Providers (keys are never changed automatically)`,
      );
      failed.push(provider.id);
      continue;
    }

    // 2. the provider's own alternate official endpoint.
    let healed = false;
    for (const base of spec.alternates || []) {
      if (!key) break;
      let ok = false;
      try {
        const res = await fetchCompat(`${base.replace(/\/+$/, "")}/models`, {
          headers: spec.headers(key),
        });
        ok = res.ok;
      } catch {
        ok = false;
      }
      if (!ok) continue;
      const written = modelsApi.writeEndpoint(store, provider.id, base);
      if (!written.ok) continue;
      const verify = await modelsApi.testProvider(provider.id, { userData: store });
      if (verify.online) {
        say(`${provider.name}: switched to its alternate official endpoint ${base} and verified`);
        repaired.push(provider.id);
        healed = true;
        break;
      }
      // Do not leave an endpoint behind that did not verify.
      modelsApi.writeEndpoint(store, provider.id, null);
    }
    if (healed) continue;

    say(
      `${provider.name}: still failing (${provider.error || "no response"}) — check the provider's status page or set a working base URL in Models → Providers`,
    );
    failed.push(provider.id);
  }

  return { ok: failed.length === 0, repaired, failed };
}

/* --------------------------------------------------------------- safe fixes */

function backupFile(root, file) {
  try {
    if (!exists(file)) return null;
    const dir = path.join(root || os.tmpdir(), "backup", "config");
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${path.basename(file)}.${Date.now()}.bak`);
    fs.copyFileSync(file, dest);
    return dest;
  } catch {
    return null;
  }
}

/**
 * Apply a safe repair. Risky repairs back the affected file up first and the
 * backup path is returned so the UI can roll back.
 */
async function applyFix(ctx, id, helpers = {}) {
  const { root = null, userData = os.tmpdir(), install = process.cwd() } = ctx;
  const log = [];
  const say = (line) => log.push(line);

  try {
    if (id === "cloud-providers") {
      const result = await healCloudProviders(say);
      return { ok: result.ok, log, repaired: result.repaired, failed: result.failed };
    }

    if (id === "kernel") {
      if (typeof helpers.restartKernel !== "function")
        throw new Error("kernel control unavailable");

      // A restart alone cannot fix the common cause: the kernel's Python
      // packages are not installed, so the process exits before it binds the
      // port. Verify the imports first and install the requirements when they
      // are missing — that is the actual repair.
      const python = await resolvePython(project.resolveProjectRoot(ctx), true);
      if (!python)
        return {
          ok: false,
          log: [
            "FRIDAY's isolated Python 3.12 runtime was not found. Run Setup again, then retry.",
          ],
        };
      const imports = await run(
        python.exe,
        [...python.prefix, "-c", "import fastapi,uvicorn,httpx,pydantic,yaml;print('ok')"],
        20000,
      );
      if (!imports || !/ok/.test(imports)) {
        const req = [
          path.join(process.resourcesPath || "", "kernel", "requirements.txt"),
          path.join(install, "kernel", "requirements.txt"),
          root && path.join(root, "kernel", "requirements.txt"),
        ]
          .filter(Boolean)
          .find(exists);
        if (!req) {
          return {
            ok: false,
            log: [
              ...log,
              `kernel requirements.txt not found — reinstall FRIDAY or run: "${python.executable}" -m pip install fastapi uvicorn httpx pydantic pyyaml`,
            ],
          };
        }
        say(
          `installing kernel dependencies with ${python.executable} (this can take a few minutes)`,
        );
        const base = [...python.prefix, "-m", "pip", "install", "--prefer-binary", "-r", req];
        const out = await run(python.exe, base, 600000);
        if (out === null) {
          const user = await run(
            python.exe,
            [...python.prefix, "-m", "pip", "install", "--user", "--prefer-binary", "-r", req],
            600000,
          );
          if (user === null) {
            return {
              ok: false,
              log: [
                ...log,
                `pip could not install the kernel requirements. Run manually: "${python.executable}" -m pip install -r "${req}"`,
              ],
            };
          }
        }
        const recheck = await run(
          python.exe,
          [...python.prefix, "-c", "import fastapi,uvicorn,httpx,pydantic,yaml;print('ok')"],
          20000,
        );
        if (!recheck || !/ok/.test(recheck)) {
          return {
            ok: false,
            log: [
              ...log,
              "dependencies installed but still not importable — check that FRIDAY uses this Python (set FRIDAY_PYTHON)",
            ],
          };
        }
        say("kernel dependencies installed");
      }

      helpers.restartKernel();
      say("kernel restart requested");
      // Importing FastAPI/uvicorn on a cold cache takes longer than 2.5s.
      let ok = false;
      for (let i = 0; i < 12 && !ok; i += 1) {
        await new Promise((r) => setTimeout(r, 2000));
        ok = await portOpen(ctx.kernelPort || 8765);
      }
      return {
        ok,
        log: [
          ...log,
          ok
            ? "kernel is listening again"
            : "kernel still not listening — open Logs for the Python error",
        ],
      };
    }

    if (id === "providers") {
      const { engineStatus, startEngine } = require("./models.cjs");
      const engines = await engineStatus();
      const startable = engines.filter((e) => e.canStart && !e.running);
      if (!startable.length) {
        const hints = engines
          .filter((e) => !e.running)
          .map((e) => `${e.name}: ${e.hint || "must be started manually"}`);
        return {
          ok: false,
          log: hints.length ? hints : ["no local engine can be started automatically"],
        };
      }
      for (const engine of startable) {
        const result = await startEngine(engine.id);
        if (result?.ok) say(`${engine.name}: ${result.detail || "endpoint verified"}`);
        else say(`${engine.name}: ${result?.error || "start failed"}`);
      }
      const after = await engineStatus();
      const up = after.filter((e) => e.running);
      return {
        ok: up.length > 0,
        log: [
          ...log,
          up.length
            ? `${up.map((e) => e.name).join(", ")} answering`
            : "no local engine answered after start",
        ],
      };
    }

    if (id === "database") {
      const existing = project.databaseCandidates(userData, root).find(exists) || null;

      // Corrupted file: back it up, remove it, then rebuild from the schema.
      if (existing && !project.isSqliteFile(existing)) {
        const backup = backupFile(root, existing);
        say(`backed up to ${backup || "(backup failed)"}`);
        if (!backup)
          return {
            ok: false,
            log: [...log, "aborted — refusing to touch the file without a backup"],
          };
        fs.unlinkSync(existing);
        say("corrupted database removed");
        const rebuilt = await project.ensureDatabase({ userData, root, install });
        if (typeof helpers.restartKernel === "function") helpers.restartKernel();
        return {
          ok: rebuilt.ok,
          log: [...log, ...rebuilt.log],
          backup,
          rollback: [{ file: existing, backup }],
        };
      }

      // Missing or incomplete: create the directory, apply the schema, verify.
      const result = await project.ensureDatabase({ userData, root, install });
      return { ok: result.ok, log: [...log, ...result.log] };
    }

    if (id === "config") {
      const files = [
        path.join(userData, "friday-settings.json"),
        root && path.join(root, "config", "friday-settings.json"),
        root && path.join(root, "workspace.json"),
      ]
        .filter(Boolean)
        .filter(exists)
        .filter((p) => !readJson(p).ok);
      if (!files.length) return { ok: true, log: ["configuration is already valid"] };
      const rollback = [];
      files.forEach((file) => {
        const backup = backupFile(root, file);
        if (!backup) {
          say(`skipped ${path.basename(file)} — backup failed`);
          return;
        }
        fs.writeFileSync(file, "{}\n");
        rollback.push({ file, backup });
        say(`${path.basename(file)} reset to defaults (backup: ${backup})`);
      });
      return { ok: rollback.length > 0, log, rollback };
    }

    if (id.startsWith("components-")) {
      const name = id.replace("components-", "");
      // Recreate in the workspace when there is one, otherwise the project root.
      const base = root && exists(root) ? root : project.resolveProjectRoot({ ...ctx, install });
      const dir = path.join(base, name);
      fs.mkdirSync(dir, { recursive: true });
      say(`recreated ${dir}`);
      return { ok: exists(dir), log };
    }

    return { ok: false, log: [`no automated repair is available for "${id}"`] };
  } catch (err) {
    return { ok: false, log: [...log, `repair failed: ${String(err.message)}`] };
  }
}

/** Restore files saved by a previous repair. */
function rollbackFix(entries = []) {
  const log = [];
  let ok = true;
  entries.forEach(({ file, backup }) => {
    try {
      fs.copyFileSync(backup, file);
      log.push(`restored ${path.basename(file)}`);
    } catch (err) {
      ok = false;
      log.push(`rollback failed for ${file}: ${String(err.message)}`);
    }
  });
  return { ok, log };
}

/**
 * In-app Doctor row for Tesseract. Missing is honest when the binary is absent.
 * Setup does not fail on this row.
 */
function ocrDoctorRow(tool) {
  const installed = Boolean(tool && tool.installed);
  return check({
    id: "ocr-tesseract",
    label: "Tesseract OCR",
    group: "Computer Vision",
    status: installed ? "Ready" : "Missing",
    detail: installed
      ? `${tool.version || "installed"} · ${tool.path || ""}`.trim()
      : "Tesseract OCR is not installed",
    cause: installed ? null : "Tesseract OCR is not installed or not on PATH.",
    fix: installed
      ? null
      : "Install Tesseract OCR from Install Manager (winget UB-Mannheim.TesseractOCR).",
    docs: "https://github.com/UB-Mannheim/tesseract/wiki",
    fixable: false,
  });
}

module.exports = {
  runDiagnostics,
  applyFix,
  rollbackFix,
  ocrDoctorRow,
  portOpen,
  inspectCloudProviders,
  healCloudProviders,
  keyRejected,
  kernelOwnerSteps,
};
