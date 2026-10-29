// FRIDAY · tools/devices/android/android-open-app
//
// Real run() for a kernelTool pack. Delegates to the existing kernel function
// `android.open_app` via electron/kernel-tool-run.cjs (same code kernel/tools.py calls).
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "..", "electron");

async function run(input = {}) {
  const { runKernelTool } = require(path.join(ELECTRON, "kernel-tool-run.cjs"));
  return runKernelTool("android.open_app", input || {});
}

module.exports = { run };
