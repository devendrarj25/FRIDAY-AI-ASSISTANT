// FRIDAY · tools/browser/web-screenshot
//
// Delegates to electron/browser.cjs screenshot().
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run({ url } = {}) {
  const browser = require(path.join(ELECTRON, "browser.cjs"));
  try {
    return await browser.screenshot(url);
  } catch (error) {
    return {
      ok: false,
      url,
      error: String(error.message || error),
    };
  }
}

module.exports = { run };
