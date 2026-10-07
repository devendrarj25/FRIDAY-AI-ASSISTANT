// FRIDAY · tools/browser/html-strip
//
// Delegates to electron/browser.cjs stripTags().
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run({ html } = {}) {
  if (html == null || html === "") return { ok: false, error: "HTML text is required." };
  const browser = require(path.join(ELECTRON, "browser.cjs"));
  const text = browser.stripTags(html);
  return { ok: true, text, chars: text.length };
}

module.exports = { run };
