// FRIDAY · tools/network/tls-info
//
// node:tls.connect getPeerCertificate for one named host.
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

const tls = require("node:tls");

async function run({ host, port = 443 } = {}) {
  const name = String(host || "").trim();
  if (!name) return { ok: false, error: "A host name is required." };
  const p = Number(port) || 443;
  return new Promise((resolve) => {
    const sock = tls.connect({ host: name, port: p, servername: name, timeout: 6000 }, () => {
      const cert = sock.getPeerCertificate();
      const authorized = sock.authorized;
      sock.end();
      resolve({
        ok: true,
        host: name,
        port: p,
        authorized,
        subject: cert && cert.subject ? cert.subject : null,
        issuer: cert && cert.issuer ? cert.issuer : null,
        validFrom: cert && cert.valid_from ? cert.valid_from : null,
        validTo: cert && cert.valid_to ? cert.valid_to : null,
      });
    });
    sock.once("error", (err) => resolve({ ok: false, host: name, error: String(err.message) }));
    sock.once("timeout", () => {
      sock.destroy();
      resolve({ ok: false, host: name, error: "timed out" });
    });
  });
}

module.exports = { run };
