/**
 * FRIDAY · where the MCP launcher lives in dev, portable, and installed layouts.
 * The script stays inside the app. It uses the app runtime.
 */
const path = require("node:path");

function resolveLauncher({ packaged = false, appPath, execPath, portable = false } = {}) {
  const root = String(appPath || "");
  const script = packaged
    ? path.join(root, "app.asar.unpacked", "electron", "friday-mcp.cjs")
    : path.join(root, "electron", "friday-mcp.cjs");
  return {
    script,
    command: execPath || process.execPath,
    packaged: Boolean(packaged),
    portable: Boolean(portable),
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

module.exports = { resolveLauncher };
