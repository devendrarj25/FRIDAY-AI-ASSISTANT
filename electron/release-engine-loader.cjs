/**
 * The one way the main process loads scripts/release-engine.cjs (version identity and build ordering).
 *
 * The file is listed in electron-builder `files`, but electron-builder also drops from app.asar every file that an
 * `extraResources` entry copies, and `scripts/` is one (resources/scripts holds the same file beside the archive).
 * Whether the archive keeps its own copy therefore depends on the platform and the electron-builder version, so a
 * bare `require` of `../scripts/release-engine.cjs` worked on one pack and failed on another, and the update, version
 * and release modules loaded through it silently went missing. The archive path is tried first, then resources/.
 */
const path = require("node:path");

const state = { engine: null };

function load({ inArchive, beside, load: requireFn = require }) {
  try {
    return requireFn(inArchive);
  } catch (first) {
    const second = beside();
    if (!second) throw first;
    return requireFn(second);
  }
}

function releaseEngine() {
  if (!state.engine) {
    state.engine = load({
      inArchive: path.resolve(__dirname, "..", "scripts", "release-engine.cjs"),
      beside: () =>
        require("./resource-paths.cjs").resolveResourceFile("scripts/release-engine.cjs"),
    });
  }
  return state.engine;
}

module.exports = { releaseEngine, load };
