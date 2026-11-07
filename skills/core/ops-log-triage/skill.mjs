// FRIDAY · skill: ops-log-triage
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Reads a pasted setup, build, npm, pip, winget or app log and says what actually went wrong.

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function logText(input) {
  return String(input?.log ?? input?.text ?? input?.prompt ?? "").replace(ANSI, "");
}

/** The same failure printed twice with different numbers, paths or ids is one problem. */
function fingerprint(line) {
  return line
    .replace(/^\s*\[[^\]]*\]\s*/, "")
    .replace(/\b[A-Za-z]:\\[^\s"'<>|]+/g, "<path>")
    .replace(/(?:\/[\w.@+-]+){2,}/g, "<path>")
    .replace(/https?:\/\/[^\s"')]+/gi, "<url>")
    .replace(/0x[0-9a-f]+/gi, "<hex>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<id>")
    .replace(/\d+(?:\.\d+)*/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

const ERROR_LINE =
  /\b(error|fatal|fail(?:ed|ure)?|exception|traceback|cannot|could not|unable to|denied|refused|timed out|timeout|not found|no such file|ENOENT|EACCES|EPERM|ETIMEDOUT|ECONNRESET|ENOTFOUND|ACTION REQUIRED|npm ERR!|exit code [1-9]\d*|exited with code [1-9]\d*)\b/i;
const NOISE = /\b(0 errors?|no errors?|error[- ]?free|errors?: 0|failed: 0|0 failed)\b/i;

const CLASSES = [
  [
    "network",
    /ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|getaddrinfo|timed out|timeout|SSL|TLS|certificate|proxy|tunnel|could not resolve|network is unreachable|Connection (?:reset|refused)/i,
    "Network or proxy: check the connection, a proxy or VPN, then run it again.",
  ],
  [
    "http",
    /\b(?:HTTP\/?\s?)?(401|403|404|408|410|429|500|502|503|504)\b/i,
    "A server answered with an error status: the link may be gone, rate-limited or blocked.",
  ],
  [
    "permission",
    /EACCES|EPERM|access is denied|permission denied|requires elevation|run as administrator|UAC/i,
    "Permission: a file is locked or the step needs the administrator prompt.",
  ],
  [
    "disk",
    /no space left|ENOSPC|disk full|not enough space|insufficient disk/i,
    "Disk is full: free space and run it again.",
  ],
  [
    "missing",
    /not found|no such file|ENOENT|is not recognized as an internal or external command|command not found|ModuleNotFoundError|Cannot find module/i,
    "Something is missing: a file, a command or a module is not installed or not on PATH.",
  ],
  [
    "version",
    /unsupported|requires (?:node|python|npm)|engine|incompatible|minimum supported|too old/i,
    "Version: a tool is older (or newer) than this step supports.",
  ],
  [
    "install",
    /winget|msiexec|installer|exit code 1603|0x8A15|npm ERR!|pip(?:3)? install|ERROR: Could not (?:find|install)/i,
    "An installer or package manager step failed: read the first error line around it.",
  ],
];

export async function run(input = {}) {
  const lines = logText(input).split(/\r?\n/);
  if (lines.filter((l) => l.trim()).length === 0) {
    return { ok: false, error: "Paste the log text (the failing part and a few lines before it)." };
  }
  const groups = new Map();
  const exitCodes = [];
  const versions = new Set();
  const classes = new Map();
  const markers = [];
  let firstError = null;
  let lastError = null;

  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    const code = line.match(
      /\b(?:exit(?:ed)?(?: with)?(?: code)?|exit code|returned|status)[ :=]+(-?\d+|0x[0-9a-f]+)/i,
    );
    if (code) exitCodes.push({ line: index + 1, code: code[1] });
    for (const v of line.match(/\b\d+\.\d+\.\d+(?:\.\d+)?\b/g) ?? []) versions.add(v);
    if (/\b(method failed|ACTION REQUIRED|FAILED|FAIL\b|SETUP FAIL|BUILD FAIL)/.test(line)) {
      markers.push({ line: index + 1, text: line.slice(0, 200) });
    }
    if (!ERROR_LINE.test(line) || NOISE.test(line)) return;
    const key = fingerprint(line);
    const entry = groups.get(key) ?? { count: 0, firstLine: index + 1, sample: line.slice(0, 220) };
    entry.count += 1;
    groups.set(key, entry);
    if (!firstError) firstError = { line: index + 1, text: line.slice(0, 220) };
    lastError = { line: index + 1, text: line.slice(0, 220) };
    for (const [name, pattern] of CLASSES) {
      if (pattern.test(line)) classes.set(name, (classes.get(name) ?? 0) + 1);
    }
  });

  const top = [...groups.values()]
    .sort((a, b) => b.count - a.count || a.firstLine - b.firstLine)
    .slice(0, 8);
  const ranked = [...classes.entries()].sort((a, b) => b[1] - a[1]);
  const hints = ranked.slice(0, 3).map(([name]) => CLASSES.find((c) => c[0] === name)[2]);
  const nonZero = exitCodes.filter((c) => !/^(0|0x0+)$/i.test(c.code));
  const failed = groups.size > 0 || nonZero.length > 0 || markers.length > 0;
  return {
    ok: true,
    verdict: failed ? "problems found" : "no errors found",
    answer: failed
      ? `${groups.size} distinct error pattern(s). First error at line ${firstError?.line ?? "?"}: ${firstError?.text ?? "(see exit codes)"}`
      : "No error lines, failure markers or non-zero exit codes in this log.",
    lines: lines.length,
    firstError,
    lastError,
    topErrors: top.map((e) => ({ count: e.count, firstLine: e.firstLine, sample: e.sample })),
    nonZeroExitCodes: nonZero.slice(0, 10),
    failureMarkers: markers.slice(0, 10),
    categories: ranked.map(([name, count]) => ({ name, count })),
    whatToDo: hints,
    versionsSeen: [...versions].slice(0, 12),
    tip: "Start at the FIRST error, not the last: later lines are usually fallout. Decode a number with the Exit code decoder.",
  };
}

export default run;
