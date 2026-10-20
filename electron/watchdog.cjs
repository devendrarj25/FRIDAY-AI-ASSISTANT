/**
 * One stall record for the Doctor. Recovery of a dead kernel stays on the
 * lifecycle owner. A frozen window is reloaded by that same owner.
 * This module does not spawn or kill a process.
 */
const MAX = 20;
const FREEZE_GRACE_MS = 8000;
const LOOP_INTERVAL_MS = 500;
const LOOP_STALL_MS = 2000;
const HEARTBEAT_MISS_MS = 15_000;
const notes = [];
const KINDS = new Set(["window", "kernel", "event-loop", "heartbeat"]);

function note(entry = {}) {
  const kind = KINDS.has(entry.kind) ? entry.kind : entry.kind === "window" ? "window" : "kernel";
  const row = {
    at: Date.now(),
    kind,
    detail: String(entry.detail || "").slice(0, 180),
  };
  notes.unshift(row);
  if (notes.length > MAX) notes.length = MAX;
  return row;
}

function snapshot() {
  return notes.slice();
}

function planRecovery(row) {
  if (!row) return { recover: false, owner: "lifecycle", action: "none" };
  if (row.kind === "kernel") {
    return { recover: true, owner: "lifecycle", action: "restart-kernel" };
  }
  return { recover: false, owner: "lifecycle", action: "report" };
}

/**
 * Renderer freeze. Long IPC work waits. Otherwise the lifecycle owner
 * reloads the page after a grace period. No process is killed.
 */
function planFreezeRecovery(input = {}) {
  if (input.responsive === true) {
    return {
      recover: false,
      owner: "lifecycle",
      action: "none",
      killsProcesses: false,
      reason: "responsive",
    };
  }
  if (input.longWork) {
    return {
      recover: false,
      owner: "lifecycle",
      action: "wait",
      killsProcesses: false,
      reason: "long work in flight",
    };
  }
  const elapsed = Number(input.elapsedMs) || 0;
  if (elapsed < FREEZE_GRACE_MS) {
    return {
      recover: false,
      owner: "lifecycle",
      action: "grace",
      killsProcesses: false,
      reason: "grace period",
    };
  }
  return {
    recover: true,
    owner: "lifecycle",
    action: "reload-renderer",
    killsProcesses: false,
    reason: "reload the renderer",
  };
}

function createLoopMonitor(options = {}) {
  const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : LOOP_INTERVAL_MS;
  const stallMs = Number(options.stallMs) > 0 ? Number(options.stallMs) : LOOP_STALL_MS;
  const now = options.now || Date.now;
  const setTimer = options.setInterval || setInterval;
  const clearTimer = options.clearInterval || clearInterval;
  let last = now();
  let lag = 0;
  const timer = setTimer(() => {
    const t = now();
    lag = Math.max(0, t - last - intervalMs);
    last = t;
    if (lag >= stallMs && typeof options.onLag === "function") options.onLag(lag);
  }, intervalMs);
  if (timer && typeof timer.unref === "function") timer.unref();
  return {
    lag: () => lag,
    stop: () => clearTimer(timer),
  };
}

function createHeartbeat(options = {}) {
  const now = options.now || Date.now;
  const missMs = Number(options.missMs) > 0 ? Number(options.missMs) : HEARTBEAT_MISS_MS;
  let last = now();
  return {
    beat(at) {
      last = Number.isFinite(at) ? at : now();
    },
    age(at) {
      return (Number.isFinite(at) ? at : now()) - last;
    },
    stalled(at) {
      return this.age(at) > missMs;
    },
  };
}

function watchWindow(win, hooks = {}) {
  const now = hooks.now || Date.now;
  const setTimer = hooks.setTimeout || setTimeout;
  const clearTimer = hooks.clearTimeout || clearTimeout;
  let since = 0;
  let timer = null;
  let responsive = true;
  const tick = () => {
    timer = null;
    const plan = planFreezeRecovery({
      responsive,
      elapsedMs: now() - since,
      longWork: typeof hooks.longWork === "function" ? Boolean(hooks.longWork()) : false,
    });
    if (!responsive && (plan.action === "wait" || plan.action === "grace")) {
      timer = setTimer(tick, FREEZE_GRACE_MS);
      return;
    }
    if (plan.recover && typeof hooks.recover === "function") hooks.recover(plan);
  };
  const onUnresponsive = () => {
    responsive = false;
    since = now();
    note({ kind: "window", detail: "renderer unresponsive" });
    if (timer) clearTimer(timer);
    timer = setTimer(tick, FREEZE_GRACE_MS);
  };
  const onResponsive = () => {
    responsive = true;
    if (timer) clearTimer(timer);
    timer = null;
    note({ kind: "window", detail: "renderer responsive" });
  };
  if (win && typeof win.on === "function") {
    win.on("unresponsive", onUnresponsive);
    win.on("responsive", onResponsive);
  }
  return {
    onUnresponsive,
    onResponsive,
    stop() {
      if (timer) clearTimer(timer);
      if (win && typeof win.removeListener === "function") {
        win.removeListener("unresponsive", onUnresponsive);
        win.removeListener("responsive", onResponsive);
      }
    },
  };
}

let loop = null;
let heart = null;
let heartTimer = null;
let freezeSince = 0;

function start(hooks = {}) {
  if (loop) return;
  const now = hooks.now || Date.now;
  heart = createHeartbeat({ now, missMs: HEARTBEAT_MISS_MS });
  heart.beat(now());
  loop = createLoopMonitor({
    now,
    onLag(lag) {
      note({ kind: "event-loop", detail: `event loop lag ${lag}ms` });
    },
  });
  const setTimer = hooks.setInterval || setInterval;
  heartTimer = setTimer(() => {
    if (!heart || !heart.stalled(now())) {
      freezeSince = 0;
      return;
    }
    if (!freezeSince) freezeSince = now();
    note({ kind: "heartbeat", detail: "renderer heartbeat missed" });
    const plan = planFreezeRecovery({
      responsive: false,
      elapsedMs: now() - freezeSince,
      longWork: typeof hooks.longWork === "function" ? Boolean(hooks.longWork()) : false,
    });
    if (plan.recover && typeof hooks.recover === "function") {
      hooks.recover(plan);
      if (heart) heart.beat(now());
      freezeSince = 0;
    } else if (plan.action === "wait") freezeSince = now();
  }, 5000);
  if (heartTimer && typeof heartTimer.unref === "function") heartTimer.unref();
}

function beat(at) {
  if (heart) heart.beat(at);
  else note({ kind: "heartbeat", detail: "renderer heartbeat" });
}

function stop() {
  if (loop) loop.stop();
  loop = null;
  if (heartTimer) clearInterval(heartTimer);
  heartTimer = null;
  heart = null;
  freezeSince = 0;
}

function doctorCheck() {
  const latest = notes[0];
  if (!latest) {
    return {
      id: "watchdog:stall",
      label: "Window and kernel watchdog",
      group: "FRIDAY",
      status: "Ready",
      detail: "No stall recorded.",
      fixable: false,
    };
  }
  const plan = planRecovery(latest);
  return {
    id: "watchdog:stall",
    label: "Window and kernel watchdog",
    group: "FRIDAY",
    status: "Warning",
    detail: `${latest.kind}: ${latest.detail}. Recovery owner: ${plan.owner} (${plan.action}).`,
    fixable: false,
  };
}

module.exports = {
  FREEZE_GRACE_MS,
  LOOP_STALL_MS,
  HEARTBEAT_MISS_MS,
  note,
  snapshot,
  planRecovery,
  planFreezeRecovery,
  createLoopMonitor,
  createHeartbeat,
  watchWindow,
  start,
  beat,
  stop,
  doctorCheck,
};
