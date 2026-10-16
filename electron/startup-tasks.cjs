/**
 * One registry for work that starts when the app is ready.
 * Critical work shows the window and reaches the kernel.
 * Everything else is after first paint or idle, and each task has a timeout.
 */

function createStartupRegistry() {
  const tasks = [];

  function register(task) {
    if (!task || !task.id || typeof task.run !== "function") {
      throw new Error("a startup task needs an id and a run function");
    }
    tasks.push({
      id: String(task.id),
      phase: task.phase === "critical" || task.phase === "after-first-paint" ? task.phase : "idle",
      timeoutMs: Number(task.timeoutMs) > 0 ? Number(task.timeoutMs) : 8000,
      readiness: task.readiness !== false,
      run: task.run,
      done: false,
    });
    return task.id;
  }

  function runOne(task) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ id: task.id, timeout: true }), task.timeoutMs);
      if (timer.unref) timer.unref();
      Promise.resolve()
        .then(() => task.run())
        .then((value) => finish({ id: task.id, timeout: false, value }))
        .catch((error) =>
          finish({
            id: task.id,
            timeout: false,
            error: error && error.message ? error.message : String(error),
          }),
        );
    });
  }

  async function runPhase(phase, opts = {}) {
    const readiness = Boolean(opts.readiness);
    const ran = [];
    for (const task of tasks) {
      if (task.phase !== phase || task.done) continue;
      if (readiness && task.readiness === false) continue;
      task.done = true;
      ran.push(await runOne(task));
    }
    return ran;
  }

  function list() {
    return tasks.map((task) => ({
      id: task.id,
      phase: task.phase,
      timeoutMs: task.timeoutMs,
      readiness: task.readiness,
    }));
  }

  return { register, runPhase, list };
}

module.exports = { createStartupRegistry };
