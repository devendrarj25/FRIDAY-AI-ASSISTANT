/**
 * Who gets the CPU first when the PC is busy.
 *
 * FRIDAY's own window must never wait behind her own AI work: a model that uses every core can starve the thread that
 * draws the window, and the whole app then feels frozen while the PC is nowhere near its limit. The fix is the
 * scheduler's priority, not a smaller workload:
 *
 *  - the local AI service (the Python kernel and what it starts) runs at BELOW_NORMAL. It still uses every core that
 *    nothing else wants, so a model is as fast as before on an idle PC, and it steps aside for the window, for a game
 *    and for everything else the owner is doing.
 *  - FRIDAY's window processes (main, renderer, GPU) run at ABOVE_NORMAL while the window is the one in use and go
 *    back to NORMAL when it is not, so FRIDAY never competes with a game that has the screen.
 *
 * On Windows `os.setPriority` maps to the six priority classes and raising to ABOVE_NORMAL or lowering to BELOW_NORMAL
 * needs no administrator rights (only HIGHEST does). Every call is best effort: a refused call is logged and FRIDAY
 * runs as before. FRIDAY_PRIORITY=0 turns the whole thing off.
 */
"use strict";

const os = require("node:os");

function levels(osModule = os) {
  const p = (osModule.constants && osModule.constants.priority) || {};
  return {
    below: p.PRIORITY_BELOW_NORMAL ?? 10,
    normal: p.PRIORITY_NORMAL ?? 0,
    above: p.PRIORITY_ABOVE_NORMAL ?? -7,
  };
}

function enabled(env = process.env) {
  // The CI harnesses (readiness, boot self-test) run on small hosted machines with no graphics card: nothing there
  // may change how fast the AI service starts, so the gate stays deterministic.
  if (env.FRIDAY_READINESS === "1" || env.FRIDAY_BOOT_SELFTEST) return false;
  return String(env.FRIDAY_PRIORITY ?? "1") !== "0";
}

/** Sets one process; never throws. Returns true when the call was accepted. */
function setOne(pid, level, { osModule = os, log = () => {} } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    osModule.setPriority(pid, level);
    return true;
  } catch (error) {
    log(`priority of ${pid} not changed: ${String((error && error.message) || error)}`);
    return false;
  }
}

/** The processes that draw FRIDAY's window: the main process, the GPU process and the renderers. */
function uiPids(metrics, ownPid = process.pid) {
  const pids = new Set([ownPid]);
  for (const entry of Array.isArray(metrics) ? metrics : []) {
    if (entry && ["Browser", "GPU", "Tab"].includes(entry.type) && Number.isInteger(entry.pid)) {
      pids.add(entry.pid);
    }
  }
  return [...pids];
}

function createPriorityManager({
  getMetrics = () => [],
  osModule = os,
  env = process.env,
  log = () => {},
  platform = process.platform,
} = {}) {
  const on = enabled(env) && platform === "win32";
  const level = levels(osModule);
  let focused = false;
  return {
    enabled: on,
    /** The local AI service steps aside for the window and for everything else. */
    lowerKernel(pid) {
      if (!on) return false;
      const ok = setOne(pid, level.below, { osModule, log });
      if (ok)
        log(`AI service ${pid} runs at below-normal priority (the window and games come first)`);
      return ok;
    },
    /** The window is in use (true) or something else is (false). */
    setUiFocus(isFocused) {
      if (!on) return false;
      focused = Boolean(isFocused);
      const target = focused ? level.above : level.normal;
      let any = false;
      for (const pid of uiPids(getMetrics())) {
        if (setOne(pid, target, { osModule, log })) any = true;
      }
      return any;
    },
    isFocused: () => focused,
  };
}

module.exports = { createPriorityManager, uiPids, levels, enabled, setOne };
