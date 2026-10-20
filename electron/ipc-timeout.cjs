/**
 * Wait limits for renderer invokes.
 * A budget expiry rejects the invoke. It does not abort the work.
 */
const { budgetFor, QUICK_MS, STREAM_IDLE_MS } = require("./ipc-budget-table.cjs");

const inflight = new Set();

function budgetError(budget) {
  const where = budget.method ? `${budget.channel} ${budget.method}` : budget.channel;
  const kind = budget.class === "stream" ? "stream inactivity" : budget.class;
  const error = new Error(`ipc budget expired: ${kind} (${where})`);
  error.code = "IPC_BUDGET";
  error.budgetClass = budget.class;
  error.channel = budget.channel;
  error.method = budget.method || "";
  return error;
}

function timeoutMs(channel, method) {
  return budgetFor(channel, method ? [method] : []).ms;
}

/** Any in-flight stream sees output from the worker that produced it. */
function noteActivity() {
  for (const controls of inflight) {
    if (controls.budget.class === "stream") controls.beat();
  }
}

function longWorkActive() {
  for (const controls of inflight) {
    if (controls.budget.class === "long-job" || controls.budget.class === "stream") return true;
  }
  return false;
}

function runWithBudget(channel, args, work, options = {}) {
  const budget = budgetFor(channel, args);
  const override = Number.isFinite(options.ms) ? options.ms : null;
  const controls = { budget, beat() {} };
  inflight.add(controls);
  let timer = null;
  let settled = false;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const promise = new Promise((resolve, reject) => {
    const arm = () => {
      const ms = override != null ? override : budget.ms;
      if (!ms) return;
      clear();
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(budgetError(budget));
      }, ms);
      if (timer.unref) timer.unref();
    };
    controls.beat = () => {
      if (budget.class === "stream" && override == null) arm();
    };
    const job = Promise.resolve().then(() => (typeof work === "function" ? work() : work));
    job.then(
      (value) => {
        if (settled) return;
        settled = true;
        clear();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clear();
        reject(error);
      },
    );
    if (override != null || budget.class !== "long-job") arm();
  }).finally(() => {
    clear();
    inflight.delete(controls);
  });
  return { promise, beat: () => controls.beat(), budget };
}

function withIpcTimeout(channel, work, msOrOptions) {
  const options =
    typeof msOrOptions === "number"
      ? { ms: msOrOptions }
      : msOrOptions && typeof msOrOptions === "object"
        ? msOrOptions
        : {};
  return runWithBudget(channel, options.args || [], work, options).promise;
}

module.exports = {
  QUICK_MS,
  STREAM_IDLE_MS,
  budgetFor,
  budgetError,
  timeoutMs,
  noteActivity,
  longWorkActive,
  runWithBudget,
  withIpcTimeout,
};
