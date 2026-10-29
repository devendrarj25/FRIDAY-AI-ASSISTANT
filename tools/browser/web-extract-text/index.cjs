// FRIDAY · tools/browser/web-extract-text
//
// Delegates to electron/browser.cjs open(); returns text only.
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run({ url, maxChars = 20000 } = {}) {
  const browser = require(path.join(ELECTRON, "browser.cjs"));
  const page = await browser.open(url, { maxChars: Number(maxChars) || 20000 });
  return {
    ok: Boolean(page.ok),
    url: page.url || url,
    title: page.title || null,
    text: page.text || "",
    ...(page.error ? { error: page.error } : {}),
  };
}

module.exports = { run };
