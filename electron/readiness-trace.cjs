/**
 * Readiness-only progress trace and per-milestone watchdog.
 * A normal launch never writes the file and never arms the timer.
 */
const fs = require("node:fs");
const path = require("node:path");

/** Milliseconds the process may stay on a milestone before the watchdog fails it. */
const BUDGETS = {
  "process-start": 45000,
  // The subsystem requires run on this same turn. A short budget would
  // expire the moment the thread yields, before the window exists.
  "before-subsystems": 180000,
  "load:voice": 180000,
  "after-requires": 60000,
  "user-data": 20000,
  "app-ready": 30000,
  "single-instance": 30000,
  "root-selected": 20000,
  "window-created": 60000,
  "did-finish-load": 20000,
  "renderer-mounted": 15000,
  "kernel-spawn": 70000,
  "kernel-ready": 20000,
  "stage:START": 10000,
  "stage:ROOT": 15000,
  "stage:BOOT": 40000,
  "stage:KERNEL": 70000,
  "stage:DATABASE": 20000,
  "stage:MODEL": 45000,
  "stage:CHAT": 100000,
  "stage:VOICE": 25000,
  "stage:BASIC TASK": 30000,
  finishReadiness: 5000,
};

function backgroundWorkAllowed() {
  return process.env.FRIDAY_READINESS !== "1";
}

function stageOf(milestone) {
  const name = String(milestone || "");
  const stage = name.match(/^stage:([^:]+)/);
  if (stage) return stage[1];
  if (name === "kernel-spawn" || name === "kernel-ready") return "KERNEL";
  if (name === "window-created" || name === "did-finish-load" || name === "renderer-mounted") {
    return "BOOT";
  }
  return "START";
}

function progressFile() {
  const explicit = String(process.env.FRIDAY_READINESS_PROGRESS || "").replace(/^["']|["']$/g, "");
  if (explicit) return path.resolve(explicit);
  const root = String(process.env.FRIDAY_WORKSPACE_ROOT || "").replace(/^["']|["']$/g, "");
  if (!root) return "";
  return path.join(path.resolve(root), "logs", "readiness-progress.jsonl");
}

function createReadinessTrace(deps = {}) {
  const now = deps.now || (() => Date.now());
  const schedule = deps.schedule || ((fn, ms) => setTimeout(fn, ms));
  const clear = deps.clear || ((id) => clearTimeout(id));
  const append = deps.append || appendRow;
  let origin = now();
  let timer = null;
  let stopped = false;
  let expire = null;
  let pending = null;
  let armedBudget = 0;
  const events = [];
  // These fire while another milestone is still the work in progress.
  // They must not shrink that budget (a fast window load used to expire
  // a kernel start that still had time left).
  const overlap = new Set(["did-finish-load", "renderer-mounted"]);

  function budgetFor(milestone) {
    const name = String(milestone || "");
    // One require can be large. The parent still reports the module name if
    // that require never returns. The budget only matters after the thread yields.
    if (name.startsWith("load:")) return 180000;
    return BUDGETS[name] ?? 20000;
  }

  function arm(milestone) {
    if (stopped || process.env.FRIDAY_READINESS !== "1") return;
    const budget = budgetFor(milestone);
    if (overlap.has(milestone) && timer && armedBudget > budget) return;
    if (timer) clear(timer);
    armedBudget = budget;
    timer = schedule(() => {
      timer = null;
      if (stopped) return;
      stopped = true;
      const info = {
        ok: false,
        stage: stageOf(milestone),
        error: `hung after ${milestone}`,
        detail: `watchdog: hung after ${milestone} (${budget}ms budget)`,
        events: events.slice(-12),
      };
      if (expire) expire(info);
      else pending = info;
    }, budget);
  }

  function trace(milestone, extra) {
    if (process.env.FRIDAY_READINESS !== "1") return null;
    const at = now();
    let rss = null;
    try {
      rss = process.memoryUsage().rss;
    } catch {
      rss = null;
    }
    const row = {
      t: new Date(at).toISOString(),
      milestone: String(milestone),
      ms: Math.max(0, at - origin),
      rss,
      ...(extra && typeof extra === "object" ? extra : {}),
    };
    events.push(row);
    if (events.length > 80) events.shift();
    try {
      append(row);
    } catch {
      /* the parent still reports a missing trace */
    }
    arm(row.milestone);
    return row;
  }

  return {
    trace,
    stop() {
      stopped = true;
      armedBudget = 0;
      if (timer) clear(timer);
      timer = null;
    },
    onExpire(fn) {
      expire = fn;
      if (pending && fn) {
        const info = pending;
        pending = null;
        fn(info);
      }
    },
    events() {
      return events.slice();
    },
    reset(at) {
      stopped = false;
      pending = null;
      armedBudget = 0;
      events.length = 0;
      origin = typeof at === "number" ? at : now();
      if (timer) clear(timer);
      timer = null;
    },
  };
}

function appendRow(row) {
  const file = progressFile();
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

const shared = createReadinessTrace();

module.exports = {
  BUDGETS,
  backgroundWorkAllowed,
  stageOf,
  progressFile,
  createReadinessTrace,
  trace: (milestone, extra) => shared.trace(milestone, extra),
  stop: () => shared.stop(),
  onExpire: (fn) => shared.onExpire(fn),
  events: () => shared.events(),
};
