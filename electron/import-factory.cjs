// FRIDAY · Import & Build local factory.
//
// Packages files on this PC so the owner can keep, download, install, or
// re-import them into a real FRIDAY section. FRIDAY's own EXE / portable /
// source ZIP still goes through electron/builder-run.cjs (scripts/build-windows.cmd).
// Other apps never use FRIDAY's electron-builder.yml, never git-push, and
// never edit FRIDAY's GitHub repository — that stays on Friday Hub.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const WIN = process.platform === "win32";
const jobs = new Map();

const IGNORE = new Set([
  "node_modules",
  ".git",
  ".venv",
  "release",
  "dist",
  "dist-desktop",
  "__pycache__",
  ".cache",
]);

const FRIDAY_MARKERS = [
  "package.json",
  "scripts/build-windows.cmd",
  "electron-builder.yml",
  "config/friday-version.json",
];

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, ...opts });
    } catch (error) {
      resolve({ ok: false, output: String(error.message || error), code: -1 });
      return;
    }
    let output = "";
    const consume = (chunk) => {
      output += String(chunk);
      if (typeof opts.onLine === "function") {
        for (const raw of String(chunk).split(/\r?\n/)) {
          const line = raw.trim();
          if (line) opts.onLine(line);
        }
      }
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    child.on("error", (error) =>
      resolve({ ok: false, output: String(error.message || error), code: -1 }),
    );
    child.on("close", (code) => resolve({ ok: code === 0, output, code }));
  });
}

function slug(value) {
  const raw = String(value || "app")
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return raw || "app";
}

function isFridaySource(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  return FRIDAY_MARKERS.every((marker) => fs.existsSync(path.join(dir, marker)));
}

function readPackage(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function inspectSource(dir) {
  const root = dir ? path.resolve(String(dir)) : "";
  if (!root || !fs.existsSync(root)) {
    return { ok: false, error: "That folder does not exist." };
  }
  const pkg = readPackage(root);
  const friday = isFridaySource(root);
  const electron =
    Boolean(pkg?.devDependencies?.electron || pkg?.dependencies?.electron) ||
    fs.existsSync(path.join(root, "electron-builder.yml"));
  const hasBuilder = fs.existsSync(path.join(root, "electron-builder.yml"));
  const name =
    (typeof pkg?.productName === "string" && pkg.productName) ||
    (typeof pkg?.name === "string" && pkg.name) ||
    path.basename(root);
  const version = (typeof pkg?.version === "string" && pkg.version) || (friday ? null : "0.0.1");
  const warnings = [];
  if (friday) {
    warnings.push(
      "This is FRIDAY's own source. Other-app builds refuse it — switch identity to FRIDAY.",
    );
  }
  if (!pkg) warnings.push("No package.json — ZIP is the real product here.");
  if (!friday && !hasBuilder) {
    warnings.push(
      "Not an Electron app with its own packager — EXE needs Windows + this project's electron-builder.yml.",
    );
  }
  return {
    ok: true,
    root,
    identity: friday ? "friday" : "other",
    name,
    version,
    electron: Boolean(electron),
    hasBuilder,
    exeReady: Boolean(!friday && electron && hasBuilder && WIN),
    friday,
    warnings,
  };
}

function keptDir(workspaceRoot) {
  const dir = path.join(String(workspaceRoot || ""), "downloads", "kept-builds");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(exe|zip|tar\.gz|tgz)$/i.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const stat = fs.statSync(full);
    out.push({ name: entry.name, path: full, bytes: stat.size, at: stat.mtimeMs, kept: true });
  }
  return out.sort((a, b) => b.at - a.at);
}

function listKept(workspaceRoot) {
  if (!workspaceRoot) return [];
  const root = keptDir(workspaceRoot);
  const out = listFiles(root);
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      out.push(...listFiles(path.join(root, entry.name)));
    }
  } catch {
    /* unreadable keep folder */
  }
  return out.sort((a, b) => (b.at || 0) - (a.at || 0));
}

function uniqueDest(dir, filename) {
  const base = path.basename(filename);
  let dest = path.join(dir, base);
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(base);
  const stem = path.basename(base, ext);
  dest = path.join(dir, `${stem}-${Date.now().toString(36)}${ext}`);
  return dest;
}

function keepArtifact({ workspaceRoot, file, name } = {}) {
  if (!workspaceRoot) return { ok: false, error: "No FRIDAY workspace is selected." };
  const from = file ? path.resolve(String(file)) : "";
  if (!from || !fs.existsSync(from) || !fs.statSync(from).isFile()) {
    return { ok: false, error: "That artifact is no longer on disk." };
  }
  const dest = uniqueDest(keptDir(workspaceRoot), name || path.basename(from));
  fs.copyFileSync(from, dest);
  const stat = fs.statSync(dest);
  return { ok: true, name: path.basename(dest), path: dest, bytes: stat.size, at: stat.mtimeMs };
}

function copyFiltered(from, to) {
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, {
    recursive: true,
    filter: (p) => !IGNORE.has(path.basename(p)),
  });
}

async function createZip(sourceDir, destZip) {
  fs.mkdirSync(path.dirname(destZip), { recursive: true });
  const parent = path.dirname(sourceDir);
  const name = path.basename(sourceDir);
  const zipRun = await run(
    "zip",
    ["-r", destZip, name, "-x", "*/node_modules/*", "*/.git/*", "*/.venv/*"],
    {
      cwd: parent,
    },
  );
  if (zipRun.ok && fs.existsSync(destZip)) return { ok: true, via: "zip", file: destZip };

  const script = `
import json, os, zipfile, sys
root = json.loads(sys.argv[1])
out = json.loads(sys.argv[2])
ignore = set(${JSON.stringify([...IGNORE])})
parent = os.path.dirname(root)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in ignore]
        for filename in files:
            if filename in ignore:
                continue
            full = os.path.join(dirpath, filename)
            rel = os.path.relpath(full, parent)
            z.write(full, rel.replace(os.sep, "/"))
`;
  for (const bin of ["python3", "python"]) {
    const py = await run(bin, ["-c", script, JSON.stringify(sourceDir), JSON.stringify(destZip)]);
    if (py.ok && fs.existsSync(destZip)) return { ok: true, via: bin, file: destZip };
  }

  if (WIN) {
    const staging = `${destZip}.src`;
    try {
      if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
      copyFiltered(sourceDir, staging);
      const safeFrom = staging.replace(/'/g, "''");
      const safeTo = destZip.replace(/'/g, "''");
      const ps = await run("powershell", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Compress-Archive -LiteralPath '${safeFrom}' -DestinationPath '${safeTo}' -Force`,
      ]);
      fs.rmSync(staging, { recursive: true, force: true });
      if (ps.ok && fs.existsSync(destZip))
        return { ok: true, via: "Compress-Archive", file: destZip };
    } catch (error) {
      try {
        fs.rmSync(staging, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      return { ok: false, error: String(error.message || error) };
    }
  }

  return {
    ok: false,
    error: "No zip tool was available (zip, python zipfile, or Compress-Archive).",
  };
}

function installArtifact(file) {
  const from = file ? path.resolve(String(file)) : "";
  if (!from || !fs.existsSync(from)) {
    return { ok: false, error: "That installer is no longer on disk." };
  }
  if (!/\.exe$/i.test(from)) {
    return {
      ok: false,
      error:
        "Only a .exe can be launched as an installer. For a zip or pack, use Install into FRIDAY.",
    };
  }
  if (!WIN) {
    return { ok: false, error: "Running a Windows installer needs Windows." };
  }
  return { ok: true, file: from, launch: true };
}

/**
 * Start a local other-app package. Returns { ok, id } immediately; completion
 * arrives through onProgress — same shape as builder-run.startBuild.
 */
function startBuild({
  kind = "zip",
  name = "app",
  version = "0.0.1",
  sourceDir = null,
  scanId = null,
  clientId = null,
  workspaceRoot = null,
  resolveScan = null,
  onProgress = () => {},
} = {}) {
  if (!workspaceRoot) {
    return { ok: false, error: "No FRIDAY workspace is selected." };
  }
  let root = sourceDir ? path.resolve(String(sourceDir)) : null;
  if (!root && scanId && typeof resolveScan === "function") {
    const scan = resolveScan(scanId);
    root = scan?.contentRoot || null;
  }
  if (!root || !fs.existsSync(root)) {
    return { ok: false, error: "Choose a folder or an imported source to package." };
  }
  if (isFridaySource(root)) {
    return {
      ok: false,
      error:
        "That folder is FRIDAY's own source. Switch this artifact to FRIDAY — other builds never drive FRIDAY's official packager or GitHub repo.",
    };
  }

  const product = slug(name);
  const ver = slug(version).replace(/^v/i, "") || "0.0.1";
  const want = String(kind || "zip");
  if (want === "exe" || want === "portable") {
    const info = inspectSource(root);
    if (!WIN) {
      return {
        ok: false,
        error:
          "Windows installers for other apps can only be produced on Windows. Package a ZIP here instead.",
      };
    }
    if (!info.exeReady) {
      return {
        ok: false,
        error:
          "This project is not an Electron app with its own electron-builder.yml. Package a ZIP — FRIDAY's installer is never reused for other apps.",
      };
    }
  }

  const id = `factory-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const job = {
    id,
    clientId,
    kind: want,
    name: product,
    version: ver,
    root,
    workspaceRoot,
    progress: 0,
    step: "Queued",
    status: "queued",
    aborted: false,
    onProgress,
    child: null,
    stagingRoot: null,
  };
  jobs.set(id, job);
  onProgress({ id, clientId, kind: want, progress: 0, step: "Queued", status: "queued" });
  setImmediate(() => void pump());
  return { ok: true, id, kind: want, root, queued: true };
}

async function pump() {
  if ([...jobs.values()].some((j) => j.status === "running")) return;
  const job = [...jobs.values()].find((j) => j.status === "queued");
  if (!job) return;
  job.status = "running";
  const { id, clientId, kind, root, name, version, workspaceRoot, onProgress } = job;
  const emit = (patch) => {
    if (job.aborted) return;
    job.progress = patch.progress ?? job.progress;
    job.step = patch.step ?? job.step;
    onProgress({
      id,
      clientId,
      kind,
      progress: job.progress,
      step: job.step,
      status: patch.status || "running",
      line: patch.line,
      artifact: patch.artifact ?? null,
      artifacts: patch.artifacts,
    });
  };

  const stagingRoot = path.join(keptDir(workspaceRoot), `.stage-${id}`);
  job.stagingRoot = stagingRoot;
  const dropStaging = () => {
    try {
      if (fs.existsSync(stagingRoot)) fs.rmSync(stagingRoot, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  };
  const aborted = () => job.aborted || !jobs.has(id);

  try {
    if (kind === "zip") {
      emit({ progress: 8, step: "Preparing source", line: root });
      dropStaging();
      const staging = path.join(stagingRoot, name);
      copyFiltered(root, staging);
      emit({ progress: 24, step: "Source copied", line: staging });
      if (aborted()) {
        dropStaging();
        return;
      }
      const dest = uniqueDest(keptDir(workspaceRoot), `${name}-${version}.zip`);
      emit({ progress: 40, step: "Writing ZIP" });
      const packed = await createZip(staging, dest);
      dropStaging();
      if (aborted()) {
        try {
          if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
        } catch {
          /* ignore */
        }
        return;
      }
      if (!packed.ok) {
        job.status = "error";
        emit({
          progress: job.progress,
          step: packed.error || "ZIP failed",
          status: "error",
        });
        jobs.delete(id);
        void pump();
        return;
      }
      job.status = "done";
      emit({
        progress: 100,
        step: "Build finished",
        status: "done",
        artifact: packed.file,
        artifacts: listKept(workspaceRoot),
        line: packed.file,
      });
      jobs.delete(id);
      void pump();
      return;
    }

    const outDir = path.join(keptDir(workspaceRoot), `${name}-${version}`);
    fs.mkdirSync(outDir, { recursive: true });
    const npx = WIN ? "npx.cmd" : "npx";
    const target = kind === "portable" ? ["--win", "portable"] : ["--win", "nsis"];
    emit({ progress: 36, step: "Packaging with this project's electron-builder" });
    const child = spawn(
      npx,
      [
        "--yes",
        "electron-builder",
        ...target,
        `--config.productName=${name}`,
        `--config.extraMetadata.version=${version}`,
        `--config.directories.output=${outDir}`,
      ],
      { cwd: root, windowsHide: true, env: process.env },
    );
    job.child = child;
    child.stdout?.on("data", (chunk) => {
      const line = String(chunk).trim().split(/\r?\n/).pop();
      if (line) emit({ progress: Math.min(90, job.progress + 2), step: "Packaging", line });
    });
    child.stderr?.on("data", (chunk) => {
      const line = String(chunk).trim().split(/\r?\n/).pop();
      if (line) emit({ line, progress: job.progress, step: job.step });
    });
    child.on("error", (error) => {
      if (aborted()) return;
      job.status = "error";
      emit({
        step: `Could not start this project's packager: ${String(error.message || error)}`,
        status: "error",
      });
      jobs.delete(id);
      void pump();
    });
    child.on("close", (code) => {
      if (aborted()) return;
      const produced = listFiles(outDir);
      const ok = code === 0 && produced.length > 0;
      job.status = ok ? "done" : "error";
      emit({
        progress: ok ? 100 : job.progress,
        step: ok
          ? "Build finished"
          : `Other-app packager failed (exit ${code}). FRIDAY's official builder was not used.`,
        status: job.status,
        artifact: produced[0]?.path || null,
        artifacts: produced,
      });
      jobs.delete(id);
      void pump();
    });
    return;
  } catch (error) {
    dropStaging();
    job.status = "error";
    emit({
      step: String(error.message || error),
      status: "error",
    });
    jobs.delete(id);
    void pump();
  }
}

function cancelBuild(id) {
  const job = jobs.get(id);
  if (!job) return { ok: false, error: "That build is no longer running." };
  job.aborted = true;
  try {
    if (job.child) {
      if (WIN)
        spawn("taskkill", ["/pid", String(job.child.pid), "/T", "/F"], { windowsHide: true });
      else job.child.kill("SIGTERM");
    }
  } catch {
    /* already gone */
  }
  try {
    if (job.stagingRoot && fs.existsSync(job.stagingRoot)) {
      fs.rmSync(job.stagingRoot, { recursive: true, force: true });
    }
  } catch {
    /* already gone */
  }
  try {
    job.onProgress({
      id: job.id,
      clientId: job.clientId,
      kind: job.kind,
      progress: job.progress,
      step: "cancelled",
      status: "error",
    });
  } catch {
    /* listener already gone */
  }
  jobs.delete(id);
  void pump();
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
  IGNORE,
  FRIDAY_MARKERS,
  isFridaySource,
  inspectSource,
  keptDir,
  listKept,
  keepArtifact,
  createZip,
  installArtifact,
  startBuild,
  cancelBuild,
  activeBuilds,
  slug,
};
