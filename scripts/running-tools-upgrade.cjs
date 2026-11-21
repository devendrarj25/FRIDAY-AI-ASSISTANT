/**
 * `npm run setup` leaves a hidden helper that installs a newer Node.js and npm once its own npm command has ended
 * (they run the setup, so they cannot be replaced from inside it). Doctor and the build wait for that helper,
 * because Node.js or npm half-replaced under a running command breaks it. The helper's process id is in a lock
 * file in the temp folder; a lock that is old, or whose process is gone, is ignored and removed.
 *
 * The helper also writes one result line per tool (label|from|to|exit code|version that answers afterwards). The
 * next setup, doctor or build says once whether the update took effect, names the one command when it did not,
 * and removes the file, so a silent failure (a winget id that is not installed, a refused prompt) is never hidden.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LOCK = path.join(
  process.env.TEMP || process.env.TMPDIR || os.tmpdir(),
  "friday-running-tools-upgrade.lock",
);
const TEMP_DIR = process.env.TEMP || process.env.TMPDIR || os.tmpdir();
const RESULT = path.join(TEMP_DIR, "friday-running-tools-upgrade.result");
const LOG = path.join(TEMP_DIR, "friday-running-tools-upgrade.log");
const MAX_WAIT_MS = 15 * 60_000;
const COMMANDS = {
  "Node.js":
    "winget upgrade --id OpenJS.NodeJS.LTS --exact --include-unknown (or the LTS installer from nodejs.org)",
  npm: "npm install --global npm@latest",
};

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** The pid of a helper that is still running, or 0. Removes a stale lock. */
function pending(file = LOCK, { now = Date.now(), isAlive = alive } = {}) {
  let pid = 0;
  let age = 0;
  try {
    pid = Number(String(fs.readFileSync(file, "utf8")).trim());
    age = now - fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
  if (Number.isInteger(pid) && pid > 0 && age < MAX_WAIT_MS && isAlive(pid)) return pid;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* the next run removes it */
  }
  return 0;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function atLeast(have, want) {
  const a = String(have).split(".").map(Number);
  const b = String(want).split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    if (x !== y) return x > y;
  }
  return true;
}

/** The lines that say whether the last helper's updates took effect. Reads and removes the result file. */
function reportResult({ file = RESULT, log = console.log } = {}) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines = [];
  for (const row of text.split(/\r?\n/)) {
    const [label, from, to, code, now] = row.trim().split("|");
    if (!label || !to) continue;
    if (now && atLeast(now, to)) {
      lines.push(
        `[friday] ok       ${label} was updated from ${from} to ${now} after the last setup`,
      );
    } else {
      lines.push(
        `[friday] WARN     the ${label} ${to} update after the last setup did not take effect (exit code ${code || "unknown"}; ${label} answers ${now || "nothing"}). ${label} ${from} keeps working. To update it, open a new terminal and run: ${COMMANDS[label] || "npm run setup"}. Log: ${LOG}`,
      );
    }
  }
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* the next run reads it again */
  }
  for (const line of lines) log(line);
  return lines;
}

/** Block until the helper has ended (at most 15 minutes), then report its result. Returns whether it had to wait. */
function waitForPending({
  file = LOCK,
  result = RESULT,
  log = console.log,
  isAlive = alive,
  wait = sleep,
  now = Date.now,
} = {}) {
  let pid = pending(file, { now: now(), isAlive });
  if (!pid) {
    reportResult({ file: result, log });
    return false;
  }
  log(
    "[friday] a Node.js / npm update started by the last setup is still running; waiting for it (up to 15 minutes)",
  );
  const began = now();
  while (pid && now() - began < MAX_WAIT_MS) {
    wait(1000);
    pid = pending(file, { now: now(), isAlive });
  }
  reportResult({ file: result, log });
  return true;
}

module.exports = { LOCK, RESULT, MAX_WAIT_MS, atLeast, pending, reportResult, waitForPending };

if (require.main === module && process.argv.includes("--report")) reportResult();
