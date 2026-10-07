// FRIDAY · tools/network/dns-lookup
//
// node:dns.promises.lookup — same resolver network-diagnostics uses.
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

const dns = require("node:dns").promises;

async function run({ host } = {}) {
  const name = String(host || "").trim();
  if (!name) return { ok: false, error: "A host name is required." };
  try {
    const addresses = await dns.lookup(name, { all: true });
    return { ok: true, host: name, addresses };
  } catch (error) {
    return { ok: false, host: name, error: String(error.message || error) };
  }
}

module.exports = { run };
