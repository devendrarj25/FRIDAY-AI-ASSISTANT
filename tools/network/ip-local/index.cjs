// FRIDAY · tools/network/ip-local
//
// node:os.networkInterfaces(). Also reused by system-monitor.lanAddresses.
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

const os = require("node:os");

async function run() {
  const monitor = require(path.join(ELECTRON, "system-monitor.cjs"));
  const lan = typeof monitor.lanAddresses === "function" ? monitor.lanAddresses() : null;
  const ifaces = os.networkInterfaces();
  const addresses = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const item of list || []) {
      if (item.internal) continue;
      addresses.push({ iface: name, address: item.address, family: item.family });
    }
  }
  return { ok: true, lan, addresses };
}

module.exports = { run };
