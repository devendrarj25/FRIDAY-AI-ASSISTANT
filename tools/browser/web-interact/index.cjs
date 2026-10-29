// FRIDAY · tools/browser/web-interact
//
// Delegates to electron/browser.cjs interact().
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run({ action, url, selector, text, value } = {}) {
  const browser = require(path.join(ELECTRON, "browser.cjs"));
  try {
    return await browser.interact({ action, url, selector, text, value });
  } catch (error) {
    return { ok: false, action, error: String(error.message || error) };
  }
}

module.exports = { run };
