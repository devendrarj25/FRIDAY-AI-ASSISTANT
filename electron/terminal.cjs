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
const { killProcessTree, stopChild, trackOwned } = require("./app-lifecycle.cjs");

const WIN = process.platform === "win32";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT = 200_000;

/**
 * Lines known to mutate the machine: always exec, even inside a chain that starts with a read.
 * KEEP `RISKY` and `SAFE_COMMANDS` identical to `src/lib/friday/terminal-command.ts`.
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

/**
 * Known read and check commands: the only lines that are safe ("write"). Everything else is "exec" and the
 * owner approves it first. A line matches only when a whole chunk (split on `&&`, `||`, `;`, `&` and new lines)
 * matches one entry and no RISKY pattern. KEEP identical to SAFE_COMMANDS in `electron/terminal.cjs`
 * (core/__tests__/terminal-command-allowlist.test.ts compares the two tables).
 */
const SAFE_COMMANDS = [
  /^git\s+(?!.*\s(?:--out|--open|-O))(?:status|diff|log|show|rev-parse|blame|ls-files|describe|shortlog|grep|--version|version)(?:\s|$)/i,
  /^git\s+branch(?:\s+(?:-a|-r|-v|-vv|--list|--show-current|--all))*\s*$/i,
  /^git\s+(?:remote\s+-v|stash\s+list)\s*$/i,
  /^(?:npm|pnpm|yarn|bun)\s+(?!.*\s--(?:script-shell|shell|userconfig|globalconfig)\b)(?:test|t|ls|list|outdated|--version|-v)(?:\s|$)/i,
  /^npm\s+(?!.*\s--(?:script-shell|shell|userconfig|globalconfig)\b)(?:view|doctor|help)(?:\s|$)/i,
  /^(?:npm|pnpm|yarn|bun)\s+run\s+(?!.*\s--(?:script-shell|shell|userconfig|globalconfig)\b)(?:test|typecheck|lint|check|docs:check|arrange:check|verify:version|check:provenance|test:fast|test:kernel|typecheck:py|pricing:status)(?:\s|$)/i,
  /^npx\s+(?!.*\s(?:--(?:fix|write)|-w)\b)(?:vitest|tsc\s+--noEmit|eslint|prettier\s+--check)(?:\s|$)/i,
  /^(?!.*\s(?:--(?:fix|write)|-w)\b)(?:vitest|pytest|ruff\s+check|eslint|tsc\s+--noEmit|prettier\s+--check)(?:\s|$)/i,
  /^(?:python3?|py)\s+-m\s+(?!.*\s(?:--(?:fix|write)|-w)\b)(?:pytest|ruff\s+check)(?:\s|$)/i,
  /^go\s+(?:(?:test|vet)(?!.*\s-(?:exec|vettool|toolexec|o|c)\b)|version|env(?!.*\s-[wu]\b))(?:\s|$)/i,
  /^cargo\s+(?!.*\s--fix\b)(?:test|check|clippy)(?:\s|$)/i,
  /^dotnet\s+(?:test|--version|--info|--list-sdks)(?:\s|$)/i,
  /^(?:node|python3?|py|pip3?|uv|deno|java|javac|rustc|cargo|go|npm|npx|git|ollama|docker|podman|winget|choco|scoop)\s+(?:--version|-v|-V|version)\s*$/i,
  /^(?:pip3?|uv\s+pip)\s+(?:list|show|freeze|check)(?:\s|$)/i,
  /^winget\s+(?:list|search|show)(?:\s|$)/i,
  /^choco\s+(?:list|search|info|outdated)(?:\s|$)/i,
  /^scoop\s+(?:list|search|info|status)(?:\s|$)/i,
  /^ollama\s+(?:list|ls|ps|show)(?:\s|$)/i,
  /^(?:docker|podman)\s+(?:ps|images|info|version)(?:\s|$)/i,
  /^ipconfig(?:\s+\/all)?\s*$/i,
  /^(?:date|time)\s+\/t\s*$/i,
  /^(?:dir|ls|pwd|whoami|hostname|ver|tree|tasklist|systeminfo|netstat|which|echo|type|cat|more|findstr|ping)(?:\s|$)/i,
  /^rg(?!.*\s--(?:pre|hostname-bin)\b)(?:\s|$)/i,
  /^(?:get-childitem|get-process|get-service|get-date|get-location|get-content|get-item|get-command|get-help|test-path|test-connection|resolve-path|write-output|write-host|gci|gps|gsv)(?:\s|$)/i,
];

/**
 * Sub-shells, sub-expressions, script blocks and process substitution can run anything inside a "read" line:
 * a backtick, `(` (covers `$(`, `@(`, `<(` and `%(`) and `{`.
 */
const EMBEDDED = /[`({]/;

const CHUNK_SPLIT = /\s*(?:&&|\|\||;|&|\r|\n)\s*/;

/**
 * "exec" means the owner must approve before it runs. "write" only when every chunk of the line is a known read
 * or check (an allowlist): an unknown command is never safe.
 */
function classifyCommand(command) {
  const line = String(command || "").trim();
  if (!line) return "write";
  if (EMBEDDED.test(line)) return "exec";
  const parts = line.split(CHUNK_SPLIT).filter(Boolean);
  const chunks = parts.length ? parts : [line];
  const safe = (part) =>
    !RISKY.some((re) => re.test(part)) && SAFE_COMMANDS.some((re) => re.test(part));
  return chunks.every(safe) ? "write" : "exec";
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

    trackOwned("terminal", child, shell);
    // A command that exits while a line is still being written must not raise EPIPE.
    child.stdin?.on("error", () => {});
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
      stopChild(child);
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
      killProcessTree(child.pid);
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
  SAFE_COMMANDS,
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
