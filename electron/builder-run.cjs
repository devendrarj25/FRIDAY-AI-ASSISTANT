// FRIDAY · in-app build runner.
//
// This module never re-implements the build. It drives the one canonical,
// already working entry point — scripts/build-windows.cmd on Windows and
// `npm run build:desktop` elsewhere — streams its output as progress and
// reports the artifacts electron-builder produced in release/.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const WIN = process.platform === "win32";
const jobs = new Map();

const isProject = (dir) =>
  Boolean(dir) &&
  fs.existsSync(path.join(dir, "package.json")) &&
  fs.existsSync(path.join(dir, "scripts", "build-windows.cmd"));

/** The FRIDAY source project (only present in a dev/source checkout). */
function sourceRoot({ appPath = null, projectRoot = null } = {}) {
  const seeds = [
    projectRoot,
    path.resolve(__dirname, ".."),
    appPath ? path.resolve(appPath, "..") : null,
    appPath ? path.resolve(appPath, "..", "..") : null,
  ].filter(Boolean);
  for (const seed of seeds) {
    // The owner may point at the project folder, a subfolder of it, or a
    // parent that contains it — walk up a few levels before giving up.
    let dir = seed;
    for (let depth = 0; depth < 4; depth += 1) {
      if (isProject(dir)) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    // …and one level down, for "Downloads/FRIDAY-<version>/FRIDAY".
    try {
      for (const entry of fs.readdirSync(seed, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const child = path.join(seed, entry.name);
        if (isProject(child)) return child;
      }
    } catch {
      /* unreadable seed — try the next one */
    }
  }
  return null;
}

/**
 * Everything a real build needs, checked before a single process is spawned so
 * failures are explained in the UI instead of appearing as a cryptic exit code.
 */
function preflight(root) {
  const missing = [];
  const warnings = [];
  if (!fs.existsSync(path.join(root, "package.json"))) missing.push("package.json");
  if (!fs.existsSync(path.join(root, "scripts", "build-windows.cmd"))) {
    missing.push("scripts/build-windows.cmd");
  }
  if (!fs.existsSync(path.join(root, "electron-builder.yml"))) missing.push("electron-builder.yml");
  if (!fs.existsSync(path.join(root, "builder", "cli.mjs"))) missing.push("builder/cli.mjs");
  if (!fs.existsSync(path.join(root, "package-lock.json"))) {
    warnings.push("package-lock.json is missing — `npm ci` cannot run reproducibly.");
  }
  if (!fs.existsSync(path.join(root, "node_modules"))) {
    warnings.push("node_modules is missing — the first build installs them and takes longer.");
  }
  let version = null;
  try {
    version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || null;
  } catch {
    missing.push("readable package.json");
  }
  return { ready: missing.length === 0, missing, warnings, version };
}

function commandFor(kind, root) {
  // A source archive is a different product from an installer: it is produced
  // by the canonical builder CLI, not by electron-builder.
  if (kind === "zip") {
    return {
      file: process.execPath,
      args: [path.join(root, "builder", "cli.mjs"), "zip"],
      node: true,
    };
  }
  if (WIN) {
    const script = path.join(root, "scripts", "build-windows.cmd");
    const target = kind === "portable" ? "portable" : kind === "dir" ? "dir" : "nsis";
    return { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", script, target] };
  }
  // Non-Windows hosts can still produce the renderer bundle for verification.
  return { file: WIN ? "npm.cmd" : "npm", args: ["run", "build:desktop"] };
}

function artifacts(root) {
  const dirs = [path.join(root, "release"), path.join(root, "releases", "installers")];
  const out = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(exe|zip|blockmap)$/i.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const stat = fs.statSync(full);
      out.push({ name: entry.name, path: full, bytes: stat.size, at: stat.mtimeMs });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

// Rough but honest progress: each recognised build phase moves the bar.
const PHASES = [
  [/synchronizing npm dependencies/i, 8, "Synchronizing dependencies"],
  [/isolated Python runtime/i, 18, "Preparing Python runtime"],
  [/checking the build environment/i, 26, "Checking environment"],
  [/building renderer bundle/i, 40, "Building renderer bundle"],
  [/packaging Windows app/i, 60, "Packaging Electron app"],
  [/building.*nsis|writing installer|building target/i, 78, "Writing installer"],
  [/verifying artifacts/i, 90, "Verifying artifacts"],
  [/verifying that FRIDAY boots/i, 95, "Verifying boot"],
  [/build finished/i, 99, "Finishing"],
];

/** The most useful line of a failed build log, for the UI headline. */
function failureReason(log = []) {
  const interesting = [...log]
    .reverse()
    .find((line) =>
      /error|failed|not recognized|cannot|ENOENT|exit status|is required/i.test(line),
    );
  return interesting ? interesting.slice(0, 220) : null;
}

/**
 * Start a build. onProgress receives { id, progress, step, line, status }.
 * Returns { ok, id } immediately; completion arrives through onProgress.
 */
function startBuild({ kind = "exe", context = {}, onProgress = () => {} } = {}) {
  const root = sourceRoot(context);
  if (!root) {
    return {
      ok: false,
      error:
        "Builds run from the FRIDAY source project. Use “Choose source project” to point FRIDAY at the folder that contains package.json and scripts\\build-windows.cmd (or import the source ZIP first).",
    };
  }
  const checks = preflight(root);
  if (!checks.ready) {
    return {
      ok: false,
      error: `That project cannot be built yet — missing ${checks.missing.join(", ")}.`,
      root,
      ...checks,
    };
  }
  if (!WIN && kind !== "zip") {
    // Be honest instead of producing a bundle and calling it an installer.
    return {
      ok: false,
      error: "Windows installers can only be produced on Windows. Use “Source ZIP” here instead.",
      root,
    };
  }
  const id = `build-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const job = {
    id,
    kind,
    root,
    child: null,
    progress: 0,
    step: "Queued",
    log: [],
    status: "queued",
    checks,
    onProgress,
  };
  jobs.set(id, job);
  onProgress({ id, kind, progress: 0, step: "Queued", status: "queued" });
  pump();
  return { ok: true, id, kind, root, queued: job.status === "queued" };
}

/** Start the next queued build when nothing else is running. */
function pump() {
  if ([...jobs.values()].some((j) => j.status === "running")) return;
  const job = [...jobs.values()].find((j) => j.status === "queued");
  if (!job) return;
  const { id, kind, root, onProgress } = job;
  const { file, args, node } = commandFor(kind, root);
  const env = node ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" } : process.env;
  let child;
  try {
    child = spawn(file, args, { cwd: root, windowsHide: true, env });
  } catch (error) {
    job.status = "error";
    onProgress({
      id,
      kind,
      progress: 0,
      step: `Could not start the build: ${String(error.message || error)}`,
      status: "error",
    });
    jobs.delete(id);
    pump();
    return;
  }

  job.child = child;
  job.status = "running";
  job.progress = 2;
  job.step = "Starting";
  for (const warning of job.checks.warnings) {
    onProgress({ id, kind, progress: 2, step: "Starting", line: warning, status: "running" });
  }
  onProgress({ id, kind, progress: 2, step: "Starting", status: "running" });

  const consume = (chunk) => {
    for (const raw of String(chunk).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      job.log.push(line);
      if (job.log.length > 400) job.log.shift();
      for (const [pattern, progress, step] of PHASES) {
        if (pattern.test(line) && progress > job.progress) {
          job.progress = progress;
          job.step = step;
        }
      }
      onProgress({ id, kind, progress: job.progress, step: job.step, line, status: "running" });
    }
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);

  child.on("error", (error) => {
    job.status = "error";
    onProgress({ id, kind, progress: job.progress, step: String(error.message), status: "error" });
    jobs.delete(id);
    pump();
  });

  child.on("close", (code) => {
    const ok = code === 0;
    job.status = ok ? "done" : "error";
    const produced = artifacts(root);
    onProgress({
      id,
      kind,
      progress: ok ? 100 : job.progress,
      step: ok
        ? "Build finished"
        : `Build failed (exit ${code}) — ${failureReason(job.log) || "see the log below"}`,
      status: job.status,
      artifacts: produced,
      artifact: produced[0]?.path || null,
    });
    jobs.delete(id);
    pump();
  });
}

function cancelBuild(id) {
  const job = jobs.get(id);
  if (!job) return { ok: false, error: "That build is no longer running." };
  try {
    if (job.child) {
      if (WIN) {
        spawn("taskkill", ["/pid", String(job.child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        job.child.kill("SIGTERM");
      }
    }
  } catch {
    /* already gone */
  }
  jobs.delete(id);
  pump();
  return { ok: true };
}

const activeBuilds = () =>
  [...jobs.values()].map(({ id, kind, progress, step, status }) => ({
    id,
    kind,
    progress,
    step,
    status,
  }));

module.exports = {
  startBuild,
  cancelBuild,
  activeBuilds,
  artifacts,
  sourceRoot,
  preflight,
};
