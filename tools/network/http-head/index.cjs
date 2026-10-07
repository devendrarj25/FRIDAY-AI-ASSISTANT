// FRIDAY · tools/network/http-head
//
// node:https HEAD — same shape as network-diagnostics httpsHead.
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

const https = require("node:https");

async function run({ host, path: urlPath = "/" } = {}) {
  const name = String(host || "").trim();
  if (!name) return { ok: false, error: "A host name is required." };
  return new Promise((resolve) => {
    const started = Date.now();
    const req = https.request(
      { host: name, path: urlPath || "/", method: "HEAD", timeout: 8000 },
      (res) => {
        res.resume();
        resolve({ ok: true, host: name, status: res.statusCode, ms: Date.now() - started });
      },
    );
    req.once("timeout", () => {
      req.destroy();
      resolve({ ok: false, host: name, error: "timed out after 8000ms" });
    });
    req.once("error", (err) => resolve({ ok: false, host: name, error: String(err.message) }));
    req.end();
  });
}

module.exports = { run };
