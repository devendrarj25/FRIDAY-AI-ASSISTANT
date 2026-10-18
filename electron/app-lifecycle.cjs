/**
 * One owner for start, hide, restart, and exit.
 * Only processes FRIDAY started are stopped. The owner's own runtimes stay up.
 *
 * Electron's app.exit(code) closes windows immediately and does not emit
 * before-quit or will-quit. A caller that fires quit and then exit
 * in the same turn leaves the quit cleanup unfinished. This module awaits
 * cleanup, then exits once.
 */

const { spawn } = require("node:child_process");
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
  "downloads",
  "tasks",
  "runner",
  "plugins",
  "browser",
  "kernel",
  "stt",
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

function createPidRegistry({ file, fsImpl = fs } = {}) {
  const rows = new Map();

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

  function stopMatching(predicate, kill = killProcessTree) {
    for (const row of list()) {
      if (!shouldStop(row) || !predicate(row)) continue;
      if (pidAlive(row.pid)) kill(row.pid, { command: row.command });
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

  return { track, forget, list, stopAll, stopRole, load, file };
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
        if (Array.isArray(args) && args.length) app.relaunch({ args });
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

  return {
    requestShutdown,
    requestRestart,
    hideToBackground,
    exitNow,
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
  waitForProcessGone,
  createPidRegistry,
  usePidRegistry,
  trackOwned,
  writeOwnerPid,
  clearOwnerPid,
  waitForPreviousInstance,
  createLifecycle,
};
