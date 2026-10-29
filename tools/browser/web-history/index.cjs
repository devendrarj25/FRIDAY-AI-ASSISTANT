// FRIDAY · tools/browser/web-history
//
// Delegates to electron/browser.cjs recent().
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run({ limit = 40 } = {}) {
  const browser = require(path.join(ELECTRON, "browser.cjs"));
  const entries = browser.recent(Number(limit) || 40);
  return { ok: true, count: entries.length, entries };
}

module.exports = { run };
