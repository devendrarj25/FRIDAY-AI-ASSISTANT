// FRIDAY · tools/browser/web-open
//
// Delegates to electron/browser.cjs open().
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run({ url, render = false, maxChars = 20000 } = {}) {
  const browser = require(path.join(ELECTRON, "browser.cjs"));
  return browser.open(url, { render: Boolean(render), maxChars: Number(maxChars) || 20000 });
}

module.exports = { run };
