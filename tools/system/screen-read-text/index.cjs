// FRIDAY · tools/system/screen-read-text
//
// Real run() for a kernelTool pack. Delegates to the existing kernel function
// `screen.read_text` via electron/kernel-tool-run.cjs (same code kernel/tools.py calls).
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run(input = {}) {
  const { runKernelTool } = require(path.join(ELECTRON, "kernel-tool-run.cjs"));
  return runKernelTool("screen.read_text", input || {});
}

module.exports = { run };
