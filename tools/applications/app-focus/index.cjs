// FRIDAY · tools/applications/app-focus
//
// Real run() for a kernelTool pack. Delegates to the existing kernel function
// `app.focus` via electron/kernel-tool-run.cjs (same code kernel/tools.py calls).
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run(input = {}) {
  const { runKernelTool } = require(path.join(ELECTRON, "kernel-tool-run.cjs"));
  return runKernelTool("app.focus", input || {});
}

module.exports = { run };
