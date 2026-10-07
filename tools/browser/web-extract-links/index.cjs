// FRIDAY · tools/browser/web-extract-links
//
// Delegates to electron/browser.cjs open(); returns links only.
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run({ url } = {}) {
  const browser = require(path.join(ELECTRON, "browser.cjs"));
  const page = await browser.open(url, { maxChars: 4000 });
  return {
    ok: Boolean(page.ok),
    url: page.url || url,
    title: page.title || null,
    links: Array.isArray(page.links) ? page.links : [],
    ...(page.error ? { error: page.error } : {}),
  };
}

module.exports = { run };
