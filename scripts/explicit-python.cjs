/**
 * An interpreter the owner named in FRIDAY_PYTHON is honoured only while it exists.
 *
 * A variable left over from an older install (for example a path in a folder that has since been removed or
 * renamed) used to win over the Python that setup had just created, so every step that ran Python failed with
 * "spawn ... ENOENT". A bare command such as `python` cannot be checked and is kept as it is.
 */
"use strict";

const fs = require("node:fs");

/** The usable interpreter named by `value`, or "" when it is empty or points at a file that is not there. */
function explicitPython(value, { exists = fs.existsSync } = {}) {
  const named = String(value || "")
    .trim()
    .replace(/^["']|["']$/g, "");
  if (!named) return "";
  const isPath = /[\\/]/.test(named) || /^[A-Za-z]:/.test(named);
  if (!isPath) return named;
  try {
    return exists(named) ? named : "";
  } catch {
    return "";
  }
}

/**
 * Drop a FRIDAY_PYTHON that points nowhere from `env`, so no step below sees it. Returns the stale value (or "").
 */
function dropStalePython(env = process.env, { exists = fs.existsSync } = {}) {
  const named = String(env.FRIDAY_PYTHON || "").trim();
  if (!named) return "";
  if (explicitPython(named, { exists })) return "";
  delete env.FRIDAY_PYTHON;
  return named;
}

module.exports = { explicitPython, dropStalePython };
