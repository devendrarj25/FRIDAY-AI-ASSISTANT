// FRIDAY · tools/system/system-health
//
// Real snapshot. It reuses the existing probes in electron/hardware.cjs — no
// duplicated detection logic — and adds live OS counters from node:os.
const os = require("node:os");
const path = require("node:path");

const hardware = require(path.join(__dirname, "..", "..", "..", "electron", "hardware.cjs"));

async function run() {
  const [hw, sensors] = await Promise.all([
    hardware.detectHardware().catch((error) => ({ error: String(error.message || error) })),
    hardware.detectSensors().catch((error) => ({ error: String(error.message || error) })),
  ]);
  const load = os.loadavg();
  return {
    ok: true,
    at: Date.now(),
    host: { platform: process.platform, release: os.release(), arch: process.arch },
    cpu: { cores: os.cpus().length, model: os.cpus()[0]?.model || null, loadAvg: load },
    memory: {
      totalMb: Math.round(os.totalmem() / 1048576),
      freeMb: Math.round(os.freemem() / 1048576),
      usedPct: Math.round((1 - os.freemem() / os.totalmem()) * 100),
    },
    uptimeSec: Math.round(os.uptime()),
    hardware: hw,
    sensors,
  };
}

module.exports = { run };
