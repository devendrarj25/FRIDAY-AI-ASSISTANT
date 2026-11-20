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

/**
 * npm.cmd with one quoted token per argument exits before the script on
 * windows-latest. Node's shell form joins the tokens once; Run tests passed
 * that line. Prefer Node plus npm-cli.js so a space in the path never reaches
 * cmd. The joined line is only the fallback when that file is absent.
 */
function npmPlan(args = [], platform = process.platform, cli = undefined) {
  const resolved = cli === undefined ? npmCliJs() : cli;
  if (resolved) {
    return {
      file: process.execPath,
      args: [resolved, ...args],
      windowsVerbatimArguments: false,
    };
  }
  if (platform === "win32") {
    const command = ["npm.cmd", ...args].join(" ");
    return {
      file: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", `"${command}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { file: "npm", args: [...args], windowsVerbatimArguments: false };
}

function applyPlan(plan, extra, sync) {
  const opts = sync
    ? { encoding: "utf8", windowsHide: true, ...extra, shell: false }
    : { windowsHide: true, ...extra, shell: false };
  opts.windowsVerbatimArguments = Boolean(plan.windowsVerbatimArguments);
  opts.shell = false;
  return { file: plan.file, args: plan.args, opts };
}

/**
 * GNU tar (the tar on the Windows runner) reads `C:` in the archive name as
 * a remote host: `Cannot connect to C: resolve failed`. The archive is the
 * basename, and the process cwd is its directory, so the colon stays in
 * Node's cwd. `-C` stays an absolute local directory. `--force-local` is
 * added only when the basename itself still contains a colon.
 */
function localTar(archive, args = [], pathApi = path) {
  const absArchive = pathApi.resolve(String(archive || ""));
  const cwd = pathApi.dirname(absArchive);
  const base = pathApi.basename(absArchive);
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg === "-C" || arg === "--directory") {
      out.push(arg);
      i += 1;
      if (i < args.length) out.push(pathApi.resolve(String(args[i])));
      continue;
    }
    if (arg === archive || pathApi.resolve(arg) === absArchive) {
      out.push(base);
      continue;
    }
    out.push(arg);
  }
  if (base.includes(":") && !out.includes("--force-local")) out.unshift("--force-local");
  return { cwd, args: out };
}

function spawnDirect(cmd, args = [], extra = {}) {
  const launch = launchSpec(cmd, args, extra, true);
  return spawnSync(launch.file, launch.args, launch.opts);
}

/**
 * The environment a child process gets. On Windows a plain copy of process.env can carry the search path under two
 * spellings ("Path" and "PATH") after a script assigns env.PATH on the copy; cmd.exe then reads one of them and
 * npm's own addition (node_modules\\.bin and the folder of node.exe) lands in the other, which ends as
 * "'node' is not recognized" or "'vite' is not recognized". One "Path" key, each folder once, is what every child
 * should see. Off Windows the copy is returned as it is.
 */
function cleanEnv(env = process.env, platform = process.platform) {
  const out = { ...env };
  if (platform !== "win32") return out;
  const keys = Object.keys(out).filter((name) => name.toLowerCase() === "path");
  if (!keys.length) return out;
  const seen = new Set();
  const dirs = [];
  for (const key of keys) {
    for (const part of String(out[key] || "").split(";")) {
      const dir = part.trim();
      const id = dir.replace(/[\\/]+$/, "").toLowerCase();
      if (!dir || seen.has(id)) continue;
      seen.add(id);
      dirs.push(dir);
    }
    delete out[key];
  }
  out.Path = dirs.join(";");
  return out;
}

/**
 * The renderer bundle: vite's own script run by this node, with no npm, no cmd.exe and no command link. It does
 * not depend on the PATH a shell would build, which is what broke `npm run build:desktop` on a PC where cmd.exe
 * could find neither vite nor node.
 */
function viteBuildPlan(root, platform = process.platform) {
  void platform;
  const script = path.join(root, "node_modules", "vite", "bin", "vite.js");
  return {
    file: process.execPath,
    args: [script, "build", "--config", "vite.electron.config.ts"],
    script,
    present: fs.existsSync(script),
  };
}

function spawnViteBuild(root, extra = {}) {
  const plan = viteBuildPlan(root);
  if (!plan.present) {
    return { status: 1, error: new Error(`vite is not installed (${plan.script} is missing)`) };
  }
  return spawnSync(plan.file, plan.args, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    ...extra,
    env: cleanEnv(extra.env || process.env),
  });
}

/**
 * npm redraws a spinner on a console, which blinks, and prints a "deprecated" warning for every old package inside
 * electron-builder's own dependency tree (inflight, rimraf 2, glob 7) that FRIDAY cannot change. Progress is off and
 * only errors are printed; a caller's own npm_config_progress / npm_config_loglevel wins.
 */
function quietNpm(extra = {}) {
  return {
    ...extra,
    env: cleanEnv({
      npm_config_progress: "false",
      npm_config_loglevel: "error",
      ...(extra.env || process.env),
    }),
  };
}

function spawnNpm(args = [], extra = {}) {
  const launch = applyPlan(npmPlan(args), quietNpm(extra), true);
  return spawnSync(launch.file, launch.args, launch.opts);
}

function spawnChild(cmd, args = [], extra = {}) {
  if (isNpmCommand(cmd)) {
    const launch = applyPlan(npmPlan(args), quietNpm(extra), false);
    return spawn(launch.file, launch.args, launch.opts);
  }
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
      child = spawnChild(cmd, args, {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        ...rest,
      });
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

function spawnCaptured(cmd, args = [], extra = {}) {
  if (isNpmCommand(cmd)) return spawnNpm(args, extra);
  return spawnDirect(cmd, args, extra);
}

module.exports = {
  cleanEnv,
  viteBuildPlan,
  spawnViteBuild,
  spawnCaptured,
  spawnNpm,
  spawnDirect,
  spawnChild,
  npmCliJs,
  npmPlan,
  localTar,
  windowsCmdInvocation,
  planLaunch,
  batchLauncher,
  windowsExeName,
  cmdLineAfterSlashS,
  quote,
  captureOutput,
};
