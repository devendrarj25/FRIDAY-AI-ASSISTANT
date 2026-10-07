// FRIDAY · tools/browser/web-bookmarks
//
// Delegates to electron/browser-live.cjs getBookmarks().
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run() {
  const live = require(path.join(ELECTRON, "browser-live.cjs"));
  const bookmarks = live.getBookmarks();
  return {
    ok: true,
    count: Array.isArray(bookmarks) ? bookmarks.length : 0,
    bookmarks: bookmarks || [],
  };
}

module.exports = { run };
