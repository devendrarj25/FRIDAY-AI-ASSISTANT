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
 * KEEP `RISKY`, `SAFE_COMMANDS` and the classifier identical to `src/lib/friday/terminal-command.ts`.
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
 * One read or check command and the arguments it may take. A line is safe ("write") only when its leading words
 * name a rule here and every later token is on that rule: a known flag, a flag with a plain value, or a plain
 * positional. Everything else is "exec" and the owner approves it first. KEEP identical to SAFE_COMMANDS in
 * `electron/terminal.cjs` (core/__tests__/terminal-argv-classifier.test.ts compares the two tables).
 *
 * cmd      the leading words, lower case.
 * flags    flags that take no value. values: flags that take one (`-n 5`, `--max-count=5`).
 * cluster  single-dash letters that may be combined (`-la`). numeric: `-5` is allowed.
 * pos      positionals: "any" plain value, "name" an identifier, "none".
 * ci       flags compare case-insensitively (PowerShell, tsc). go: `--flag` is read as `-flag`, as Go does.
 * slash    Windows `/x` flags (a `/` token is then a flag, never a path). slashv: `/x:value` forms.
 * need     at least one of these flags must be present. dd: `--` (end of flags) is allowed.
 * any      every token is a plain value (echo). internal: built into cmd, so a planted program cannot shadow it.
 */
const GIT_DIFF = ["--stat", "--name-only", "--name-status", "--shortstat", "--numstat"];
const GIT_SAFE = ["--no-color", "--no-ext-diff", "--no-textconv"];
const PYTEST = {
  flags: [
    "-q",
    "-v",
    "-x",
    "-s",
    "-l",
    "-vv",
    "-qq",
    "--quiet",
    "--verbose",
    "--exitfirst",
    "--lf",
    "--ff",
  ],
  values: ["-k", "-m", "--maxfail", "--tb", "--durations"],
  cluster: "qvxsl",
  pos: "any",
};
const RUFF = {
  flags: ["-q", "--quiet", "--statistics", "--no-fix", "--exit-zero"],
  values: ["--select", "--ignore", "--extend-select", "--output-format", "--target-version"],
  pos: "any",
};
const VITEST = {
  flags: ["--run", "--silent", "--passWithNoTests", "--no-color"],
  values: ["-t", "--testNamePattern"],
  pos: "any",
};
const ESLINT = {
  flags: ["--quiet", "--no-color"],
  values: ["--max-warnings", "--ext"],
  pos: "any",
};
const PRETTIER = {
  flags: ["--check", "-c", "--list-different", "-l", "--ignore-unknown"],
  need: ["--check", "-c", "--list-different", "-l"],
  pos: "any",
};
const TSC = {
  flags: ["--noemit", "--pretty", "--skiplibcheck"],
  values: ["-p", "--project"],
  need: ["--noemit"],
  ci: true,
  pos: "any",
};
const CARGO = {
  flags: ["--workspace", "--all", "-q", "--quiet", "--lib", "--tests", "--all-targets"],
  values: ["-p", "--package"],
  pos: "any",
};
const PS_LIST = {
  flags: ["-recurse", "-force", "-name", "-file", "-directory", "-hidden"],
  values: ["-path", "-filter", "-include", "-exclude", "-depth"],
  ci: true,
  pos: "any",
};
const SCRIPTS = [
  "test",
  "typecheck",
  "lint",
  "check",
  "docs:check",
  "arrange:check",
  "verify:version",
];
const MORE_SCRIPTS = [
  "check:provenance",
  "test:fast",
  "test:kernel",
  "typecheck:py",
  "pricing:status",
];
const VERSION_TOOLS = [
  "node",
  "python",
  "python3",
  "py",
  "pip",
  "pip3",
  "uv",
  "deno",
  "java",
  "javac",
  "rustc",
];
const MORE_VERSION_TOOLS = [
  "cargo",
  "go",
  "npm",
  "npx",
  "git",
  "ollama",
  "docker",
  "podman",
  "winget",
  "choco",
  "scoop",
];
const SAFE_COMMANDS = [
  {
    cmd: "git status",
    flags: ["-s", "--short", "-b", "--branch", "--porcelain", "--ignored", "--long", "-v"],
    cluster: "sbv",
    pos: "any",
    dd: true,
  },
  {
    cmd: "git diff",
    flags: [...GIT_DIFF, ...GIT_SAFE, "--cached", "--staged", "--check", "-w"],
    pos: "any",
    dd: true,
  },
  {
    cmd: "git log",
    flags: [
      ...GIT_DIFF,
      ...GIT_SAFE,
      "--oneline",
      "--graph",
      "--decorate",
      "--all",
      "-p",
      "--patch",
      "--no-merges",
      "--first-parent",
      "--reverse",
    ],
    values: ["-n", "--max-count", "--since", "--until", "--author", "--grep", "--skip"],
    numeric: true,
    pos: "any",
    dd: true,
  },
  {
    cmd: "git show",
    flags: [...GIT_DIFF, ...GIT_SAFE, "--oneline", "--no-patch", "-s"],
    pos: "any",
    dd: true,
  },
  {
    cmd: "git rev-parse",
    flags: [
      "--abbrev-ref",
      "--short",
      "--show-toplevel",
      "--git-dir",
      "--is-inside-work-tree",
      "--verify",
    ],
    pos: "any",
  },
  {
    cmd: "git blame",
    flags: ["-w", "-s", "-e", "-l", "--porcelain"],
    values: ["-L"],
    cluster: "wsel",
    pos: "any",
    dd: true,
  },
  {
    cmd: "git ls-files",
    flags: [
      "-m",
      "-o",
      "-c",
      "-d",
      "-s",
      "--others",
      "--cached",
      "--deleted",
      "--modified",
      "--exclude-standard",
      "--stage",
    ],
    cluster: "mocds",
    pos: "any",
    dd: true,
  },
  {
    cmd: "git describe",
    flags: ["--tags", "--always", "--long"],
    values: ["--abbrev"],
    pos: "any",
  },
  {
    cmd: "git shortlog",
    flags: ["-s", "-n", "-e", "--summary", "--numbered", "--email"],
    cluster: "sne",
    pos: "any",
  },
  {
    cmd: "git grep",
    flags: [
      "-n",
      "-i",
      "-l",
      "-w",
      "-c",
      "-v",
      "-E",
      "-F",
      "-I",
      "--count",
      "--line-number",
      "--ignore-case",
      "--files-with-matches",
      "--word-regexp",
      "--cached",
    ],
    values: ["-e"],
    cluster: "nilwcvEFI",
    pos: "any",
    dd: true,
  },
  {
    cmd: "git branch",
    flags: ["-a", "-r", "-v", "-vv", "--list", "--show-current", "--all", "--remotes", "--verbose"],
    cluster: "arv",
    pos: "none",
  },
  { cmd: "git remote", flags: ["-v", "--verbose"], pos: "none" },
  { cmd: "git stash list", pos: "none" },
  ...["npm", "pnpm", "yarn", "bun"].flatMap((pm) => [
    { cmd: `${pm} test`, pos: "none" },
    ...[...SCRIPTS, ...MORE_SCRIPTS].map((script) => ({
      cmd: `${pm} run ${script}`,
      pos: "none",
    })),
  ]),
  { cmd: "npm t", pos: "none" },
  ...["npm ls", "npm list", "pnpm ls", "pnpm list", "yarn list"].map((cmd) => ({
    cmd,
    flags: ["--all"],
    values: ["--depth"],
    pos: "any",
  })),
  { cmd: "npm help", pos: "any" },
  ...["", "npx "].flatMap((pre) => [
    { cmd: `${pre}vitest`, ...VITEST },
    { cmd: `${pre}eslint`, ...ESLINT },
    { cmd: `${pre}prettier`, ...PRETTIER },
    { cmd: `${pre}tsc`, ...TSC },
  ]),
  { cmd: "pytest", ...PYTEST },
  { cmd: "ruff check", ...RUFF },
  ...["python", "python3", "py"].flatMap((py) => [
    { cmd: `${py} -m pytest`, ...PYTEST },
    { cmd: `${py} -m ruff check`, ...RUFF },
  ]),
  {
    cmd: "go test",
    go: true,
    flags: ["-v", "-short", "-race", "-cover", "-failfast", "-json"],
    values: ["-run", "-skip", "-count", "-timeout", "-bench", "-benchtime", "-parallel", "-cpu"],
    pos: "any",
  },
  { cmd: "go vet", go: true, flags: ["-json"], pos: "any" },
  { cmd: "go env", go: true, flags: ["-json"], pos: "name" },
  ...["cargo test", "cargo check", "cargo clippy"].map((cmd) => ({ cmd, ...CARGO })),
  { cmd: "dotnet test", pos: "any" },
  ...["dotnet --version", "dotnet --info", "dotnet --list-sdks"].map((cmd) => ({
    cmd,
    pos: "none",
  })),
  ...[...VERSION_TOOLS, ...MORE_VERSION_TOOLS].flatMap((tool) =>
    ["--version", "-v", "version"].map((form) => ({
      cmd: `${tool} ${form}`,
      pos: "none",
    })),
  ),
  ...["pip", "pip3", "uv pip"].flatMap((pip) =>
    ["list", "show", "freeze", "check"].map((verb) => ({
      cmd: `${pip} ${verb}`,
      pos: "any",
    })),
  ),
  { cmd: "winget list", pos: "any" },
  { cmd: "choco list", pos: "any" },
  ...["scoop list", "scoop info"].map((cmd) => ({ cmd, pos: "any" })),
  ...["ollama list", "ollama ls", "ollama ps"].map((cmd) => ({ cmd, pos: "none" })),
  {
    cmd: "ollama show",
    flags: ["--modelfile", "--license", "--parameters", "--template", "--system"],
    pos: "any",
  },
  ...["docker", "podman"].flatMap((tool) =>
    ["ps", "images", "info"].map((verb) => ({
      cmd: `${tool} ${verb}`,
      flags: ["-a", "--all", "-q", "--quiet"],
      cluster: "aq",
      pos: "none",
    })),
  ),
  { cmd: "ipconfig", slash: ["/all", "/displaydns"], ci: true, pos: "none" },
  ...["date", "time"].map((cmd) => ({
    cmd,
    slash: ["/t"],
    need: ["/t"],
    ci: true,
    pos: "none",
    internal: true,
  })),
  {
    cmd: "dir",
    ...PS_LIST,
    slash: ["/s", "/b", "/w", "/p", "/q", "/d", "/l", "/n", "/x", "/4", "/a", "/o"],
    slashv: ["/a", "/o", "/t"],
    internal: true,
  },
  { cmd: "ls", ...PS_LIST, cluster: "alhrtsdfgin1" },
  ...["gci", "get-childitem"].map((cmd) => ({ cmd, ...PS_LIST })),
  ...["pwd", "hostname", "systeminfo", "get-location"].map((cmd) => ({
    cmd,
    pos: "none",
  })),
  { cmd: "ver", pos: "none", internal: true },
  {
    cmd: "whoami",
    slash: ["/user", "/groups", "/priv", "/all", "/upn", "/fqdn"],
    ci: true,
    pos: "none",
  },
  { cmd: "tasklist", slash: ["/v", "/svc"], ci: true, pos: "none" },
  { cmd: "tree", slash: ["/f", "/a"], ci: true, pos: "any" },
  {
    cmd: "netstat",
    flags: ["-a", "-n", "-o", "-b", "-r", "-s", "-e", "-f", "-q", "-x", "-y"],
    values: ["-p"],
    cluster: "anobrsefqxy",
    pos: "none",
  },
  { cmd: "which", flags: ["-a"], pos: "any" },
  ...["echo", "write-output", "write-host"].map((cmd) => ({
    cmd,
    any: true,
    pos: "any",
    internal: cmd === "echo",
  })),
  { cmd: "type", pos: "any", internal: true },
  { cmd: "cat", flags: ["-n", "-A", "-b", "-s", "-E", "-T", "-v"], cluster: "nAbsETv", pos: "any" },
  { cmd: "more", pos: "any" },
  {
    cmd: "findstr",
    slash: ["/s", "/i", "/n", "/r", "/l", "/x", "/v", "/m", "/b", "/e"],
    slashv: ["/c"],
    ci: true,
    pos: "any",
  },
  {
    cmd: "rg",
    flags: [
      "-n",
      "-i",
      "-S",
      "-w",
      "-l",
      "-c",
      "-F",
      "-v",
      "-u",
      "-uu",
      "-L",
      "-x",
      "--hidden",
      "--no-ignore",
      "--files",
      "--line-number",
      "--ignore-case",
      "--smart-case",
      "--fixed-strings",
      "--count",
      "--files-with-matches",
      "--word-regexp",
      "--json",
    ],
    values: [
      "-g",
      "--glob",
      "-t",
      "--type",
      "-T",
      "--type-not",
      "-e",
      "--regexp",
      "-A",
      "-B",
      "-C",
      "-m",
      "--max-count",
      "--max-depth",
    ],
    cluster: "niSwlcFvuLx",
    pos: "any",
  },
  { cmd: "get-date", values: ["-format", "-uformat"], ci: true, pos: "none" },
  ...["get-process", "gps"].map((cmd) => ({
    cmd,
    values: ["-name", "-id"],
    ci: true,
    pos: "any",
  })),
  ...["get-service", "gsv"].map((cmd) => ({
    cmd,
    values: ["-name"],
    ci: true,
    pos: "any",
  })),
  {
    cmd: "get-content",
    flags: ["-raw"],
    values: ["-path", "-totalcount", "-tail", "-head", "-encoding"],
    ci: true,
    pos: "any",
  },
  { cmd: "get-item", flags: ["-force"], values: ["-path"], ci: true, pos: "any" },
  { cmd: "get-command", values: ["-name"], ci: true, pos: "any" },
  {
    cmd: "get-help",
    flags: ["-full", "-examples", "-detailed"],
    values: ["-name"],
    ci: true,
    pos: "any",
  },
  { cmd: "test-path", values: ["-path", "-pathtype"], ci: true, pos: "any" },
  { cmd: "resolve-path", flags: ["-relative"], values: ["-path"], ci: true, pos: "any" },
];
/**
 * Shell syntax that runs or redirects something else, in any of cmd, PowerShell and sh: sub-shells, script blocks,
 * variables (`$x`, `%x%`, `!x!`), redirection, pipes, a lone `&` or `;`, a backtick, an escaped or doubled quote
 * (older C runtimes and PowerShell 5.1 split or drop those), and the typographic quotes and dashes PowerShell reads as plain ones. Control characters (a bare carriage return is a new
 * line to PowerShell) and a caret or backslash that joins the next line are refused too.
 */
const SHELL_SYNTAX = /[`$(){}<>|;&%!\u2013-\u2015\u2018-\u201f]|\\["']|\^["']|["']\^|""|''/;
const CONTROL = /\p{Cc}/u;
const JOINS_NEXT_LINE = /[\^\\]\r?\n/;
/** Split one chunk into argv tokens. `posix` reads single quotes, backslash escapes and PowerShell array commas; the
 * cmd reading knows only double quotes and caret escapes. Null when a quote is left open or a token is empty. */
function tokenize(chunk, posix) {
  const out = [];
  let text = "";
  let escaped = false;
  let raw0 = "";
  let started = false;
  let quote = "";
  const push = () => {
    if (started) out.push({ text, escaped, raw0 });
    text = "";
    escaped = false;
    raw0 = "";
    started = false;
  };
  for (let i = 0; i < chunk.length; i += 1) {
    const ch = chunk.charAt(i);
    if (!started && !/\s/.test(ch)) {
      started = true;
      raw0 = ch;
    }
    if (quote) {
      if (ch === quote) quote = "";
      else if (quote === "'" && ch === '"') return null;
      else text += ch;
      continue;
    }
    if (/\s/.test(ch) || (posix && ch === ",")) {
      push();
      continue;
    }
    if (ch === '"' || (posix && ch === "'")) {
      quote = ch;
      escaped = true;
    } else if ((posix && ch === "\\") || (!posix && ch === "^")) {
      escaped = true;
      const next = chunk.charAt(i + 1);
      if (!next) text += posix ? ch : "";
      else {
        text += next;
        i += 1;
      }
    } else text += ch;
  }
  if (quote) return null;
  push();
  return out.every((token) => token.text.length > 0) ? out : null;
}
/** A plain value: not a URL, not a UNC or remote path, not a glob the shell could expand into a flag, not a splat. */
function plainValue(token) {
  const text = token.text;
  if (!text || text.includes("://") || /^[\\/]{2}/.test(text)) return false;
  if (/^(?:file|https?|ftps?|ssh|smb|git):/i.test(text)) return false;
  return !/^[*?[@]/.test(token.raw0);
}
function ruleFor(tokens) {
  let best = null;
  for (const rule of SAFE_COMMANDS) {
    const words = rule.cmd.split(" ");
    if (words.length > tokens.length || (best && words.length <= best.used)) continue;
    const match = words.every((word, i) => {
      const token = tokens[i];
      return Boolean(token) && !token?.escaped && token?.text.toLowerCase() === word;
    });
    if (match) best = { rule, used: words.length };
  }
  return best;
}
function argsAllowed(rule, args) {
  const flags = rule.flags || [];
  const values = rule.values || [];
  const seen = [];
  let ended = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    const slashFlag = Boolean(rule.slash) && token.text.startsWith("/");
    if (rule.any || ended || !(token.text.startsWith("-") || slashFlag)) {
      if (rule.pos === "none" && !rule.any) return false;
      if (rule.pos === "name" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(token.text)) return false;
      if (!plainValue(token)) return false;
      continue;
    }
    if (token.escaped) return false;
    let flag = rule.ci ? token.text.toLowerCase() : token.text;
    if (rule.go && flag.startsWith("--")) flag = flag.slice(1);
    if (flag === "--") {
      if (!rule.dd) return false;
      ended = true;
      continue;
    }
    if (slashFlag) {
      const [name = "", value] = flag.split(/:(.*)/s);
      if (
        value === undefined
          ? !(rule.slash || []).includes(name)
          : !(rule.slashv || []).includes(name) || !/^[a-z0-9-]+$/i.test(value)
      )
        return false;
      seen.push(name);
      continue;
    }
    const eq = flag.indexOf("=");
    if (eq > 0) {
      const name = flag.slice(0, eq);
      const value = token.text.slice(token.text.indexOf("=") + 1);
      if (
        !values.includes(name) ||
        !plainValue({ text: value, escaped: false, raw0: value.charAt(0) })
      )
        return false;
      seen.push(name);
      continue;
    }
    if (flags.includes(flag)) seen.push(flag);
    else if (values.includes(flag)) {
      const value = args[i + 1];
      if (!value || value.text.startsWith("-") || !plainValue(value)) return false;
      seen.push(flag);
      i += 1;
    } else if (rule.numeric && /^-\d+$/.test(flag)) seen.push(flag);
    else if (
      !rule.cluster ||
      !/^-[A-Za-z0-9]+$/.test(flag) ||
      ![...flag.slice(1)].every((c) => rule.cluster.includes(c))
    )
      return false;
    else seen.push(flag);
  }
  return !rule.need || rule.need.some((flag) => seen.includes(flag));
}
/** One chunk under both readings (sh or PowerShell, and cmd): safe only when both find a rule that takes every token. */
function chunkAllowed(chunk, untrusted) {
  for (const posix of [true, false]) {
    const tokens = tokenize(chunk, posix);
    if (!tokens || !tokens.length) return false;
    const found = ruleFor(tokens);
    if (!found || (untrusted && !found.rule.internal)) return false;
    if (!argsAllowed(found.rule, tokens.slice(found.used))) return false;
  }
  return true;
}
/**
 * "exec" means the owner must approve before it runs. "write" only when every chunk of the line (split on `&&` and
 * new lines) is a known read or check whose every argument is on its rule (an allowlist): an unknown command, flag or
 * shell construct is never safe. `untrusted` (a folder with its own repository or project) also counts every command
 * that is not built into cmd as exec, since it can run that folder's hooks, scripts, config or a planted program.
 */
function classifyCommand(command, options = {}) {
  const line = String(command || "").trim();
  if (!line) return "write";
  if (JOINS_NEXT_LINE.test(line)) return "exec";
  const chunks = line
    .split(/&&|\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!chunks.length) return "write";
  const untrusted = options.untrusted === true;
  const safe = (part) =>
    !SHELL_SYNTAX.test(part) &&
    !CONTROL.test(part.replace(/\t/g, " ")) &&
    !RISKY.some((re) => re.test(part)) &&
    chunkAllowed(part, untrusted);
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

/** Files that make a folder its own repository or project, with hooks, scripts or config that a tool runs. */
const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "pyproject.toml",
  "setup.py",
  "go.mod",
  "Cargo.toml",
];

/**
 * True when a command run in `cwd` could run code that is not the owner's: the folder, or a folder between it and
 * the workspace root, holds its own repository or project (a clone, a downloaded package). The root itself is the
 * owner's workspace. A folder that cannot be resolved inside the root is never called trusted.
 */
function isUntrustedFolder(root, cwd, exists = (p) => fs.existsSync(p)) {
  let dir;
  try {
    dir = safeResolve(root, String(cwd || "") || ".");
  } catch {
    return true;
  }
  const base = path.resolve(root);
  while (dir !== base) {
    const here = dir;
    if (PROJECT_MARKERS.some((name) => exists(path.join(here, name)))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return true;
    dir = parent;
  }
  return false;
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
  isUntrustedFolder,
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
