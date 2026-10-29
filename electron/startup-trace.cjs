/**
 * Debug-only startup milestones. A normal launch does not write this file
 * and does not arm the readiness watchdog.
 */
const fs = require("node:fs");
const path = require("node:path");

const startedAt = Date.now();

function enabled() {
  return process.env.FRIDAY_DEBUG === "1" || process.env.FRIDAY_STARTUP_TRACE === "1";
}

function note(milestone, extra, file) {
  if (!enabled() || !file) return null;
  const row = {
    milestone: String(milestone || ""),
    ms: Date.now() - startedAt,
    ...(extra && typeof extra === "object" ? extra : {}),
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
  } catch {
    return null;
  }
  return row;
}

module.exports = { note, enabled };
