/**
 * FRIDAY — Windows process spawn for .cmd probes.
 *
 * Node 22+ DEP0190 forbids `shell: true` with an args array. Spawning
 * `cmd.exe /S /C` with each token quoted separately is also wrong: /S strips
 * the first and last quote and leaves `npm.cmd" "--version`, so Doctor reports
 * npm missing while `npm ci` just ran. One /C operand, extra outer quotes so
 * /S stripping leaves a valid command. npm itself is probed through Node +
 * npm-cli.js when that file sits next to node.exe (spaces in the checkout
 * path do not matter).
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const win = process.platform === "win32";

function quote(part) {
  return `"${String(part).replace(/"/g, '""')}"`;
}

function isNpmCommand(cmd) {
  const base = path.basename(String(cmd)).toLowerCase();
  return base === "npm" || base === "npm.cmd";
}

function spawnDirect(cmd, args = [], extra = {}) {
  const opts = { encoding: "utf8", windowsHide: true, ...extra };
  if (win && /\.(cmd|bat)$/i.test(String(cmd))) {
    const inner = [cmd, ...args].map(quote).join(" ");
    return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${inner}"`], opts);
  }
  return spawnSync(cmd, args, opts);
}

function npmCliJs() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(
      path.dirname(process.execPath),
      "..",
      "lib",
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
  ];
  return candidates.find((file) => file && fs.existsSync(file)) || null;
}

function spawnNpm(args = [], extra = {}) {
  const cli = npmCliJs();
  if (cli) return spawnDirect(process.execPath, [cli, ...args], extra);
  return spawnDirect(win ? "npm.cmd" : "npm", args, extra);
}

function spawnCaptured(cmd, args = [], extra = {}) {
  if (isNpmCommand(cmd)) return spawnNpm(args, extra);
  return spawnDirect(cmd, args, extra);
}

module.exports = { spawnCaptured, spawnNpm, npmCliJs };
