/**
 * One launch harness for the packaged app.
 * Readiness, the boot self-test, and installer smoke share this kill, marker
 * read, and leak check. The harness owns the process it spawned. It does not
 * decide which processes the running app owns.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function killTree(child) {
  if (!child) return false;
  try {
    if (process.platform === "win32" && child.pid) {
      spawnSync(
        path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true },
      );
      return true;
    }
    if (typeof child.kill === "function") {
      child.kill();
      return true;
    }
  } catch {
    /* already gone */
  }
  return false;
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function pidAlive(pid) {
  const id = Number(pid);
  if (!Number.isFinite(id) || id <= 0) return false;
  try {
    process.kill(id, 0);
    return true;
  } catch {
    return false;
  }
}

function childPids(child) {
  const pid = Number(child && child.pid);
  return pid ? [pid] : [];
}

/** After a lifecycle exit, none of these pids should still be alive. */
function leakCheck(pids) {
  const alive = [];
  for (const pid of Array.isArray(pids) ? pids : []) {
    if (pidAlive(pid)) alive.push(Number(pid));
  }
  return { ok: alive.length === 0, alive };
}

function leakCheckRegistry(file) {
  let rows = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    rows = Array.isArray(parsed) ? parsed : parsed.pids || [];
  } catch {
    rows = [];
  }
  return leakCheck(rows.map((row) => row && row.pid));
}

module.exports = {
  killTree,
  readText,
  pidAlive,
  childPids,
  leakCheck,
  leakCheckRegistry,
};
