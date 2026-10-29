// FRIDAY · tools/browser/web-search
//
// Delegates to electron/browser.cjs search() — one browser engine.
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run({ query, limit = 8 } = {}) {
  const browser = require(path.join(ELECTRON, "browser.cjs"));
  return browser.search(query, { limit: Number(limit) || 8 });
}

module.exports = { run };
