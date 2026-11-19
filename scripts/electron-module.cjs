/**
 * Loads a module of `electron/` from a script that ships beside the app.
 *
 * In a checkout, `scripts/` and `electron/` are sibling folders. In the installed app `scripts/` is copied to
 * `resources/scripts` (outside the archive) while `electron/` lives inside `resources/app.asar`, so
 * a relative require of a sibling `electron` folder finds nothing there: the environment registry, the toolkit step and the pack
 * stager all failed with "Cannot find module" in the installed app. This tries the checkout path first and the
 * archive path second; Electron reads files inside an archive transparently, also when it runs as Node.
 */
const fs = require("node:fs");
const path = require("node:path");

/** Where a module of electron/ is, in a checkout or inside the installed app's archive; null when neither has it. */
function locate(name) {
  const beside = path.join(__dirname, "..", "electron", name);
  if (fs.existsSync(beside)) return beside;
  const archived = path.join(__dirname, "..", "app.asar", "electron", name);
  if (fs.existsSync(archived)) return archived;
  return null;
}

/** `load("local-library.cjs")` loads that module of `electron/`, in a checkout and in the installed app. */
function load(name) {
  const file = locate(name);
  if (!file) throw new Error(`Cannot find module electron/${name}`);
  return require(file);
}

module.exports = { load, locate };
