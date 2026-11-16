/**
 * Leave a script through `process.exitCode`, not `process.exit()`.
 *
 * Ending the process while the network layer or a child's pipes are still closing makes Node on Windows abort with
 * "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)", which turns a finished step into a crash. The code is set
 * and the process ends by itself; a timer that does not keep the process alive ends it after a few seconds if a stray
 * handle would otherwise hold it open.
 */
"use strict";

function leave(code = 0, graceMs = 5000) {
  const value = Number(code) || 0;
  process.exitCode = value;
  const force = setTimeout(() => process.exit(value), graceMs);
  force.unref();
  return value;
}

module.exports = { leave };
