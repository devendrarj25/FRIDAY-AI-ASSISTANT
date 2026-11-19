/**
 * `npm run setup` leaves a hidden helper that installs a newer Node.js and npm once its own npm command has ended
 * (they run the setup, so they cannot be replaced from inside it). Doctor and the build wait for that helper,
 * because Node.js or npm half-replaced under a running command breaks it. The helper's process id is in a lock
 * file in the temp folder; a lock that is old, or whose process is gone, is ignored and removed.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LOCK = path.join(
  process.env.TEMP || process.env.TMPDIR || os.tmpdir(),
  "friday-running-tools-upgrade.lock",
);
const MAX_WAIT_MS = 15 * 60_000;

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

/** Block until the helper has ended (at most 15 minutes). Returns whether it had to wait. */
function waitForPending({
  file = LOCK,
  log = console.log,
  isAlive = alive,
  wait = sleep,
  now = Date.now,
} = {}) {
  let pid = pending(file, { now: now(), isAlive });
  if (!pid) return false;
  log(
    "[friday] a Node.js / npm update started by the last setup is still running; waiting for it (up to 15 minutes)",
  );
  const began = now();
  while (pid && now() - began < MAX_WAIT_MS) {
    wait(1000);
    pid = pending(file, { now: now(), isAlive });
  }
  return true;
}

module.exports = { LOCK, MAX_WAIT_MS, pending, waitForPending };
