// FRIDAY · tools/browser/web-live-open
//
// Delegates to browser-live.command when mounted, else browser.open().
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run({ url } = {}) {
  const live = require(path.join(ELECTRON, "browser-live.cjs"));
  const browser = require(path.join(ELECTRON, "browser.cjs"));
  const state = live.getLive();
  if (state && state.mounted) {
    try {
      return await live.command({ action: "navigate", url }, 8000);
    } catch (error) {
      return { ok: false, url, error: String(error.message || error) };
    }
  }
  const page = await browser.open(url, { render: false });
  return {
    ...page,
    via: "headless",
    note: "FRIDAY Browser section is not open — read the page headlessly instead.",
  };
}

module.exports = { run };
