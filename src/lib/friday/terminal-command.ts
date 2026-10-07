/**
 * FRIDAY · workspace-terminal command parsing
 *
 * Pure helpers shared by the Terminal page, the ops engine, and the baseline
 * brain. They never spawn a process — `electron/terminal.cjs` is the one
 * executor. Natural-language lines are classified as asks so `cmd.exe` is not
 * fed English questions.
 *
 * KEEP `RISKY` in lockstep with `electron/terminal.cjs`.
 */

/** Mutating / machine-level lines — owner must approve (exec). Checks/tests are not listed. */
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

export function classifyCommand(command: string): "write" | "exec" {
  const line = String(command || "").trim();
  if (!line) return "write";
  const parts = line.split(/\s*(?:&&|\|\||;)\s*/).filter(Boolean);
  const chunks = parts.length ? parts : [line];
  return chunks.some((part) => RISKY.some((re) => re.test(part))) ? "exec" : "write";
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
