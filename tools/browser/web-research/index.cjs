// FRIDAY · tools/browser/web-research
//
// Composes electron/browser.cjs search() + open(), same as browser-engine research().
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run({ query, depth = 3 } = {}) {
  const browser = require(path.join(ELECTRON, "browser.cjs"));
  const n = Math.max(1, Math.min(5, Number(depth) || 3));
  const search = await browser.search(query, { limit: Math.max(n, 5) });
  if (!search.ok) {
    return { ok: false, query, results: [], pages: [], error: search.error || "search failed" };
  }
  const pages = [];
  for (const hit of (search.results || []).slice(0, n)) {
    pages.push(await browser.open(hit.url, { maxChars: 6000 }));
  }
  return { ok: true, query, results: search.results, pages };
}

module.exports = { run };
