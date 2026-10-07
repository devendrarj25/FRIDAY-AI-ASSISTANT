// FRIDAY · agents/core/recurring-task-nudger
const fs = require("node:fs");

function loadTasks(input = {}) {
  if (Array.isArray(input.tasks)) return input.tasks;
  if (input.file && fs.existsSync(input.file)) {
    try {
      const data = JSON.parse(fs.readFileSync(input.file, "utf8"));
      if (Array.isArray(data)) return data;
      if (data && Array.isArray(data.tasks)) return data.tasks;
    } catch (error) {
      return { error: String(error.message || error) };
    }
  }
  return [];
}

function plan(input = {}) {
  const loaded = loadTasks(input);
  if (loaded && loaded.error) return { ok: false, error: loaded.error, overdue: [] };
  const tasks = Array.isArray(loaded) ? loaded : [];
  const now = Number(input.now) || Date.now();
  const overdue = [];
  for (const task of tasks) {
    if (!task || typeof task !== "object") continue;
    if (task.done) continue;
    const dueAt = task.dueAt == null ? null : Number(task.dueAt);
    if (dueAt == null || Number.isNaN(dueAt) || dueAt > now) continue;
    overdue.push({
      id: task.id || "",
      title: String(task.title || ""),
      dueAt,
      overdueDays: Math.max(0, Math.round((now - dueAt) / 86400000)),
    });
  }
  return {
    ok: true,
    scanned: tasks.length,
    count: overdue.length,
    overdue,
    actionable: overdue.length > 0,
    note: tasks.length ? undefined : "No personal-desk tasks were provided.",
  };
}

async function run(input = {}) {
  const preview = plan(input);
  if (!preview.ok) return preview;
  const dryRun = input.dryRun !== false;
  if (dryRun) return { ...preview, dryRun: true };
  if (!input.approved)
    return { ...preview, dryRun: true, error: "Recording this nudge requires an approved plan." };
  return { ...preview, dryRun: false, applied: "report-only" };
}

module.exports = { plan, run };
