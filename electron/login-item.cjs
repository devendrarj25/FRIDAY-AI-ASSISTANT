/**
 * FRIDAY · start at sign-in (the Windows "Run" entry).
 *
 * Three things the plain `app.setLoginItemSettings({ openAtLogin })` call got wrong on Windows:
 *
 *   1. It cannot tell the app it was started at sign-in. `wasOpenedAtLogin` is macOS only, so on Windows
 *      the "stay in the background after signing in" branches never ran and a window opened over the
 *      desktop at every sign-in. The entry now carries `--friday-login`, and the app reads it from argv.
 *   2. A portable build runs from a temporary folder that is gone after it exits, so `process.execPath`
 *      is a dead path next to the next sign-in. The portable launcher's own file
 *      (`PORTABLE_EXECUTABLE_FILE`) is written instead.
 *   3. The registry value was named after the AppUserModelId (`dev.friday.desk`), while Setup's
 *      uninstaller removes the value named `FRIDAY`: an uninstalled FRIDAY kept launching a missing file
 *      at every sign-in. The value is now named `FRIDAY`, and the old name is removed whenever the entry is
 *      written or cleared.
 *
 * Electron reports `openAtLogin` for a Windows entry only when `path` and `args` match, so the same options
 * are passed to the read. An entry written by an older build (no arguments) still counts as enabled and is
 * rewritten once by `migrate`.
 */
const LOGIN_ARG = "--friday-login";
const VALUE_NAME = "FRIDAY";
const LEGACY_VALUE_NAME = "dev.friday.desk";

/** The executable and arguments the sign-in entry launches. */
function options(env = process.env, execPath = process.execPath) {
  const portable = String(env.PORTABLE_EXECUTABLE_FILE || "").trim();
  return { path: portable || execPath, args: [LOGIN_ARG] };
}

function read(app, details) {
  try {
    return app.getLoginItemSettings(details) || {};
  } catch {
    return {};
  }
}

/** True when the current-form entry exists. */
function hasCurrent(app, ctx = {}) {
  const o = options(ctx.env, ctx.execPath);
  return Boolean(read(app, { path: o.path, args: o.args }).openAtLogin);
}

/** True when an entry written by an older build (no arguments) exists. */
function hasLegacy(app, ctx = {}) {
  const o = options(ctx.env, ctx.execPath);
  return Boolean(read(app, { path: o.path, args: [] }).openAtLogin);
}

/** What the Settings switch shows: any entry that will start FRIDAY at sign-in. */
function isEnabled(app, ctx = {}) {
  return hasCurrent(app, ctx) || hasLegacy(app, ctx);
}

/** Turns the sign-in entry on or off; the old value name is always removed. */
function setEnabled(app, enabled, ctx = {}) {
  app.setLoginItemSettings({ openAtLogin: false, name: LEGACY_VALUE_NAME });
  if (!enabled) {
    app.setLoginItemSettings({ openAtLogin: false, name: VALUE_NAME });
    return isEnabled(app, ctx);
  }
  const o = options(ctx.env, ctx.execPath);
  app.setLoginItemSettings({ openAtLogin: true, name: VALUE_NAME, path: o.path, args: o.args });
  return isEnabled(app, ctx);
}

/** Rewrites an older entry in the current form, once. Returns true when it did. */
function migrate(app, ctx = {}) {
  if (hasCurrent(app, ctx) || !hasLegacy(app, ctx)) return false;
  setEnabled(app, true, ctx);
  return true;
}

/** True when this launch came from the sign-in entry (Windows: the argument; macOS: the OS flag). */
function startedAtLogin(argv = process.argv, settings = null) {
  if (Array.isArray(argv) && argv.includes(LOGIN_ARG)) return true;
  return Boolean(settings && settings.wasOpenedAtLogin && settings.openAtLogin);
}

module.exports = {
  LOGIN_ARG,
  VALUE_NAME,
  LEGACY_VALUE_NAME,
  options,
  hasCurrent,
  hasLegacy,
  isEnabled,
  setEnabled,
  migrate,
  startedAtLogin,
};
