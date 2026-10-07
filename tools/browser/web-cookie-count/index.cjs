// FRIDAY · tools/browser/web-cookie-count
//
// Delegates to electron/browser-live.cjs cookieCount() — count only.
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run() {
  const live = require(path.join(ELECTRON, "browser-live.cjs"));
  const count = await live.cookieCount();
  return { ok: true, count: Number(count) || 0 };
}

module.exports = { run };
