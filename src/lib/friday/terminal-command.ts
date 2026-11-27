/**
 * FRIDAY · workspace-terminal command parsing
 *
 * Pure helpers shared by the Terminal page, the ops engine, and the baseline
 * brain. They never spawn a process — `electron/terminal.cjs` is the one
 * executor. Natural-language lines are classified as asks so `cmd.exe` is not
 * fed English questions.
 *
 * KEEP `RISKY` and `SAFE_COMMANDS` identical to `electron/terminal.cjs`.
 */

/** Lines known to mutate the machine: always exec, even inside a chain that starts with a read. */
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

const BUILTINS = new Set([
  "help",
  "pwd",
  "cd",
  "cls",
  "clear",
  "shells",
  "shell",
  "home",
  "history",
]);

const SHELL_VERBS =
  /^(git|npm|npx|pnpm|yarn|bun|node|python|python3|pip|pip3|py|dir|ls|cd|echo|type|cat|pwd|whoami|hostname|ipconfig|ping|curl|wget|tasklist|systeminfo|netstat|wmic|powershell|pwsh|cmd|bash|wsl|cargo|go|docker|podman|kubectl|choco|winget|scoop|ollama|pytest|vitest|tsc|eslint|ruff|rg|findstr|where|which|mkdir|md|copy|move|ren|del|rmdir|attrib|tree|more|sort|fc|comp|xcopy|robocopy|schtasks|sc|net|gpupdate|gpresult|get-childitem|get-process|get-service|get-date|get-location|set-location|write-output|write-host|make|cmake|deno|java|javac|dotnet|prettier|uv|clang|ninja|sqlite3|yq)\b/i;

const QUESTION =
  /^(what|why|how|who|which|when|where|explain|tell|please (tell|explain)|can you|could you|do you)\b/i;

const ENGLISH_TAIL = /^(that|this|it|them|me|you|please|something|everything|all)$/i;

/** A second word that only an English sentence has after a verb such as go, move, type or copy. */
const ENGLISH_NEXT =
  /^(ahead|to|the|a|an|and|back|up|down|my|your|this|that|it|on|in|into|onto|over|there|here|home|left|right|now|me|please|forward|out)$/i;

const REPL_SHELLS = new Set(["python", "node", "termux"]);
const SYSTEM_SHELLS = new Set(["cmd", "powershell", "pwsh", "wsl", "git-bash", "bash", "sh"]);

const EXPLICIT_RUN =
  /^(?:please\s+)?(?:run|execute|type)\s+(?:this\s+)?(?:command\s+)?(?:in\s+(?:the\s+)?(?<shell>terminal|cmd|command prompt|powershell|pwsh|bash|wsl|git bash)\s*[:-]?\s*)(?<cmd>.+)/i;

const RUN_IN_SHELL =
  /^(?:please\s+)?(?:run|execute|type)\s+(?<cmd>.+?)\s+in\s+(?:the\s+)?(?<shell>terminal|cmd|command prompt|powershell|pwsh|bash|wsl|git bash)\s*$/i;

const IN_SHELL =
  /^(?:please\s+)?(?:in|on)\s+(?:the\s+)?(?<shell>terminal|cmd|command prompt|powershell|pwsh|bash|wsl|git bash)\s*[:-]\s*(?<cmd>.+)/i;

const SHELL_PREFIX =
  /^(?:please\s+)?(?<shell>terminal|cmd|powershell|pwsh|bash|wsl)\s*[:-]\s*(?<cmd>.+)/i;

const RUN_BARE = /^(?:please\s+)?(?:run|execute)\s+(?<cmd>.+)/i;

/** Spoken/typed FRIDAY tasks → the real npm script (still classified for risk). */
const NAMED_TASKS: Array<{ re: RegExp; command: string }> = [
  {
    re: /^(?:please\s+)?(?:run|execute)\s+(?:the\s+)?(?:unit\s+|vitest\s+)?tests?\b/i,
    command: "npm test",
  },
  { re: /^(?:please\s+)?(?:run\s+)?(?:a\s+)?typecheck\b/i, command: "npm run typecheck" },
  { re: /^(?:please\s+)?(?:run\s+)?(?:the\s+)?linters?\b/i, command: "npm run lint" },
  { re: /^(?:please\s+)?lint(?:\s+the\s+code)?$/i, command: "npm run lint" },
  { re: /^(?:please\s+)?(?:run\s+)?docs:check\b/i, command: "npm run docs:check" },
  { re: /^(?:please\s+)?install(?:\s+the)?(?:\s+npm|\s+node)?\s+dependenc/i, command: "npm ci" },
];

export type ConsoleKind = "empty" | "builtin" | "shell" | "ask";

export type ConsoleInput = {
  kind: ConsoleKind;
  text: string;
  shell?: string;
};

export type TerminalRunPlan = {
  command: string;
  shell?: string;
  tool: "shell.cmd" | "shell.powershell";
  label: string;
  risk: "safe" | "exec";
};

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
type ArgvRule = {
  cmd: string;
  flags?: string[];
  values?: string[];
  cluster?: string;
  numeric?: boolean;
  pos?: "any" | "name" | "none";
  ci?: boolean;
  go?: boolean;
  slash?: string[];
  slashv?: string[];
  need?: string[];
  dd?: boolean;
  any?: boolean;
  internal?: boolean;
};

const GIT_DIFF = ["--stat", "--name-only", "--name-status", "--shortstat", "--numstat"];
const GIT_SAFE = ["--no-color", "--no-ext-diff", "--no-textconv"];
const PYTEST: Omit<ArgvRule, "cmd"> = {
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
const RUFF: Omit<ArgvRule, "cmd"> = {
  flags: ["-q", "--quiet", "--statistics", "--no-fix", "--exit-zero"],
  values: ["--select", "--ignore", "--extend-select", "--output-format", "--target-version"],
  pos: "any",
};
const VITEST: Omit<ArgvRule, "cmd"> = {
  flags: ["--run", "--silent", "--passWithNoTests", "--no-color"],
  values: ["-t", "--testNamePattern"],
  pos: "any",
};
const ESLINT: Omit<ArgvRule, "cmd"> = {
  flags: ["--quiet", "--no-color"],
  values: ["--max-warnings", "--ext"],
  pos: "any",
};
const PRETTIER: Omit<ArgvRule, "cmd"> = {
  flags: ["--check", "-c", "--list-different", "-l", "--ignore-unknown"],
  need: ["--check", "-c", "--list-different", "-l"],
  pos: "any",
};
const TSC: Omit<ArgvRule, "cmd"> = {
  flags: ["--noemit", "--pretty", "--skiplibcheck"],
  values: ["-p", "--project"],
  need: ["--noemit"],
  ci: true,
  pos: "any",
};
const CARGO: Omit<ArgvRule, "cmd"> = {
  flags: ["--workspace", "--all", "-q", "--quiet", "--lib", "--tests", "--all-targets"],
  values: ["-p", "--package"],
  pos: "any",
};
const PS_LIST: Omit<ArgvRule, "cmd"> = {
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

export const SAFE_COMMANDS: readonly ArgvRule[] = [
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
  ...["npm", "pnpm", "yarn", "bun"].flatMap((pm): ArgvRule[] => [
    { cmd: `${pm} test`, pos: "none" },
    ...[...SCRIPTS, ...MORE_SCRIPTS].map((script): ArgvRule => ({
      cmd: `${pm} run ${script}`,
      pos: "none",
    })),
  ]),
  { cmd: "npm t", pos: "none" },
  ...["npm ls", "npm list", "pnpm ls", "pnpm list", "yarn list"].map((cmd): ArgvRule => ({
    cmd,
    flags: ["--all"],
    values: ["--depth"],
    pos: "any",
  })),
  { cmd: "npm help", pos: "any" },
  ...["", "npx "].flatMap((pre): ArgvRule[] => [
    { cmd: `${pre}vitest`, ...VITEST },
    { cmd: `${pre}eslint`, ...ESLINT },
    { cmd: `${pre}prettier`, ...PRETTIER },
    { cmd: `${pre}tsc`, ...TSC },
  ]),
  { cmd: "pytest", ...PYTEST },
  { cmd: "ruff check", ...RUFF },
  ...["python", "python3", "py"].flatMap((py): ArgvRule[] => [
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
  ...["cargo test", "cargo check", "cargo clippy"].map((cmd): ArgvRule => ({ cmd, ...CARGO })),
  { cmd: "dotnet test", pos: "any" },
  ...["dotnet --version", "dotnet --info", "dotnet --list-sdks"].map((cmd): ArgvRule => ({
    cmd,
    pos: "none",
  })),
  ...[...VERSION_TOOLS, ...MORE_VERSION_TOOLS].flatMap((tool) =>
    ["--version", "-v", "version"].map((form): ArgvRule => ({
      cmd: `${tool} ${form}`,
      pos: "none",
    })),
  ),
  ...["pip", "pip3", "uv pip"].flatMap((pip) =>
    ["list", "show", "freeze", "check"].map((verb): ArgvRule => ({
      cmd: `${pip} ${verb}`,
      pos: "any",
    })),
  ),
  { cmd: "winget list", pos: "any" },
  { cmd: "choco list", pos: "any" },
  ...["scoop list", "scoop info"].map((cmd): ArgvRule => ({ cmd, pos: "any" })),
  ...["ollama list", "ollama ls", "ollama ps"].map((cmd): ArgvRule => ({ cmd, pos: "none" })),
  {
    cmd: "ollama show",
    flags: ["--modelfile", "--license", "--parameters", "--template", "--system"],
    pos: "any",
  },
  ...["docker", "podman"].flatMap((tool) =>
    ["ps", "images", "info"].map((verb): ArgvRule => ({
      cmd: `${tool} ${verb}`,
      flags: ["-a", "--all", "-q", "--quiet"],
      cluster: "aq",
      pos: "none",
    })),
  ),
  { cmd: "ipconfig", slash: ["/all", "/displaydns"], ci: true, pos: "none" },
  ...["date", "time"].map((cmd): ArgvRule => ({
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
  ...["gci", "get-childitem"].map((cmd): ArgvRule => ({ cmd, ...PS_LIST })),
  ...["pwd", "hostname", "systeminfo", "get-location"].map((cmd): ArgvRule => ({
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
  ...["echo", "write-output", "write-host"].map((cmd): ArgvRule => ({
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
  ...["get-process", "gps"].map((cmd): ArgvRule => ({
    cmd,
    values: ["-name", "-id"],
    ci: true,
    pos: "any",
  })),
  ...["get-service", "gsv"].map((cmd): ArgvRule => ({
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

type Token = { text: string; escaped: boolean; raw0: string };

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
function tokenize(chunk: string, posix: boolean): Token[] | null {
  const out: Token[] = [];
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
function plainValue(token: Token): boolean {
  const text = token.text;
  if (!text || text.includes("://") || /^[\\/]{2}/.test(text)) return false;
  if (/^(?:file|https?|ftps?|ssh|smb|git):/i.test(text)) return false;
  return !/^[*?[@]/.test(token.raw0);
}

function ruleFor(tokens: Token[]): { rule: ArgvRule; used: number } | null {
  let best: { rule: ArgvRule; used: number } | null = null;
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

function argsAllowed(rule: ArgvRule, args: Token[]): boolean {
  const flags = rule.flags || [];
  const values = rule.values || [];
  const seen: string[] = [];
  let ended = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] as Token;
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
      ![...flag.slice(1)].every((c) => (rule.cluster as string).includes(c))
    )
      return false;
    else seen.push(flag);
  }
  return !rule.need || rule.need.some((flag) => seen.includes(flag));
}

/** One chunk under both readings (sh or PowerShell, and cmd): safe only when both find a rule that takes every token. */
function chunkAllowed(chunk: string, untrusted: boolean): boolean {
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
export function classifyCommand(
  command: string,
  options: { untrusted?: boolean } = {},
): "write" | "exec" {
  const line = String(command || "").trim();
  if (!line) return "write";
  if (JOINS_NEXT_LINE.test(line)) return "exec";
  const chunks = line
    .split(/&&|\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!chunks.length) return "write";
  const untrusted = options.untrusted === true;
  const safe = (part: string) =>
    !SHELL_SYNTAX.test(part) &&
    !CONTROL.test(part.replace(/\t/g, " ")) &&
    !RISKY.some((re) => re.test(part)) &&
    chunkAllowed(part, untrusted);
  return chunks.every(safe) ? "write" : "exec";
}

/** Action-risk tier for a workspace-shell line. Checks/tests are safe; installs are exec. */
export function terminalCommandRisk(command: string): "safe" | "exec" {
  return classifyCommand(command) === "exec" ? "exec" : "safe";
}

/**
 * Auto Mode may run this without a pause: it maps to a real non-exec shell line
 * (git status, npm test, winget list, …). Manual mode still asks.
 */
export function isRoutineTerminalCommand(text: string): boolean {
  const plan = extractTerminalRun(text);
  if (!plan) return false;
  return plan.risk === "safe";
}

export function isBuiltin(command: string): boolean {
  const bin = String(command || "")
    .trim()
    .split(/\s+/)[0]
    ?.toLowerCase();
  return Boolean(bin && BUILTINS.has(bin));
}

export function looksLikeShellCommand(text: string): boolean {
  const line = String(text || "").trim();
  if (!line || QUESTION.test(line) || /\?$/.test(line)) return false;
  if (isBuiltin(line)) return true;
  if (/^[A-Za-z]:[\\/]/.test(line) || line.startsWith(".\\") || line.startsWith("./")) return true;
  if (!SHELL_VERBS.test(line)) return false;
  const tokens = line.split(/\s+/);
  if (tokens.length >= 2 && ENGLISH_TAIL.test(tokens[1] ?? "") && tokens.length <= 3) return false;
  // "go to youtube.com", "move the window left", "go ahead and open notepad" are English, not a shell line.
  if (tokens.length >= 3 && ENGLISH_NEXT.test(tokens[1] ?? "")) return false;
  return true;
}

/**
 * Python/Node REPL profiles cannot run `npm test`. Fall back to a real shell.
 */
export function resolveTerminalShell(
  requested: string | undefined,
  sessionShell: string,
  command: string,
): string {
  const want = String(requested || sessionShell || "cmd").trim() || "cmd";
  if (!REPL_SHELLS.has(want)) return want;
  const bin = String(command || "")
    .trim()
    .split(/\s+/)[0]
    ?.toLowerCase();
  if (want === "python" && /^(python|python3|py)$/.test(bin || "")) return want;
  if (want === "node" && bin === "node") return want;
  if (!looksLikeShellCommand(command)) return want;
  const fallback = SYSTEM_SHELLS.has(sessionShell) ? sessionShell : "cmd";
  return fallback;
}

function mapShellName(raw?: string): string | undefined {
  const name = String(raw || "").toLowerCase();
  if (!name) return undefined;
  if (name === "powershell" || name === "pwsh") return name === "pwsh" ? "pwsh" : "powershell";
  if (name === "bash" || name === "git bash") return "git-bash";
  if (name === "wsl") return "wsl";
  if (name === "cmd" || name === "command prompt" || name === "terminal") return "cmd";
  return undefined;
}

function planFrom(command: string, shellName?: string): TerminalRunPlan | null {
  const cmd = String(command || "").trim();
  if (!cmd) return null;
  const shell = mapShellName(shellName);
  const tool: TerminalRunPlan["tool"] =
    shell === "powershell" || shell === "pwsh" ? "shell.powershell" : "shell.cmd";
  const risk = terminalCommandRisk(cmd);
  return {
    command: cmd,
    ...(shell ? { shell } : {}),
    tool,
    risk,
    label: `run \`${cmd}\` in the FRIDAY terminal`,
  };
}

/**
 * Chat / Auto Mode phrase → one real workspace-shell run.
 * Questions and open-ended asks return null (the model or Ask FRIDAY handles them).
 */
export function extractTerminalRun(prompt: string): TerminalRunPlan | null {
  const text = String(prompt || "").trim();
  if (!text) return null;

  for (const task of NAMED_TASKS) {
    if (task.re.test(text)) return planFrom(task.command);
  }

  const trailing = RUN_IN_SHELL.exec(text);
  if (trailing?.groups?.["cmd"]) return planFrom(trailing.groups["cmd"], trailing.groups["shell"]);

  const explicit = EXPLICIT_RUN.exec(text);
  if (explicit?.groups?.["cmd"]) return planFrom(explicit.groups["cmd"], explicit.groups["shell"]);

  const inside = IN_SHELL.exec(text);
  if (inside?.groups?.["cmd"]) return planFrom(inside.groups["cmd"], inside.groups["shell"]);

  const prefixed = SHELL_PREFIX.exec(text);
  if (prefixed?.groups?.["cmd"]) return planFrom(prefixed.groups["cmd"], prefixed.groups["shell"]);

  const bare = RUN_BARE.exec(text);
  if (bare?.groups?.["cmd"] && looksLikeShellCommand(bare.groups["cmd"])) {
    return planFrom(bare.groups["cmd"]);
  }

  if (looksLikeShellCommand(text) && !QUESTION.test(text)) {
    return planFrom(text);
  }

  return null;
}

/** Console box: `!` forces a shell line, `?` asks FRIDAY, otherwise detect. */
export function classifyConsoleInput(raw: string): ConsoleInput {
  const text = String(raw || "").trim();
  if (!text) return { kind: "empty", text: "" };
  if (text.startsWith("?")) return { kind: "ask", text: text.slice(1).trim() || text };
  if (text.startsWith("!")) {
    const line = text.slice(1).trim();
    return { kind: "shell", text: line || text };
  }
  if (isBuiltin(text)) return { kind: "builtin", text };
  if (looksLikeShellCommand(text)) return { kind: "shell", text };
  return { kind: "ask", text };
}

export const TERMINAL_HELP = [
  "FRIDAY terminal — a real shell inside the FRIDAY workspace root.",
  "built-ins: help · pwd · cd <dir> · home · cls|clear · shell <id> · shells · history",
  "prefix ! to force a shell line; prefix ? to ask FRIDAY about the live buffer.",
  "Natural-language lines go to FRIDAY (same brain as Chat / Auto Mode), not to cmd.",
  "cmd, PowerShell, pwsh, WSL, Git Bash, bash, sh, Node, and the FRIDAY Python venv are profiles.",
  "Termux is Android-only and stays listed as unavailable on this PC.",
  "cwd cannot leave the FRIDAY folder. winget / choco / scoop / npm / pip still install on this PC from here.",
  "Auto Mode: checks and tests run on their own; installs, deletes, git push/commit, and other risky lines wait for you.",
  "Manual mode: every FRIDAY-started action still asks first. You can always type commands here yourself.",
  "while a command runs, what you type is sent to its stdin; Stop kills it.",
].join("\n");
