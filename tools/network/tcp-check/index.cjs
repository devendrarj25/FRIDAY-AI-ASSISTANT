// FRIDAY · tools/network/tcp-check
//
// node:net.connect — same helper shape as network-diagnostics tcp().
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

const net = require("node:net");

async function run({ host, port = 443 } = {}) {
  const name = String(host || "").trim();
  if (!name) return { ok: false, error: "A host name is required." };
  const p = Number(port) || 443;
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host: name, port: p });
    const done = (ok, error) => {
      socket.destroy();
      resolve({ ok, host: name, port: p, ms: Date.now() - started, ...(error ? { error } : {}) });
    };
    socket.setTimeout(4000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false, "timed out after 4000ms"));
    socket.once("error", (err) => done(false, String(err.message)));
  });
}

module.exports = { run };
