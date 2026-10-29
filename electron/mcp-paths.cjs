/**
 * FRIDAY · where the MCP launcher lives in dev, portable, and installed layouts.
 * The script stays inside the app. It uses the app runtime.
 */
const path = require("node:path");
const layout = require("./runtime-layout.cjs");

function resolveLauncher({
  packaged = false,
  appPath,
  execPath,
  portable = false,
  runtimeRoot,
} = {}) {
  const root = String(appPath || "");
  const script = packaged
    ? path.join(root, "app.asar.unpacked", "electron", "friday-mcp.cjs")
    : path.join(root, "electron", "friday-mcp.cjs");
  const bundled = layout.findToolFile("node-win", [
    runtimeRoot || process.env.FRIDAY_RUNTIME || "",
    path.join(root, "runtime"),
  ]);
  return {
    script,
    command: bundled || execPath || process.execPath,
    packaged: Boolean(packaged),
    portable: Boolean(portable),
    env: bundled ? {} : { ELECTRON_RUN_AS_NODE: "1" },
    node: bundled || null,
  };
}

module.exports = { resolveLauncher };
