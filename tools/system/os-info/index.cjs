// FRIDAY · tools/system/os-info
//
// node:os identity fields.
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

const os = require("node:os");

async function run() {
  return {
    ok: true,
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    hostname: os.hostname(),
    type: os.type(),
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model || null,
    endianness: os.endianness(),
  };
}

module.exports = { run };
