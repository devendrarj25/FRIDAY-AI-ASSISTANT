/**
 * One shutdown and restart plan. The desktop process performs it.
 * Only processes FRIDAY started are stopped. The owner's own runtimes stay up.
 */

const GRACE_MS = 5000;
const KERNEL_WAIT_MS = 3500;

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
  "kernel",
  "stt",
  "wake",
  "browser",
  "sandbox",
  "terminal",
  "runner",
  "tray",
  "windows",
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

module.exports = {
  GRACE_MS,
  KERNEL_WAIT_MS,
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
};
