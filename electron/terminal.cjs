/**
 * FRIDAY · real workspace terminal (main process).
 *
 * The Terminal section used to answer from a hard-coded map of folders and
 * canned command output. This module replaces that with a real child process
 * running inside the FRIDAY workspace root:
 *
 *   Terminal UI → IPC → THIS MODULE → cmd.exe / sh → real stdout/stderr → UI
 *
 * Guarantees:
 *   • the working directory can never leave the FRIDAY workspace root;
 *   • one run per caller id at a time, with a hard timeout and cancellation;
 *   • `cd` is resolved here (a child process cannot change its parent's cwd);
 *   • risky commands are classified, but approval is the caller's decision —
 *     this module only executes what it is explicitly told to execute.
 *
 * Pure Node — no Electron imports — so the unit tests exercise the same code.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const WIN = process.platform === "win32";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT = 200_000;

/**
 * Commands that mutate the machine and therefore need owner approval.
 * KEEP in lockstep with `src/lib/friday/terminal-command.ts`.
 * Checks/tests (`npm test`, `git status`, `winget list`) are not listed.
 */
const RISKY = [
  /^npm\s+(ci|i|install|uninstall|publish|update)\b/i,
  /^npm\s+run\s+(build|rebuild|release|deploy|publish)\b/i,
  /^bun\s+(add|install|remove)\b/i,
  /^pnpm\s+(add|install|remove)\b/i,
  /^pnpm\s+run\s+(build|rebuild|release|deploy|publish)\b/i,
  /^yarn\s+(add|install|remove|build)\b/i,
  /^pip3?\s+install\b/i,
  /^(rm|rmdir|del|erase|format)\b/i,
  /^git\s+(push|reset|clean|checkout|commit|merge|rebase|tag|clone|pull)\b/i,
  /^winget\s+(install|uninstall|upgrade|remove)\b/i,
  /^choco\s+(install|upgrade|uninstall|pin)\b/i,
  /^scoop\s+(install|uninstall|update|import)\b/i,
  /^ollama\s+(pull|rm)\b/i,
  /^(shutdown|taskkill|reg|sc|net)\b/i,
  /^(curl|wget|iwr|Invoke-WebRequest)\b/i,
  /^docker\s+(build|compose|run|push|pull|rmi)\b/i,
  /^podman\s+(build|run|push|pull|rmi)\b/i,
  /^cargo\s+(install|publish)\b/i,
  /^go\s+(get|install)\b/i,
  /^dotnet\s+(add|publish|nuget|restore)\b/i,
  /^uv\s+(pip\s+)?(install|add|remove|sync)\b/i,
  /^deno\s+(install|compile|publish)\b/i,
  />|>>|\|/,
];

/** "exec" means the owner must approve before it runs. */
function classifyCommand(command) {
  const line = String(command || "").trim();
  if (!line) return "write";
  const parts = line.split(/\s*(?:&&|\|\||;)\s*/).filter(Boolean);
  const chunks = parts.length ? parts : [line];
  return chunks.some((part) => RISKY.some((re) => re.test(part))) ? "exec" : "write";
}

/** Resolve a path inside the root; throws when it would escape. */
function safeResolve(root, target) {
  const base = path.resolve(root);
  const next = path.resolve(base, target || ".");
  const rel = path.relative(base, next);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("path is outside the FRIDAY workspace");
  }
  return next;
}

/**
 * Pure `cd` resolution against the real filesystem.
 * Returns { ok, cwd, error } — never throws.
 */
function resolveCd(root, cwd, target, exists = (p) => fs.existsSync(p)) {
  if (!root) return { ok: false, cwd, error: "no FRIDAY workspace selected" };
  const arg = String(target || "").trim();
  if (!arg || arg === "~" || arg === "\\" || arg === "/") {
    return { ok: true, cwd: path.resolve(root) };
  }
  let next;
  try {
    next = safeResolve(root, path.isAbsolute(arg) ? arg : path.join(cwd || root, arg));
  } catch (error) {
    return { ok: false, cwd, error: String(error.message || error) };
  }
  if (!exists(next)) return { ok: false, cwd, error: `no such directory: ${arg}` };
  return { ok: true, cwd: next };
}

const running = new Map();

/**
 * Shell profiles FRIDAY can drive. Each profile turns one command line into a
 * real argv for a real interpreter — nothing here is simulated.
 */
function gitBashBin() {
  if (!WIN) return "/bin/bash";
  const homes = [
    process.env.ProgramW6432,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    "C:\\Program Files",
  ].filter(Boolean);
  for (const home of homes) {
    const candidate = path.join(home, "Git", "bin", "bash.exe");
    if (fs.existsSync(candidate)) return candidate;
  }
  return "bash.exe";
}

const SHELLS = [
  {
    id: "cmd",
    label: "Command Prompt",
    windows: true,
    bin: () => process.env.ComSpec || "cmd.exe",
    args: (line) => ["/d", "/s", "/c", line],
  },
  {
    id: "powershell",
    label: "PowerShell",
    windows: true,
    bin: () => "powershell.exe",
    args: (line) => [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      line,
    ],
  },
  {
    id: "pwsh",
    label: "PowerShell 7",
    windows: true,
    bin: () => (WIN ? "pwsh.exe" : "pwsh"),
    args: (line) => ["-NoProfile", "-NonInteractive", "-Command", line],
  },
  {
    id: "wsl",
    label: "WSL",
    windows: true,
    bin: () => (WIN ? "wsl.exe" : "wsl"),
    args: (line) => ["-e", "bash", "-lc", line],
  },
  {
    id: "git-bash",
    label: "Git Bash",
    windows: true,
    bin: () => gitBashBin(),
    args: (line) => ["-lc", line],
  },
  {
    id: "bash",
    label: "Bash",
    windows: false,
    bin: () => (WIN ? "bash.exe" : "/bin/bash"),
    args: (line) => ["-lc", line],
  },
  {
    id: "sh",
    label: "sh",
    windows: false,
    bin: () => "/bin/sh",
    args: (line) => ["-lc", line],
  },
  {
    id: "python",
    label: "Python (FRIDAY venv)",
    windows: true,
    bin: (ctx) => ctx.python || (WIN ? "python.exe" : "python3"),
    args: (line) => ["-c", line],
  },
  {
    id: "node",
    label: "Node",
    windows: true,
    bin: () => (WIN ? "node.exe" : "node"),
    args: (line) => ["-e", line],
  },
  {
    id: "termux",
    label: "Termux",
    windows: true,
    forceUnavailable: true,
    reason: () =>
      "Termux is an Android app; it is not available on this PC. Use WSL, Git Bash, or cmd.",
    bin: () => "termux",
    args: (line) => ["-c", line],
  },
];

const shellById = new Map(SHELLS.map((s) => [s.id, s]));

/** Default profile for this platform. */
const defaultShellId = () => (WIN ? "cmd" : "sh");

/** Locate an executable on PATH without spawning anything. */
function whichSync(bin) {
  if (!bin) return null;
  if (bin.includes(path.sep) || bin.includes("/")) return fs.existsSync(bin) ? bin : null;
  const exts = WIN ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(
        dir,
        bin + (bin.toLowerCase().endsWith(ext.toLowerCase()) ? "" : ext),
      );
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        /* unreadable PATH entry */
      }
    }
  }
  return null;
}

/** Which shells are actually usable on this machine right now. */
function listShells(ctx = {}) {
  return SHELLS.map((shell) => {
    const bin = shell.bin(ctx);
    const forcedOff = Boolean(shell.forceUnavailable);
    const resolved = forcedOff ? null : whichSync(bin);
    const available = Boolean(resolved);
    return {
      id: shell.id,
      label: shell.label,
      bin,
      available,
      path: resolved,
      default: shell.id === defaultShellId(),
      ...(forcedOff || !available
        ? { reason: shell.reason ? shell.reason() : `${shell.label} is not installed on this PC` }
        : {}),
    };
  });
}

/** Environment for a run: real process env plus the FRIDAY venv on PATH. */
function buildEnv(ctx = {}, extra = {}) {
  const env = { ...process.env, FORCE_COLOR: "0", CI: "1", FRIDAY_TERMINAL: "1" };
  if (ctx.python) {
    const binDir = path.dirname(ctx.python);
    env.PATH = `${binDir}${path.delimiter}${env.PATH || ""}`;
    env.VIRTUAL_ENV = path.dirname(binDir);
  }
  if (ctx.root) env.FRIDAY_ROOT = ctx.root;
  for (const [key, value] of Object.entries(extra || {})) {
    if (value !== undefined && value !== null) env[String(key)] = String(value);
  }
  return env;
}

/**
 * Execute one command for real and stream its output.
 *
 * @param {string} root      FRIDAY workspace root
 * @param {object} options   { command, cwd, runId, timeoutMs, shell, env, python }
 * @param {(event) => void} emit streaming sink
 */
function runCommand(root, options = {}, emit = () => {}) {
  return new Promise((resolve) => {
    if (!root) return resolve({ ok: false, error: "no FRIDAY workspace selected" });
    const line = String(options.command || "").trim();
    if (!line) return resolve({ ok: false, error: "no command given" });

    let workdir;
    try {
      workdir = safeResolve(root, options.cwd || ".");
    } catch (error) {
      return resolve({ ok: false, error: String(error.message || error) });
    }
    if (!fs.existsSync(workdir)) workdir = path.resolve(root);

    const runId = options.runId || `term-${Date.now().toString(36)}`;
    const timeoutMs =
      Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const started = Date.now();
    let output = "";
    let done = false;

    const ctx = { root, python: options.python || null };
    const profile = shellById.get(String(options.shell || "")) || shellById.get(defaultShellId());
    if (profile.forceUnavailable) {
      return resolve({
        ok: false,
        runId,
        error: profile.reason ? profile.reason() : `${profile.label} is not available on this PC`,
      });
    }
    const shell = profile.bin(ctx);
    const args = profile.args(line);
    if (!whichSync(shell)) {
      return resolve({ ok: false, runId, error: `${profile.label} is not installed on this PC` });
    }
    let child;
    try {
      // cmd.exe does not understand Node's backslash-escaped argument quoting,
      // so the whole command line is passed verbatim (cmd /s strips exactly the
      // outer pair of quotes and keeps everything inside untouched).
      const verbatim =
        WIN && (profile.id === "cmd" || profile.id === "powershell" || profile.id === "pwsh");
      child = spawn(
        shell,
        verbatim ? args.map((a, i) => (i === args.length - 1 ? `"${a}"` : a)) : args,
        {
          cwd: workdir,
          windowsHide: true,
          windowsVerbatimArguments: verbatim,
          env: buildEnv(ctx, options.env),
        },
      );
    } catch (error) {
      return resolve({ ok: false, error: String(error.message || error), runId });
    }

    running.set(runId, { child, command: line, cwd: workdir, shell: profile.id, started });
    emit({ runId, phase: "start", command: line, cwd: workdir, shell: profile.id });

    const push = (kind, chunk) => {
      const text = String(chunk);
      if (output.length < MAX_OUTPUT) output += text;
      emit({ runId, phase: "output", kind, text });
    };
    child.stdout?.on("data", (c) => push("out", c));
    child.stderr?.on("data", (c) => push("err", c));

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      running.delete(runId);
      const payload = {
        ...result,
        runId,
        command: line,
        cwd: workdir,
        output: output.slice(0, MAX_OUTPUT),
        ms: Date.now() - started,
      };
      emit({ ...payload, phase: "done" });
      resolve(payload);
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish({ ok: false, code: null, error: `timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);

    child.on("error", (error) =>
      finish({ ok: false, code: null, error: String(error.message || error) }),
    );
    child.on("close", (code) => finish({ ok: code === 0, code }));
  });
}

/** Kill one run (and its whole process tree on Windows). */
function cancelRun(runId) {
  const id = String(runId || "");
  const entry = running.get(id);
  if (!entry) return { ok: false, error: "no such run" };
  const child = entry.child || entry;
  try {
    if (WIN && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
    } else {
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 2000).unref?.();
    }
  } catch {
    /* already gone */
  }
  return { ok: true };
}

/** Send a line to a running command's stdin (interactive prompts, y/n, etc.). */
function writeStdin(runId, data) {
  const entry = running.get(String(runId || ""));
  if (!entry) return { ok: false, error: "no such run" };
  const child = entry.child || entry;
  if (!child.stdin || child.stdin.destroyed) return { ok: false, error: "stdin is closed" };
  try {
    const text = String(data ?? "");
    child.stdin.write(text.endsWith("\n") ? text : `${text}\n`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

/** Everything currently executing, for the UI and for FRIDAY's own checks. */
function listRuns() {
  return [...running.entries()].map(([runId, entry]) => ({
    runId,
    command: entry.command,
    cwd: entry.cwd,
    shell: entry.shell,
    ms: Date.now() - (entry.started || Date.now()),
  }));
}

module.exports = {
  RISKY,
  SHELLS,
  classifyCommand,
  resolveCd,
  runCommand,
  cancelRun,
  writeStdin,
  listRuns,
  listShells,
  whichSync,
  defaultShellId,
  safeResolve,
};
