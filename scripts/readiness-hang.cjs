/**
 * Parent-side reading of a readiness hang. The child writes
 * logs/readiness-progress.jsonl. This module turns that file into one line.
 */
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

function readProgress(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((row) => row && typeof row.milestone === "string");
  } catch {
    return [];
  }
}

function hangLine(events) {
  const rows = Array.isArray(events) ? events : [];
  const last = rows[rows.length - 1];
  const milestone = last ? last.milestone : "process-start";
  const seconds = last && Number.isFinite(last.ms) ? Math.max(0, Math.round(last.ms / 1000)) : 0;
  const tail = rows
    .slice(-5)
    .map((row) => row.milestone)
    .join(", ");
  return `hung after ${milestone} (${seconds}s); last events: ${tail || "none"}`;
}

function childSnapshot(pid) {
  const id = Number(pid);
  if (!id) return [];
  try {
    if (process.platform === "win32") {
      const listed = spawnSync("tasklist", ["/FI", `PID eq ${id}`, "/FO", "CSV", "/NH"], {
        encoding: "utf8",
        timeout: 4000,
        windowsHide: true,
      });
      return String(listed.stdout || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    }
    const listed = spawnSync("ps", ["-o", "pid=,ppid=,comm=", "--ppid", String(id)], {
      encoding: "utf8",
      timeout: 4000,
    });
    return String(listed.stdout || "")
      .split(/\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function metricsFrom(events) {
  const rows = Array.isArray(events) ? events : [];
  const last = [...rows].reverse().find((row) => typeof row.rss === "number");
  if (!last) return null;
  return { rss: last.rss, milestone: last.milestone, ms: last.ms };
}

function inspectLaunch({ progressFile, pid }) {
  const events = readProgress(progressFile);
  const children = childSnapshot(pid);
  const metrics = metricsFrom(events);
  return {
    events,
    children,
    metrics,
    line: hangLine(events),
  };
}

/**
 * A first launch that produced no report must not be described as an exit
 * code, and the restart launch must not start.
 */
function noReportVerdict(result) {
  const stages = result && Array.isArray(result.stages) ? result.stages : [];
  const timedOut = /did not finish within 5 minutes/i.test(String(result?.error || ""));
  return Boolean(result && result.noReport) || (timedOut && stages.length === 0);
}

module.exports = {
  readProgress,
  hangLine,
  childSnapshot,
  metricsFrom,
  inspectLaunch,
  noReportVerdict,
};
