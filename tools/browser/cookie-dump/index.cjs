// FRIDAY · tools/browser/cookie-dump
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run(input = {}) {
  const live = require(path.join(ELECTRON, "browser-live.cjs"));
  return live.cookieDump({ url: input.url, domain: input.domain });
}

module.exports = { run };
