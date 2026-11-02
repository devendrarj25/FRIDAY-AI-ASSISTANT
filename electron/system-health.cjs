/**
 * How FRIDAY keeps working on the PC it is on: three small parts, each plain data in and out so each is tested
 * without Electron.
 *
 *  1. createGpuGuard      The graphics process of an Electron app can crash on a driver that Chromium does not
 *                         like. Chromium restarts it, but a driver that keeps failing leaves a flickering or
 *                         dead window. After repeated crashes the guard writes a small marker, and the next
 *                         start (and the restart FRIDAY does at once) draws in software, which every PC can do.
 *                         The marker expires, so a fixed driver gets the GPU back.
 *  2. createPressureMonitor  Free memory, FRIDAY's own memory and CPU, battery and the OS speed limit, read
 *                         every few seconds. It reports one level (ok, high, critical) with a margin so it does
 *                         not flip back and forth, and a "lite" flag the interface uses to stop decoration.
 *  3. adaptPlan           The worker plan from hardware.cjs is made once at start; this scales its threads and
 *                         memory budget to what is free right now, so a restart under pressure starts lighter.
 */

const nodePath = require("node:path");

const BAD_GPU_REASONS = new Set([
  "crashed",
  "abnormal-exit",
  "launch-failed",
  "integrity-failure",
  "oom",
]);

const GPU_LIMIT = 2;
const GPU_WINDOW_MS = 10 * 60 * 1000;
const GPU_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function createGpuGuard({
  fs,
  file,
  now = () => Date.now(),
  env = process.env,
  limit = GPU_LIMIT,
  windowMs = GPU_WINDOW_MS,
  ttlMs = GPU_TTL_MS,
  log = () => {},
}) {
  let crashes = [];

  const read = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  };

  /** True when this start should draw in software. Call before the app is ready. */
  function softwareMode() {
    if (env.FRIDAY_FORCE_GPU === "1") return false;
    const saved = read();
    if (!saved.softwareSince) return false;
    if (now() - Number(saved.softwareSince) > ttlMs) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* an expired marker that cannot be removed expires again next time */
      }
      return false;
    }
    return true;
  }

  /** Feed every `child-process-gone` detail here. Returns what to do about it. */
  function recordChildGone(details) {
    if (!details || details.type !== "GPU" || !BAD_GPU_REASONS.has(details.reason)) {
      return { action: "ignore" };
    }
    const at = now();
    crashes = crashes.filter((t) => at - t <= windowMs);
    crashes.push(at);
    log(
      `GPU process gone (${details.reason}, exit ${details.exitCode ?? "?"}), ${crashes.length} recent`,
    );
    if (crashes.length < limit) return { action: "noted", count: crashes.length };
    try {
      fs.writeFileSync(
        file,
        JSON.stringify({
          softwareSince: at,
          reason: details.reason,
          exitCode: details.exitCode ?? null,
        }),
      );
    } catch (error) {
      log(
        `could not save the software-drawing marker: ${error && error.message ? error.message : error}`,
      );
    }
    return { action: "fallback", count: crashes.length };
  }

  return { softwareMode, recordChildGone, file };
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Level from free memory alone, with the thresholds that apply when going up. */
function memoryLevel(freeBytes, totalBytes) {
  const ratio = totalBytes > 0 ? freeBytes / totalBytes : 1;
  // A small share of a big machine is still a lot of memory (64 GB at 4 percent is 2.5 GB), so the share
  // counts only while the absolute amount is also small.
  if (freeBytes < 0.6 * GB || (ratio < 0.04 && freeBytes < 1 * GB)) return "critical";
  if (freeBytes < 1.5 * GB || (ratio < 0.1 && freeBytes < 3 * GB)) return "high";
  return "ok";
}

const ORDER = { ok: 0, high: 1, critical: 2 };

function createPressureMonitor({
  os,
  getMetrics = () => [],
  isOnBattery = () => false,
  speedLimit = () => 100,
  now = () => Date.now(),
  intervalMs = 15000,
  setTimer = setInterval,
  clearTimer = clearInterval,
  calmSamples = 2,
}) {
  const listeners = new Set();
  let timer = null;
  let level = "ok";
  let calm = 0;
  let snapshot = {
    level: "ok",
    lite: false,
    freeGb: 0,
    freePercent: 100,
    appMemMb: 0,
    appCpuPercent: 0,
    onBattery: false,
    speedLimit: 100,
    at: 0,
  };

  const round1 = (n) => Math.round(n * 10) / 10;

  function sample() {
    const total = os.totalmem();
    const free = os.freemem();
    const wanted = memoryLevel(free, total);
    // Going up is at once. Coming back down takes `calmSamples` calm readings in a row.
    if (ORDER[wanted] > ORDER[level]) {
      level = wanted;
      calm = 0;
    } else if (ORDER[wanted] < ORDER[level]) {
      calm += 1;
      if (calm >= calmSamples) {
        level = wanted;
        calm = 0;
      }
    } else {
      calm = 0;
    }
    let appMem = 0;
    let appCpu = 0;
    try {
      for (const row of getMetrics() || []) {
        appMem += Number(row?.memory?.workingSetSize || 0); // kilobytes
        appCpu += Number(row?.cpu?.percentCPUUsage || 0);
      }
    } catch {
      /* metrics are a bonus; the level never depends on them */
    }
    const onBattery = Boolean(isOnBattery());
    const limit = Number(speedLimit());
    const next = {
      level,
      lite: level !== "ok" || onBattery || (Number.isFinite(limit) && limit < 100),
      freeGb: round1(free / GB),
      freePercent: total > 0 ? Math.round((free / total) * 100) : 100,
      appMemMb: Math.round(appMem / 1024),
      appCpuPercent: round1(appCpu),
      onBattery,
      speedLimit: Number.isFinite(limit) ? limit : 100,
      at: now(),
    };
    const changed =
      next.level !== snapshot.level ||
      next.lite !== snapshot.lite ||
      next.onBattery !== snapshot.onBattery;
    snapshot = next;
    if (changed) {
      for (const listener of listeners) {
        try {
          listener(snapshot);
        } catch {
          /* one bad listener must not stop the others */
        }
      }
    }
    return snapshot;
  }

  return {
    sample,
    snapshot: () => snapshot,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      if (timer) return;
      sample();
      timer = setTimer(sample, intervalMs);
      if (timer && typeof timer.unref === "function") timer.unref();
    },
    stop() {
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}

/**
 * Scale a worker plan to the memory that is free now. Threads halve under pressure (never below one), the memory
 * budget never exceeds 60 percent of what is free, and the GPU choice is left as it is.
 */
function adaptPlan(plan, snap) {
  if (!plan || !snap) return plan;
  const stressed = snap.level !== "ok" || snap.onBattery || snap.speedLimit < 100;
  const threads = stressed ? Math.max(1, Math.floor(plan.threads / 2)) : plan.threads;
  const freeBudget =
    snap.freeGb > 0 ? Math.max(1, Math.round(snap.freeGb * 0.6 * 10) / 10) : plan.maxRamGb;
  return {
    ...plan,
    threads,
    maxRamGb: Math.min(plan.maxRamGb, freeBudget),
    adapted: stressed || freeBudget < plan.maxRamGb,
  };
}

/**
 * Can the FRIDAY folder be used right now? A folder on a drive that went read-only, a OneDrive folder that is
 * locked, or a drive that is nearly full all start fine and then lose a chat or a memory a day later. This says so
 * at start, with the reason, so it shows in the boot list and the log before anything is lost.
 */
function rootHealth({ fs, root, minFreeGb = 2 }) {
  const out = { ok: true, writable: true, freeGb: null, problems: [] };
  if (!root) return out;
  try {
    const probe = nodePath.join(root, ".friday-boot-probe");
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe, { force: true });
  } catch (error) {
    out.writable = false;
    out.ok = false;
    const code = error && error.code ? error.code : "write failed";
    out.problems.push(
      `The FRIDAY folder cannot be written to (${code}). Chats, memory and settings cannot be saved until it can.`,
    );
  }
  try {
    const stat = fs.statfsSync(root);
    out.freeGb = Math.round(((Number(stat.bavail) * Number(stat.bsize)) / GB) * 10) / 10;
    if (out.freeGb < minFreeGb) {
      out.ok = false;
      out.problems.push(
        `Only ${out.freeGb} GB is free on the drive of the FRIDAY folder. Free some space so saving and downloads keep working.`,
      );
    }
  } catch {
    /* a drive that cannot report its free space is not a reason to warn */
  }
  return out;
}

module.exports = {
  rootHealth,
  createGpuGuard,
  createPressureMonitor,
  adaptPlan,
  memoryLevel,
  BAD_GPU_REASONS,
  GPU_LIMIT,
  GPU_WINDOW_MS,
  GPU_TTL_MS,
};
