// FRIDAY · tools/devices/local-adapters
//
// node:os.networkInterfaces for this PC — not a remote device scan.
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

const os = require("node:os");

async function run() {
  const ifaces = os.networkInterfaces();
  const adapters = Object.entries(ifaces).map(([name, addrs]) => ({
    name,
    addresses: (addrs || []).map((item) => ({
      address: item.address,
      family: item.family,
      mac: item.mac,
      internal: item.internal,
    })),
  }));
  return { ok: true, count: adapters.length, adapters };
}

module.exports = { run };
