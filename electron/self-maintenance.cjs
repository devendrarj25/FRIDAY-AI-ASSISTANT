// FRIDAY · autonomous self-maintenance.
//
// The loop this module owns:
//
//   index → detect change → impact verdict → backup → sandbox verify →
//   apply (hot-reload | restart | rebuild+install) → health check →
//   keep or roll back → record
//
// It reuses the existing pieces instead of duplicating them: the architecture
// index, the impact engine, the sandbox, electron/builder-run.cjs for real
// builds and the same backup/restore style as electron/importer.cjs.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { Worker } = require("node:worker_threads");

const impact = require("./impact.cjs");
const sandbox = require("./sandbox.cjs");
const buildRunner = require("./builder-run.cjs");
const archIndex = require("./architecture-index.cjs");

const WIN = process.platform === "win32";
const HISTORY_FILE = path.join("database", "self-maintenance.json");
const MAX_HISTORY = 60;

let ctx = { root: null, send: () => {}, log: () => {}, health: async () => ({ ok: true }) };
let index = null;
let indexing = null;
let pending = new Map(); // id → assessment record
let history = [];
let queue = new Map(); // rel → change (debounced)
let queueTimer = null;
let busy = false;

const emit = (channel, payload) => {
  try {
    ctx.send(channel, payload);
  } catch {
    /* window gone */
  }
};

const newId = (prefix) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/* --------------------------------------------------------------- history -- */

function historyFile(root) {
  return path.join(root, HISTORY_FILE);
}

function loadHistory(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(historyFile(root), "utf8"));
    history = Array.isArray(parsed) ? parsed.slice(0, MAX_HISTORY) : [];
  } catch {
    history = [];
  }
  return history;
}

function record(entry) {
  history.unshift({ ...entry, at: entry.at || Date.now() });
  history = history.slice(0, MAX_HISTORY);
  if (ctx.root) {
    try {
      fs.mkdirSync(path.dirname(historyFile(ctx.root)), { recursive: true });
      fs.writeFileSync(historyFile(ctx.root), JSON.stringify(history, null, 2));
    } catch {
      /* history is best-effort */
    }
  }
  emit("self:record", entry);
  return entry;
}

/* ----------------------------------------------------------------- index -- */

/** Build the index in a worker thread so the window never blocks. */
function buildIndexAsync(root) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "scan-worker.cjs"), {
      workerData: { root, job: "index" },
    });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(result);
    };
    worker.once("message", (message) =>
      message?.ok
        ? finish(null, message.result)
        : finish(new Error(message?.error || "index failed")),
    );
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) => {
      if (code !== 0) finish(new Error(`Index worker stopped (${code})`));
    });
  });
}

/**
 * Load the stored index, or build a fresh one. On boot the stored index is
 * diffed against disk so changes made while FRIDAY was closed are detected.
 */
async function ensureIndex({ root = ctx.root, rebuild = false } = {}) {
  if (!root) return null;
  if (index && index.root === root && !rebuild) return index;
  if (indexing) return indexing;
  indexing = (async () => {
    const stored = rebuild ? null : archIndex.loadIndex(root);
    const built = stored || (await buildIndexAsync(root));
    index = built;
    archIndex.saveIndex(index);
    emit("self:index", summarizeIndex());
    indexing = null;
    return index;
  })();
  return indexing;
}

function summarizeIndex() {
  if (!index) return null;
  const areas = {};
  for (const info of Object.values(index.files)) areas[info.area] = (areas[info.area] || 0) + 1;
  return {
    at: index.at,
    root: index.root,
    totals: index.totals,
    areas,
    entryPoints: index.entryPoints,
    broken: (index.broken || []).slice(0, 20),
    externals: (index.externals || []).length,
  };
}

/**
 * Compare every indexed file against disk. Used at boot to catch offline edits.
 */
async function detectOfflineChanges(root = ctx.root) {
  const current = await ensureIndex({ root });
  if (!current) return [];
  const relatives = new Set(Object.keys(current.files));
  // Newly added files are found by re-walking cheaply through the index build
  // only when the folder count changed; otherwise the stored list is enough.
  const { changes } = archIndex.updateIndex(current, [...relatives]);
  if (changes.length) archIndex.saveIndex(current);
  return changes;
}

/* ---------------------------------------------------------------- detect -- */

/** Called by the workspace watcher. Bursts collapse into one assessment. */
function noteChange(change) {
  if (!ctx.root) return;
  const rel = String(change.path || `${change.component || ""}/${change.file || ""}`)
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!rel || rel.includes("temporary/") || rel.includes("backups/") || rel.includes("database/")) {
    return;
  }
  queue.set(rel, { path: rel, state: "changed" });
  if (queueTimer) return;
  queueTimer = setTimeout(() => {
    queueTimer = null;
    const batch = [...queue.values()];
    queue.clear();
    void assessBatch(batch).catch((error) => ctx.log?.(`self-maintenance: ${error.message}`));
  }, 1500);
}

/** Update the index for a batch and publish the impact verdict. */
async function assessBatch(batch) {
  const current = await ensureIndex({});
  if (!current) return null;
  const { changes } = archIndex.updateIndex(
    current,
    batch.map((c) => c.path),
  );
  if (!changes.length) return null;
  archIndex.saveIndex(current);

  const assessment = impact.assess({ index: current, changes, root: ctx.root });
  const entry = {
    id: newId("impact"),
    ...assessment,
    state: assessment.verdict === "blocked" ? "blocked" : "pending",
  };
  pending.set(entry.id, entry);
  emit("self:impact", entry);
  emit("self:index", summarizeIndex());
  record({
    id: entry.id,
    kind: "detect",
    verdict: entry.verdict,
    summary: entry.summary,
    files: entry.files.length,
  });
  return entry;
}

/* ---------------------------------------------------------------- backup -- */

const TOP = (rel) => rel.split("/")[0];

/** Snapshot every top-level folder the change touches. */
function backupAreas(root, files) {
  const tops = [...new Set(files.map((f) => TOP(f.path)).filter(Boolean))];
  const dir = path.join(root, "backups", `self-${Date.now().toString(36)}`);
  const saved = [];
  for (const top of tops) {
    const source = path.join(root, top);
    if (!fs.existsSync(source)) continue;
    const target = path.join(dir, top);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(source, target, { recursive: true });
      saved.push(top);
    } catch (error) {
      return { ok: false, error: `Backup of ${top} failed: ${error.message}` };
    }
  }
  return { ok: true, dir, entries: saved };
}

function restoreBackup({ root, backup }) {
  if (!backup?.dir || !fs.existsSync(backup.dir)) {
    return { ok: false, error: "No backup is available for this change." };
  }
  try {
    for (const top of backup.entries || fs.readdirSync(backup.dir)) {
      const from = path.join(backup.dir, top);
      const to = path.join(root, top);
      fs.rmSync(to, { recursive: true, force: true });
      fs.cpSync(from, to, { recursive: true });
    }
    return { ok: true, restored: backup.entries || [] };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

/* ----------------------------------------------------------------- apply -- */

function runBuild(kind, onProgress) {
  return new Promise((resolve) => {
    const started = buildRunner.startBuild({
      kind,
      context: ctx.buildContext ? ctx.buildContext() : { projectRoot: ctx.root },
      onProgress: (progress) => {
        onProgress(progress);
        if (progress.status === "done")
          resolve({ ok: true, artifact: progress.artifact, artifacts: progress.artifacts });
        else if (progress.status === "error") resolve({ ok: false, error: progress.step });
      },
    });
    if (!started.ok) resolve({ ok: false, error: started.error });
  });
}

/** Run the produced NSIS installer silently over the current install. */
function installSilently(installer) {
  return new Promise((resolve) => {
    if (!WIN || !installer || !/\.exe$/i.test(installer)) {
      resolve({ ok: false, error: "A Windows installer is required for an in-place upgrade." });
      return;
    }
    const child = spawn(installer, ["/S", "--updated"], { detached: true, windowsHide: true });
    child.on("error", (error) => resolve({ ok: false, error: error.message }));
    child.unref();
    resolve({ ok: true, installer });
  });
}

/**
 * Adopt a detected change.
 * Every verdict — including hot-reload — passes the approval gate first;
 * `mode` only records who approved it. Nothing self-applies silently.
 */
async function apply({ id, mode = "manual", onProgress = () => {} } = {}) {
  const entry = pending.get(id);
  if (!entry) return { ok: false, error: "That change is no longer pending." };
  if (busy) return { ok: false, error: "Another self-maintenance run is already in progress." };
  if (entry.verdict === "blocked") {
    return {
      ok: false,
      error: `Blocked: ${entry.blockers.map((b) => `${b.file} — ${b.reason}`).join("; ")}`,
    };
  }
  const root = ctx.root;
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };

  busy = true;
  const step = (stage, status, detail) => {
    const payload = { id, stage, status, detail, at: Date.now() };
    onProgress(payload);
    emit("self:progress", payload);
  };

  try {
    entry.state = "running";
    step("backup", "running", "Snapshotting affected folders");
    const backup = backupAreas(root, entry.files);
    if (!backup.ok) {
      step("backup", "failed", backup.error);
      entry.state = "failed";
      record({ id, kind: "apply", verdict: entry.verdict, ok: false, summary: backup.error });
      return { ok: false, error: backup.error };
    }
    step("backup", "done", `${backup.entries.length} folder(s) backed up`);

    step("sandbox", "running", "Verifying the change in an isolated clone");
    const verification = await sandbox.verify({
      root,
      areas: entry.areas,
      onProgress: (p) => step("sandbox", "running", p.step),
    });
    const failedChecks = (verification.checks || []).filter((c) => !c.ok);
    if (!verification.ok) {
      step("sandbox", "failed", failedChecks.map((c) => `${c.label}: ${c.detail}`).join(" · "));
      entry.state = "failed";
      entry.verification = verification;
      record({
        id,
        kind: "apply",
        verdict: entry.verdict,
        ok: false,
        summary: `Sandbox verification failed (${failedChecks.map((c) => c.label).join(", ")})`,
      });
      return { ok: false, error: "Sandbox verification failed.", verification, backup };
    }
    step("sandbox", "done", `${verification.checks.length} check(s) passed`);
    entry.verification = verification;

    // Owner decision: EVERY self-change stops for approval — including
    // hot-reloadable ones. There is no silent path. The renderer owns the
    // prompt; the approved decision arrives here as `mode`.
    if (mode === "manual") {
      step("approval", "done", "approved by user");
    } else {
      step("approval", "done", `approved by user (${entry.verdict})`);
    }

    let restartRequired = false;
    let artifact = null;

    if (entry.verdict === "hot-reload") {
      step("apply", "done", "Workspace components reloaded in place");
      emit("workspace:hot-reload", { areas: entry.areas, files: entry.files.length });
    } else if (entry.verdict === "restart") {
      step("apply", "done", "Runtime code updated — restart required");
      restartRequired = true;
    } else {
      step("build", "running", "Rebuilding the Windows application");
      const build = await runBuild("exe", (progress) =>
        step("build", "running", `${progress.progress}% · ${progress.step}`),
      );
      if (!build.ok) {
        step("build", "failed", build.error || "build failed");
        const rolled = restoreBackup({ root, backup });
        entry.state = "rolled-back";
        record({
          id,
          kind: "apply",
          verdict: entry.verdict,
          ok: false,
          summary: `Build failed — ${rolled.ok ? "rolled back" : "rollback failed"}`,
        });
        return { ok: false, error: build.error, rolledBack: rolled.ok, backup };
      }
      artifact = build.artifact;
      step("build", "done", artifact ? path.basename(artifact) : "build finished");
      step("install", "running", "Installing the new version over the current one");
      const installed = await installSilently(artifact);
      if (!installed.ok) {
        step("install", "failed", installed.error);
        entry.state = "needs-install";
        record({
          id,
          kind: "apply",
          verdict: entry.verdict,
          ok: false,
          summary: installed.error,
          artifact,
        });
        return { ok: false, error: installed.error, artifact, backup };
      }
      step("install", "done", "Installer launched — FRIDAY restarts when it finishes");
      restartRequired = true;
    }

    step("health", "running", "Running the post-change health check");
    const health = await ctx.health();
    if (!health.ok) {
      step("health", "failed", health.detail || "health check failed");
      const rolled = restoreBackup({ root, backup });
      entry.state = "rolled-back";
      record({
        id,
        kind: "apply",
        verdict: entry.verdict,
        ok: false,
        summary: `Health check failed — ${rolled.ok ? "rolled back" : "rollback failed"}`,
      });
      return {
        ok: false,
        error: health.detail || "Health check failed.",
        rolledBack: rolled.ok,
        backup,
      };
    }
    step("health", "done", health.detail || "all health probes passed");

    entry.state = "applied";
    entry.backup = backup;
    pending.delete(id);
    record({
      id,
      kind: "apply",
      verdict: entry.verdict,
      ok: true,
      summary: entry.summary,
      backup: backup.dir,
      artifact,
    });
    return {
      ok: true,
      verdict: entry.verdict,
      backup,
      artifact,
      restartRequired,
      verification,
      health,
    };
  } catch (error) {
    entry.state = "failed";
    const message = String(error.message || error);
    record({ id, kind: "apply", verdict: entry.verdict, ok: false, summary: message });
    return { ok: false, error: message };
  } finally {
    busy = false;
  }
}

function rollback({ backup }) {
  if (!ctx.root) return { ok: false, error: "No FRIDAY workspace is selected." };
  const result = restoreBackup({ root: ctx.root, backup });
  record({
    id: newId("rollback"),
    kind: "rollback",
    ok: result.ok,
    summary: result.ok ? `Restored ${(result.restored || []).join(", ")}` : result.error,
  });
  return result;
}

/* ------------------------------------------------------------------ state -- */

function snapshot() {
  return {
    root: ctx.root,
    busy,
    index: summarizeIndex(),
    pending: [...pending.values()],
    history,
  };
}

/**
 * Verify the workspace WITHOUT applying anything.
 *
 * Same sandbox checks the apply path runs (typecheck, lint, tests), used by
 * the self-development pipeline to compare a candidate against the current
 * known-good baseline before the owner is ever asked to approve it.
 */
async function verifyOnly({ areas = [], onProgress = () => {} } = {}) {
  const root = ctx.root;
  if (!root) return { ok: false, checks: [], error: "No FRIDAY workspace is selected." };
  if (busy) {
    return { ok: false, checks: [], error: "Another self-maintenance run is already in progress." };
  }
  busy = true;
  try {
    return await sandbox.verify({
      root,
      areas,
      onProgress: (p) => {
        const payload = {
          id: "verify",
          stage: "sandbox",
          status: "running",
          detail: p.step,
          at: Date.now(),
        };
        onProgress(payload);
        emit("self:progress", payload);
      },
    });
  } catch (error) {
    return { ok: false, checks: [], error: String(error.message || error) };
  } finally {
    busy = false;
  }
}

/**
 * Wire the module up once, from the Electron main process.
 * `health` must return { ok, detail } using the real doctor/kernel probes.
 */
function init(options) {
  ctx = { ...ctx, ...options };
  if (ctx.root) loadHistory(ctx.root);
  pending = new Map();
  index = null;
  return snapshot();
}

module.exports = {
  init,
  ensureIndex,
  detectOfflineChanges,
  noteChange,
  assessBatch,
  apply,
  verifyOnly,
  rollback,
  snapshot,
  summarizeIndex,
  loadHistory,
};
