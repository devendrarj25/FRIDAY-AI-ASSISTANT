// FRIDAY · tools/devices/bluetooth/bluetooth-send-file
//
// Real run() for a kernelTool pack. Delegates to the existing kernel function
// `bluetooth.send_file` via electron/kernel-tool-run.cjs (same code kernel/tools.py calls).
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "..", "electron");

async function run(input = {}) {
  const { runKernelTool } = require(path.join(ELECTRON, "kernel-tool-run.cjs"));
  return runKernelTool("bluetooth.send_file", input || {});
}

module.exports = { run };
