/**
 * One owner for start, hide, restart, and exit.
 * Only processes FRIDAY started are stopped. The owner's own runtimes stay up.
 *
 * Electron's app.exit(code) closes windows immediately and does not emit
 * before-quit or will-quit. A caller that fires quit and then exit
 * in the same turn leaves the quit cleanup unfinished. This module awaits
 * cleanup, then exits once.
 */

const { spawn, execFile, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const GRACE_MS = 5000;
const KERNEL_WAIT_MS = 3500;
const SESSION_GRACE_MS = 2500;
const RESTART_WAIT_MS = 8000;

const APP_RESTART = "app_restart";
const APP_SHUTDOWN = "app_shutdown";

const OWNED_ROLES = new Set([
  "microphone",
  "downloads",
  "tasks",
  "kernel",
  "stt",
  "tts",
  "wake",
  "browser",
  "sandbox",
  "terminal",
  "runner",
  "tray",
  "windows",
]);

const SHUTDOWN_ORDER = [
  "microphone",
  // The page's last settings and state go to disk before anything it talks to is stopped: its save delay may
  // not have fired, and destroying the window does not run its page-hide handlers reliably.
  "flush",
  "downloads",
  "tasks",
  "runner",
  "plugins",
  "browser",
  "kernel",
  "stt",
  "tts",
  "wake",
  "sandbox",
  "terminal",
  "tray",
  "windows",
  "lock",
  "exit",
];

function isAppControl(name) {
  const tool = String(name || "");
  return tool === APP_RESTART || tool === APP_SHUTDOWN;
}

function alwaysAsk(name) {
  return isAppControl(name);
}

/** The owner's own local engines. FRIDAY did not start these. */
function isOwnerRuntime(command) {
  return /ollama|lm[\s-]?studio|lms\.exe/i.test(String(command || ""));
}

function shouldStop(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (isOwnerRuntime(entry.command)) return false;
  return OWNED_ROLES.has(String(entry.role || ""));
}

function processesToStop(list) {
  return (Array.isArray(list) ? list : []).filter(shouldStop);
}

/**
 * Stop every process of one program by image name (Windows only), for a tool
 * FRIDAY started whose children cannot be walked from one pid. Only the tool
 * service module calls it, and only for a service it started itself.
 */
function killImage(name, options = {}) {
  const image = String(name || "");
  if (!/^[\w.-]+\.exe$/i.test(image)) return false;
  if ((options.platform || process.platform) !== "win32") return false;
  try {
    const child = (options.spawn || spawn)("taskkill", ["/F", "/IM", image], {
      windowsHide: true,
      stdio: "ignore",
    });
    if (child && typeof child.unref === "function") child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Signal a pid FRIDAY started and wait until it is gone, or the deadline passes. */
async function waitForProcessGone(pid, options = {}) {
  const id = Number(pid);
  const alive = options.alive || pidAlive;
  const kill = options.kill || ((target) => killProcessTree(target, options));
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || 8000);
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  if (!Number.isFinite(id) || id <= 0) return { gone: true, waited: false };
  const started = Date.now();
  if (alive(id)) {
    try {
      kill(id);
    } catch {
      /* the poll below is the result */
    }
  }
  while (alive(id) && Date.now() - started < timeoutMs) {
    await sleep(100);
  }
  return { gone: !alive(id), waited: true };
}

function shutdownPlan() {
  return {
    order: SHUTDOWN_ORDER.slice(),
    graceMs: GRACE_MS,
    kernelWaitMs: KERNEL_WAIT_MS,
    relaunch: false,
  };
}

function restartPlan() {
  return {
    order: SHUTDOWN_ORDER.filter((step) => step !== "exit"),
    graceMs: GRACE_MS,
    kernelWaitMs: KERNEL_WAIT_MS,
    relaunch: "after-owned-exit",
  };
}

function pidAlive(pid) {
  const id = Number(pid);
  if (!Number.isFinite(id) || id <= 0) return false;
  try {
    process.kill(id, 0);
    return true;
  } catch {
    return false;
  }
}

function atomSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, Number(ms) || 0));
}

/**
 * Whole-tree stop. Windows uses taskkill /T. Other platforms signal the pid.
 * A command that is the owner's own runtime is never signalled.
 */
function killProcessTree(pid, options = {}) {
  const id = Number(pid);
  if (!Number.isFinite(id) || id <= 0) return false;
  if (options.command && isOwnerRuntime(options.command)) return false;
  const platform = options.platform || process.platform;
  if (platform === "win32") {
    try {
      const spawnImpl = options.spawn || spawn;
      const child = spawnImpl("taskkill", ["/pid", String(id), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      if (child && typeof child.unref === "function") child.unref();
      return true;
    } catch {
      return false;
    }
  }
  try {
    const killImpl = options.kill || ((target, signal) => process.kill(target, signal));
    killImpl(id, options.signal || "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop a child this app started. On Windows `child.kill()` ends only that one process, so a shell, `npx`, a Python
 * launcher or an installer would leave what it started still running: the whole tree goes there. Elsewhere the signal
 * is sent to the child. Never throws.
 */
function stopChild(child, signal, options = {}) {
  if (!child) return false;
  const platform = options.platform || process.platform;
  try {
    if (platform === "win32" && child.pid) return killProcessTree(child.pid, options);
    return child.kill(signal) !== false;
  } catch {
    return false;
  }
}

function normalizeImage(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, "");
}

const READ_TIMEOUT_MS = 4000;
const WIN_PROBE_FIELDS =
  "$_.Id.ToString() + '|' + $_.ProcessName + '|' + $(try { $_.StartTime.ToUniversalTime().Ticks } catch { '' })";

/** Parse the "name|ticks" answer of one Get-Process probe. */
function parseWindowsIdentity(raw) {
  const out = String(raw).trim();
  if (!out) return null;
  const cut = out.lastIndexOf("|");
  if (cut <= 0 || cut === out.length - 1) return undefined;
  return { image: out.slice(0, cut), startTime: out.slice(cut + 1) };
}

/** Parse /proc/<pid>/stat: the image is the "(comm)" field, the start tick is field 22. */
function parseProcStat(stat) {
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  if (open < 0 || close < open) return undefined;
  const fields = stat
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  // After the "(comm)" field the state is field 3, so the start time (field 22) sits at index 19.
  const started = fields[19];
  if (!started) return undefined;
  return { image: stat.slice(open + 1, close), startTime: started };
}

const PS_LINE = /^(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/;

function parsePsIdentity(raw) {
  const out = String(raw).trim();
  if (!out) return null;
  const match = PS_LINE.exec(out);
  if (!match) return undefined;
  return { image: path.basename(match[2]), startTime: match[1] };
}

/** A missing pid is reported by `ps` and Get-Process as exit code 1 or an empty list; anything else is unreadable. */
function missingOrUnreadable(error) {
  const code = error && (error.status !== undefined ? error.status : error.code);
  return code === 1 ? null : undefined;
}

function windowsProbe(id) {
  return (
    `$p = Get-Process -Id ${id} -ErrorAction SilentlyContinue; ` +
    "if ($p) { $p.ProcessName + '|' + $p.StartTime.ToUniversalTime().Ticks }"
  );
}

const WIN_ARGS = (script) => ["-NoProfile", "-NonInteractive", "-Command", script];
const RUN_OPTIONS = {
  encoding: "utf8",
  windowsHide: true,
  timeout: READ_TIMEOUT_MS,
  stdio: ["ignore", "pipe", "ignore"],
};
const PS_OPTIONS = {
  encoding: "utf8",
  timeout: READ_TIMEOUT_MS,
  stdio: ["ignore", "pipe", "ignore"],
};

/**
 * Read one process's identity: the program image name and the time it started. A pid alone is not an identity,
 * because the system hands a finished process's pid to the next program that starts.
 * Returns { image, startTime } for a live process, null when no such process exists, and undefined when the
 * table cannot be read here. Windows reads the process list through PowerShell (name and creation time);
 * Linux reads /proc/<pid>/stat; other systems use ps. Tests inject their own table instead of calling this.
 */
function inspectProcess(pid, options = {}) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return null;
  const platform = options.platform || process.platform;
  try {
    if (platform === "win32") {
      const run = options.execFile || execFileSync;
      return parseWindowsIdentity(run("powershell.exe", WIN_ARGS(windowsProbe(id)), RUN_OPTIONS));
    }
    if (platform === "linux") {
      const read = options.readFile || ((file) => fs.readFileSync(file, "utf8"));
      let stat;
      try {
        stat = String(read(`/proc/${id}/stat`));
      } catch (error) {
        return error && error.code === "ENOENT" ? null : undefined;
      }
      return parseProcStat(stat);
    }
    const run = options.execFile || execFileSync;
    return parsePsIdentity(run("ps", ["-o", "lstart=,comm=", "-p", String(id)], PS_OPTIONS));
  } catch (error) {
    return missingOrUnreadable(error);
  }
}

/**
 * The same read as inspectProcess, but it never blocks the caller: PowerShell and ps run through an asynchronous
 * execFile with the same timeout (a timeout answers undefined), and /proc is read without waiting on the thread.
 * track() uses it so a spawn never waits for the process table.
 */
async function inspectProcessAsync(pid, options = {}) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return null;
  const platform = options.platform || process.platform;
  const run =
    options.execFileAsync ||
    ((cmd, args, opts) =>
      new Promise((resolve, reject) => {
        execFile(cmd, args, opts, (error, stdout) => (error ? reject(error) : resolve(stdout)));
      }));
  try {
    if (platform === "win32") {
      return parseWindowsIdentity(
        await run("powershell.exe", WIN_ARGS(windowsProbe(id)), RUN_OPTIONS),
      );
    }
    if (platform === "linux") {
      const read = options.readFileAsync || ((file) => fs.promises.readFile(file, "utf8"));
      let stat;
      try {
        stat = String(await read(`/proc/${id}/stat`));
      } catch (error) {
        return error && error.code === "ENOENT" ? null : undefined;
      }
      return parseProcStat(stat);
    }
    return parsePsIdentity(await run("ps", ["-o", "lstart=,comm=", "-p", String(id)], PS_OPTIONS));
  } catch (error) {
    return missingOrUnreadable(error);
  }
}

/**
 * Read the identity of several pids in ONE call (Windows: one Get-Process; others: one ps, or one /proc pass).
 * Returns a Map pid -> { image, startTime } | null (no such process) | undefined (this pid cannot be read), or
 * undefined when the whole table cannot be read. Used at stop, so quitting costs one process-table read, not one per row.
 */
function inspectProcesses(pids, options = {}) {
  const ids = [...new Set((Array.isArray(pids) ? pids : []).map(Number))].filter(
    (id) => Number.isInteger(id) && id > 0,
  );
  const result = new Map();
  if (!ids.length) return result;
  const platform = options.platform || process.platform;
  if (platform === "linux") {
    for (const id of ids) result.set(id, inspectProcess(id, options));
    return result;
  }
  try {
    const run = options.execFile || execFileSync;
    if (platform === "win32") {
      const script = `Get-Process -Id ${ids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { ${WIN_PROBE_FIELDS} }`;
      const out = String(run("powershell.exe", WIN_ARGS(script), RUN_OPTIONS));
      for (const id of ids) result.set(id, null);
      for (const line of out.split(/\r?\n/)) {
        const first = line.indexOf("|");
        const last = line.lastIndexOf("|");
        const id = Number(line.slice(0, first));
        if (first <= 0 || !result.has(id)) continue;
        const image = line.slice(first + 1, last).trim();
        const startTime = line.slice(last + 1).trim();
        result.set(id, last > first && image && startTime ? { image, startTime } : undefined);
      }
      return result;
    }
    let out = "";
    try {
      out = String(run("ps", ["-o", "pid=,lstart=,comm=", "-p", ids.join(",")], PS_OPTIONS));
    } catch (error) {
      if (missingOrUnreadable(error) !== null) return undefined;
    }
    for (const id of ids) result.set(id, null);
    for (const line of out.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (!match || !result.has(Number(match[1]))) continue;
      result.set(Number(match[1]), parsePsIdentity(match[2]));
    }
    return result;
  } catch {
    return undefined;
  }
}

/** The program a recorded command starts: a quoted path, a path ending in .exe (spaces allowed), or its first word. */
function commandImage(command) {
  const text = String(command || "").trim();
  if (!text) return "";
  const quoted = /^"([^"]+)"|^'([^']+)'/.exec(text);
  let first = quoted ? quoted[1] || quoted[2] : "";
  if (!first) {
    const exe = /^(.+?\.exe)(?:\s|$)/i.exec(text);
    first = exe ? exe[1] : text.split(/\s+/)[0];
  }
  return first.split(/[\\/]/).pop() || "";
}

/** True only when the live process is the one that was recorded: both image and start time match. */
function sameIdentity(row, live) {
  return (
    !!live &&
    normalizeImage(live.image) === normalizeImage(row.image) &&
    String(live.startTime) === String(row.startTime)
  );
}

/**
 * The pids FRIDAY started and still owns. Options: `inspectProcess(pid)` is one injected synchronous table (tests);
 * `inspectProcessAsync(pid)` and `inspectProcesses(pids)` override the asynchronous read at track() and the single
 * read at stop. With only `inspectProcess` given, the other two are derived from it.
 */
function createPidRegistry({
  file,
  fsImpl = fs,
  inspectProcess: inspectOne,
  inspectProcessAsync: inspectAsyncOption,
  inspectProcesses: inspectManyOption,
} = {}) {
  const rows = new Map();
  const pending = new Set();
  const inspectAsync =
    inspectAsyncOption || (inspectOne ? async (pid) => inspectOne(pid) : inspectProcessAsync);
  const inspectMany =
    inspectManyOption ||
    (inspectOne ? (pids) => new Map(pids.map((pid) => [pid, inspectOne(pid)])) : inspectProcesses);

  function save() {
    if (!file) return;
    try {
      fsImpl.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fsImpl.writeFileSync(tmp, JSON.stringify({ pids: [...rows.values()] }));
      fsImpl.renameSync(tmp, file);
    } catch {
      /* the registry is best-effort and must not block shutdown */
    }
  }

  function load() {
    rows.clear();
    if (!file) return;
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(file, "utf8"));
      const list = Array.isArray(parsed) ? parsed : parsed && parsed.pids;
      for (const row of Array.isArray(list) ? list : []) {
        const pid = Number(row && row.pid);
        if (pid) rows.set(pid, { ...row, pid });
      }
    } catch {
      rows.clear();
    }
  }

  load();

  function track(role, child, command) {
    const pid = Number(child && child.pid);
    if (!pid) return false;
    const row = { role: String(role || ""), command: String(command || ""), pid };
    if (isOwnerRuntime(row.command)) return false;
    rows.set(pid, row);
    save();
    // The identity is read in the background: track() never waits on the process table, and the row is
    // completed (and the file rewritten) when the read returns. A row stopped before that has no identity.
    const read = Promise.resolve()
      .then(() => inspectAsync(pid))
      .then((identity) => {
        if (rows.get(pid) !== row || !identity || !identity.image || !identity.startTime) return;
        row.image = String(identity.image);
        row.startTime = String(identity.startTime);
        save();
      })
      .catch(() => {
        /* an unreadable table leaves the row without identity; stop treats it as unreadable */
      })
      .finally(() => pending.delete(read));
    pending.add(read);
    if (child && typeof child.once === "function") {
      child.once("exit", () => {
        rows.delete(pid);
        save();
      });
    }
    return true;
  }

  function forget(pid) {
    rows.delete(Number(pid));
    save();
  }

  function list() {
    return [...rows.values()];
  }

  /**
   * A row is killed only while the process under its pid is the one that was recorded. With an identity, image and
   * start time must both match. A row with no identity (written by an older version, or its read timed out) is
   * killed only when the live image is the program named by row.command. A different process, or none, means the
   * pid was reused or the process ended: the row is dropped and nothing is signalled. A table that cannot be read
   * never kills anything.
   */
  function isRecordedProcess(row, live) {
    if (row.image && row.startTime) return sameIdentity(row, live);
    if (!live || !live.image) return false;
    const want = normalizeImage(commandImage(row.command));
    return !!want && normalizeImage(live.image) === want;
  }

  function stopMatching(predicate, kill = killProcessTree) {
    const targets = list().filter((row) => shouldStop(row) && predicate(row));
    if (!targets.length) return;
    let table;
    try {
      table = inspectMany(targets.map((row) => row.pid));
    } catch {
      table = undefined;
    }
    for (const row of targets) {
      const live = table && typeof table.get === "function" ? table.get(row.pid) : undefined;
      if (isRecordedProcess(row, live)) kill(row.pid, { command: row.command });
      rows.delete(row.pid);
    }
    save();
  }

  function stopAll(kill = killProcessTree) {
    stopMatching(() => true, kill);
  }

  function stopRole(role, kill = killProcessTree) {
    stopMatching((row) => row.role === role, kill);
  }

  /** Resolves when every background identity read started by track() has finished. */
  async function settled() {
    while (pending.size) await Promise.all([...pending]);
  }

  return { track, forget, list, stopAll, stopRole, settled, load, file };
}

let activeRegistry = null;

function usePidRegistry(registry) {
  activeRegistry = registry || null;
  return activeRegistry;
}

function trackOwned(role, child, command) {
  if (!activeRegistry) return false;
  return activeRegistry.track(role, child, command);
}

function writeOwnerPid(file, pid) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ pid: Number(pid), at: Date.now() }));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

function clearOwnerPid(file) {
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Used only after a restart flag. A normal second launch must not wait: the
 * running instance focuses its window. requestSingleInstanceLock cannot be
 * retried in the same process, so the wait happens before the lock is taken.
 */
function waitForPreviousInstance({
  file,
  budgetMs = RESTART_WAIT_MS,
  stepMs = 200,
  alive = pidAlive,
  sleep = atomSleep,
  read = null,
  now = Date.now,
} = {}) {
  const started = now();
  let waited = false;
  const readFile = read || ((target) => fs.readFileSync(target, "utf8"));
  while (now() - started < budgetMs) {
    let recorded = null;
    try {
      recorded = JSON.parse(readFile(file));
    } catch {
      return { waited, released: true };
    }
    const pid = Number(recorded && recorded.pid);
    if (!pid || !alive(pid)) return { waited, released: true };
    waited = true;
    sleep(stepMs);
  }
  return { waited: true, released: false };
}

function createLifecycle(options = {}) {
  const app = options.app || {};
  const steps = options.steps || {};
  const log = typeof options.log === "function" ? options.log : () => {};
  const graceMs = Number(options.graceMs) || GRACE_MS;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const relaunchArgs = options.relaunchArgs;
  const env = options.env || process.env;
  const exists = options.exists || require("node:fs").existsSync;
  let state = "STARTING";
  let running = false;
  let exited = false;
  const listeners = new Set();

  function note(message) {
    try {
      log(message);
    } catch {
      /* logging must not block an exit */
    }
  }

  function emit(event, detail) {
    for (const fn of listeners) {
      try {
        fn(event, detail);
      } catch {
        /* one listener cannot block the rest */
      }
    }
  }

  function setState(next) {
    state = next;
    emit("state", { state: next });
  }

  function getState() {
    return state;
  }

  function exitOnce(code) {
    if (exited) return false;
    exited = true;
    setState("EXITED");
    try {
      if (typeof app.releaseSingleInstanceLock === "function") app.releaseSingleInstanceLock();
    } catch {
      /* the process exit releases it anyway */
    }
    try {
      app.exit(code);
    } catch {
      /* already leaving */
    }
    return true;
  }

  async function runCleanup(reason) {
    const order = shutdownPlan().order.filter((step) => step !== "exit");
    for (const step of order) {
      const fn = steps[step];
      if (typeof fn !== "function") continue;
      try {
        await fn(reason);
      } catch (error) {
        note(`cleanup ${step} failed: ${error && error.message ? error.message : error}`);
      }
    }
  }

  function arm(ms, onFire) {
    const timer = setTimer(onFire, ms);
    if (timer && typeof timer.unref === "function") timer.unref();
    return timer;
  }

  async function requestShutdown(reason, opts = {}) {
    if (running || exited) return false;
    running = true;
    setState("SHUTTING_DOWN");
    try {
      app.__fridayQuitting = true;
    } catch {
      /* a fake app has no flag */
    }
    note(`shutting FRIDAY down: ${reason || "requested by the owner"}`);
    const delay = Math.max(0, Number(opts.delayMs) || 0);
    const grace = Math.max(0, Number(opts.graceMs) || graceMs);
    const code = opts.code == null ? 0 : opts.code;
    let forced = false;
    const timer = arm(grace + delay, () => {
      forced = true;
      note(`shutdown deadline (${reason || "requested"})`);
      exitOnce(code);
    });
    try {
      if (delay > 0) await new Promise((resolve) => arm(delay, resolve));
      await runCleanup(reason);
    } catch (error) {
      note(`shutdown cleanup failed: ${error && error.message ? error.message : error}`);
    }
    clearTimer(timer);
    if (!forced) exitOnce(code);
    return true;
  }

  async function requestRestart(reason, opts = {}) {
    if (running || exited) return false;
    running = true;
    setState("RESTARTING");
    try {
      app.__fridayQuitting = true;
    } catch {
      /* a fake app has no flag */
    }
    note(`restarting FRIDAY: ${reason || "requested by the owner"}`);
    const grace = Math.max(0, Number(opts.graceMs) || graceMs);
    let relaunched = false;
    let forced = false;
    const relaunchOnce = () => {
      if (relaunched) return;
      relaunched = true;
      try {
        const args = typeof relaunchArgs === "function" ? relaunchArgs() : relaunchArgs;
        // A Portable build runs from a copy unpacked into the temp folder, which
        // is removed when the launcher exits. Relaunching process.execPath would
        // start a file that is gone, so the portable launcher itself is started.
        const portable = String(env.PORTABLE_EXECUTABLE_FILE || "");
        const launcher = portable && exists(portable) ? portable : "";
        const list = Array.isArray(args) ? args : [];
        if (launcher) app.relaunch({ execPath: launcher, args: list });
        else if (list.length) app.relaunch({ args: list });
        else app.relaunch();
      } catch (error) {
        note(`relaunch failed: ${error && error.message ? error.message : error}`);
      }
    };
    const timer = arm(grace, () => {
      forced = true;
      note(`restart deadline (${reason || "requested"})`);
      relaunchOnce();
      exitOnce(0);
    });
    try {
      await runCleanup(reason);
    } catch (error) {
      note(`restart cleanup failed: ${error && error.message ? error.message : error}`);
    }
    clearTimer(timer);
    if (!forced) {
      relaunchOnce();
      exitOnce(0);
    }
    return true;
  }

  function hideToBackground() {
    if (state === "SHUTTING_DOWN" || state === "EXITED" || state === "RESTARTING") return false;
    setState("BACKGROUND");
    const fn = steps.hide;
    if (typeof fn === "function") {
      try {
        return fn() !== false;
      } catch {
        return false;
      }
    }
    return true;
  }

  function exitNow(code, reason) {
    if (exited) return false;
    running = true;
    if (state !== "EXITED") setState("SHUTTING_DOWN");
    try {
      app.__fridayQuitting = true;
    } catch {
      /* a fake app has no flag */
    }
    if (reason) note(`exit ${code}: ${reason}`);
    return exitOnce(code);
  }

  function onSessionEnd(reason) {
    return requestShutdown(reason || "session-end", { graceMs: SESSION_GRACE_MS });
  }

  function markReady() {
    if (state === "STARTING") setState("READY");
  }

  function noteVisible() {
    if (state === "BACKGROUND" || state === "STARTING") setState("READY");
  }

  function on(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /** Reload the page. Does not signal an owned process. */
  function reloadRenderer() {
    if (typeof steps.reload !== "function") {
      return { ok: false, action: "reload-renderer", killsProcesses: false };
    }
    try {
      steps.reload();
      note("reloaded the renderer");
      return { ok: true, action: "reload-renderer", killsProcesses: false };
    } catch (error) {
      return {
        ok: false,
        action: "reload-renderer",
        killsProcesses: false,
        error: String((error && error.message) || error),
      };
    }
  }

  return {
    requestShutdown,
    requestRestart,
    hideToBackground,
    exitNow,
    reloadRenderer,
    onSessionEnd,
    getState,
    markReady,
    noteVisible,
    on,
  };
}

module.exports = {
  GRACE_MS,
  KERNEL_WAIT_MS,
  SESSION_GRACE_MS,
  RESTART_WAIT_MS,
  APP_RESTART,
  APP_SHUTDOWN,
  OWNED_ROLES,
  SHUTDOWN_ORDER,
  isAppControl,
  alwaysAsk,
  isOwnerRuntime,
  shouldStop,
  processesToStop,
  shutdownPlan,
  restartPlan,
  pidAlive,
  killProcessTree,
  stopChild,
  killImage,
  waitForProcessGone,
  createPidRegistry,
  inspectProcess,
  inspectProcessAsync,
  inspectProcesses,
  usePidRegistry,
  trackOwned,
  writeOwnerPid,
  clearOwnerPid,
  waitForPreviousInstance,
  createLifecycle,
};
