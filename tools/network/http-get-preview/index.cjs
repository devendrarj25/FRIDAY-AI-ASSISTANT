const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run({ url, maxChars = 2000 } = {}) {
  if (!url) return { ok: false, error: "A URL is required." };
  try {
    const netFetch = require(path.join(ELECTRON, "net-fetch.cjs"));
    const started = Date.now();
    const res = await netFetch.fetchCompat(String(url), { method: "GET" });
    const text = await res.text();
    return {
      ok: true,
      status: res.status,
      ms: Date.now() - started,
      preview: String(text || "").slice(0, Number(maxChars) || 2000),
    };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}
module.exports = { run };
