/**
 * FRIDAY — Windows process spawn for .cmd probes.
 *
 * Node 22+ DEP0190 forbids `shell: true` with an args array. Spawning
 * `cmd.exe /S /C` with each token quoted separately is also wrong: /S strips
 * the first and last quote and leaves `npm.cmd" "--version`, so Doctor reports
 * npm missing while `npm ci` just ran. One /C operand, extra outer quotes so
 * /S stripping leaves a valid command.
 *
 * Node quotes that operand again unless `windowsVerbatimArguments` is set.
 * The Windows runner then tries to execute the doubled quotes as the program
 * name. The command processor must see the operand exactly as built.
 * npm itself is probed through Node + npm-cli.js when that file sits next
 * to node.exe (spaces in the checkout path do not matter).
 */
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const win = process.platform === "win32";

function quote(part) {
  // %% is a literal percent after cmd expands the line. Quotes inside a
  // token are doubled so cmd keeps them inside the quoted argument.
  const text = String(part).replace(/%/g, "%%").replace(/"/g, '""');
  return `"${text}"`;
}

function batchLauncher(cmd, platform = process.platform) {
  const base = String(cmd)
    .replace(/^.*[\\/]/, "")
    .toLowerCase();
  if (platform === "win32" && /^(npm|npx|yarn|pnpm)$/.test(base)) return true;
  return platform === "win32" && /\.(cmd|bat)$/i.test(base);
}

function windowsExeName(cmd, platform = process.platform) {
  const text = String(cmd);
  if (platform !== "win32" || !text || batchLauncher(text, platform)) return text;
  if (/\.[^\\/]+$/.test(text)) return text;
  return `${text}.exe`;
}

/** The command line cmd.exe runs after /S strips the outer quotes. */
function cmdLineAfterSlashS(operand) {
  const text = String(operand);
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
  return text;
}

function isNpmCommand(cmd) {
  const base = path.basename(String(cmd)).toLowerCase();
  return base === "npm" || base === "npm.cmd";
}

function windowsCmdInvocation(cmd, args = []) {
  const inner = [cmd, ...args].map(quote).join(" ");
  return {
    file: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${inner}"`],
    windowsVerbatimArguments: true,
  };
}

/** File, argv, and verbatim flag for one launch. Platform is injectable. */
function planLaunch(cmd, args = [], platform = process.platform) {
  if (batchLauncher(cmd, platform)) {
    const launch = windowsCmdInvocation(cmd, args);
    return {
      file: launch.file,
      args: launch.args,
      windowsVerbatimArguments: true,
      shell: false,
    };
  }
  return {
    file: windowsExeName(cmd, platform),
    args: [...args],
    windowsVerbatimArguments: false,
    shell: false,
  };
}

function launchSpec(cmd, args, extra, sync) {
  const plan = planLaunch(cmd, args);
  const opts = sync
    ? { encoding: "utf8", windowsHide: true, ...extra, shell: false }
    : { windowsHide: true, ...extra, shell: false };
  if (plan.windowsVerbatimArguments) {
    opts.windowsVerbatimArguments = true;
    opts.shell = false;
  }
  return { file: plan.file, args: plan.args, opts };
}

function spawnDirect(cmd, args = [], extra = {}) {
  const launch = launchSpec(cmd, args, extra, true);
  return spawnSync(launch.file, launch.args, launch.opts);
}

function spawnChild(cmd, args = [], extra = {}) {
  const launch = launchSpec(cmd, args, extra, false);
  return spawn(launch.file, launch.args, launch.opts);
}

/**
 * Collect stdout and stderr. A non-zero exit with no output resolves null,
 * matching the Doctor probes that treat silence as "not installed".
 */
function captureOutput(cmd, args = [], extra = {}) {
  const timeout = Number(extra.timeout) || 0;
  const rest = { ...extra };
  delete rest.timeout;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnChild(cmd, args, { encoding: "utf8", windowsHide: true, ...rest });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    let settled = false;
    let timer = null;
    const finish = (failed) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const text = out.trim();
      resolve(failed && !text ? null : text);
    };
    if (timeout > 0) {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        finish(true);
      }, timeout);
    }
    child.stdout?.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", () => finish(true));
    child.on("close", (code) => finish(code !== 0));
  });
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

module.exports = {
  spawnCaptured,
  spawnNpm,
  spawnDirect,
  spawnChild,
  npmCliJs,
  windowsCmdInvocation,
  planLaunch,
  batchLauncher,
  windowsExeName,
  cmdLineAfterSlashS,
  quote,
  captureOutput,
};
