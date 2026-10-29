// FRIDAY · agents/core/process-health-snapshot
const { execFileSync } = require("node:child_process");

function snapshot() {
  const win = process.platform === "win32";
  try {
    const out = win
      ? execFileSync("tasklist", ["/fo", "csv", "/nh"], {
          encoding: "utf8",
          timeout: 8000,
          windowsHide: true,
        })
      : execFileSync("ps", ["-eo", "pid,user,rss,comm", "--no-headers"], {
          encoding: "utf8",
          timeout: 8000,
        });
    const processes = String(out)
      .split(/\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 200);
    return { ok: true, processes };
  } catch (error) {
    return { ok: false, error: String(error.message || error), processes: [] };
  }
}

function plan() {
  const shot = snapshot();
  if (!shot.ok) return { ok: false, platform: process.platform, error: shot.error, processes: [] };
  return {
    ok: true,
    platform: process.platform,
    count: shot.processes.length,
    processes: shot.processes,
    actionable: false,
  };
}

async function run(input = {}) {
  const preview = plan(input);
  if (!preview.ok) return preview;
  const dryRun = input.dryRun !== false;
  if (dryRun) return { ...preview, dryRun: true };
  if (!input.approved)
    return {
      ...preview,
      dryRun: true,
      error: "Recording this snapshot requires an approved plan.",
    };
  return { ...preview, dryRun: false, applied: "report-only" };
}

module.exports = { plan, run };
