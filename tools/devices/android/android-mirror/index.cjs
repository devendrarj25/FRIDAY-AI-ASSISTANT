// FRIDAY · tools/devices/android/android-mirror
//
// Real run() for a kernelTool pack. Delegates to the existing kernel function
// `android.mirror` via electron/kernel-tool-run.cjs (same code kernel/tools.py calls).
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "..", "electron");

async function run(input = {}) {
  const { runKernelTool } = require(path.join(ELECTRON, "kernel-tool-run.cjs"));
  return runKernelTool("android.mirror", input || {});
}

module.exports = { run };
