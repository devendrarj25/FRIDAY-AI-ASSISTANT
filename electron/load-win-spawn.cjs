/**
 * Load the one Windows spawn helper from a dev checkout or from the
 * packaged extraResources copy of scripts/.
 */
const fs = require("node:fs");
const path = require("node:path");

function loadWinSpawn(fromDir) {
  const candidates = [
    path.join(fromDir, "..", "scripts", "win-spawn.cjs"),
    path.join(process.resourcesPath || "", "scripts", "win-spawn.cjs"),
  ];
  for (const file of candidates) {
    if (file && fs.existsSync(file)) return require(file);
  }
  throw new Error("win-spawn.cjs is missing from scripts/");
}

module.exports = { loadWinSpawn };
