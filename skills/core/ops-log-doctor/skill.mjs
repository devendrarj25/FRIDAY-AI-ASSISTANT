// FRIDAY · skill: ops-log-doctor
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Triage logs and decode Windows, winget and MSI exit codes. Finds what went wrong in a log or an exit code.
// It holds 2 small tools (parts). A request that names one runs it; otherwise every tool whose topic matches the
// request runs, the first answer is the main result and the others are listed under "also". Pass part to pick one.

const PARTS = [
  {
    id: "ops-log-triage",
    gate: /log|error|failed|failure|exception|traceback|warn|stack|fatal|build|setup|install/,
    run: (() => {
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

      async function run(input = {}) {
        const lines = logText(input).split(/\r?\n/);
        if (lines.filter((l) => l.trim()).length === 0) {
          return {
            ok: false,
            error: "Paste the log text (the failing part and a few lines before it).",
          };
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
          const entry = groups.get(key) ?? {
            count: 0,
            firstLine: index + 1,
            sample: line.slice(0, 220),
          };
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

      return run;
    })(),
  },
  {
    id: "ops-exit-code",
    gate: /exit ?code|error ?level|return code|error code|0x[0-9a-f]+|\bcode\b|winget|msi|robocopy|curl|signal|exited/,
    run: (() => {
      // FRIDAY · skill: ops-exit-code
      // Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
      // Decodes Windows, winget, MSI, curl, git, Node and signal exit codes. Only codes whose meaning is
      // documented are listed: an unknown number is reported as unknown, never guessed.

      // Unsigned 32-bit hex -> [name, meaning, what to try]
      const HRESULT = {
        0x00000000: ["OK", "Success.", ""],
        0x80070005: [
          "E_ACCESSDENIED",
          "Access is denied.",
          "Run from an administrator terminal, close the program that holds the file, or pick a folder you own.",
        ],
        0x80070002: [
          "ERROR_FILE_NOT_FOUND",
          "The system cannot find the file specified.",
          "Check the path and spelling; the file may not be downloaded yet.",
        ],
        0x80070003: [
          "ERROR_PATH_NOT_FOUND",
          "The system cannot find the path specified.",
          "A folder in the path is missing.",
        ],
        0x80070057: [
          "E_INVALIDARG",
          "A parameter is incorrect.",
          "Check the arguments and the path characters.",
        ],
        0x80004005: [
          "E_FAIL",
          "Unspecified error.",
          "Open the log the program wrote; this code says nothing by itself.",
        ],
        0x800700b7: [
          "ERROR_ALREADY_EXISTS",
          "Cannot create a file when that file already exists.",
          "Remove or rename the existing one.",
        ],
        0x8a150014: [
          "APPINSTALLER_CLI_ERROR_NO_APPLICATIONS_FOUND",
          "winget found no package for this request.",
          "Check the id with winget search; for upgrade it can also mean the package was not installed by winget.",
        ],
        0x8a15002b: [
          "APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE",
          "winget has no newer version to apply.",
          "Nothing to do: it is already the newest release.",
        ],
        0x8a150013: [
          "APPINSTALLER_CLI_ERROR_SOURCE_NAME_ALREADY_EXISTS",
          "The winget source is already configured.",
          "Nothing to do.",
        ],
      };

      // Plain Win32 / process exit codes.
      const WIN32 = {
        0: ["SUCCESS", "Completed without error.", ""],
        1: [
          "GENERAL ERROR",
          "The program reported a failure (the exact reason is in its own output).",
          "Read the lines above the exit.",
        ],
        2: [
          "FILE NOT FOUND / misuse",
          "File not found (Windows) or incorrect usage (many tools).",
          "Check the path and the arguments.",
        ],
        3: ["PATH NOT FOUND", "The system cannot find the path specified.", ""],
        5: [
          "ACCESS DENIED",
          "Access is denied.",
          "Run as administrator or choose a folder you own.",
        ],
        32: [
          "SHARING VIOLATION",
          "The file is in use by another process.",
          "Close the program that has it open (antivirus, editor, a running FRIDAY).",
        ],
        87: ["INVALID PARAMETER", "A parameter is incorrect.", ""],
        112: ["DISK FULL", "There is not enough space on the disk.", "Free space and retry."],
        740: [
          "ELEVATION REQUIRED",
          "The requested operation requires elevation.",
          "Run it from an administrator terminal.",
        ],
        1223: [
          "CANCELLED BY USER",
          "The operation was cancelled by the user (a declined UAC prompt).",
          "Run again and accept the administrator prompt.",
        ],
        1602: ["MSI: USER CANCELLED", "The user cancelled the installation.", ""],
        1603: [
          "MSI: FATAL ERROR",
          "Fatal error during installation.",
          "Read the MSI log; common causes are a running copy, a pending restart or no permission.",
        ],
        1618: [
          "MSI: ANOTHER INSTALL RUNNING",
          "Another installation is already in progress.",
          "Wait for it to finish, then retry.",
        ],
        1619: [
          "MSI: PACKAGE NOT OPENED",
          "The installation package could not be opened.",
          "The download may be damaged: download it again.",
        ],
        1625: [
          "MSI: BLOCKED BY POLICY",
          "The installation is forbidden by system policy.",
          "A policy on this PC blocks the installer.",
        ],
        1638: [
          "MSI: OTHER VERSION INSTALLED",
          "Another version of this product is already installed.",
          "Uninstall it or use the upgrade path.",
        ],
        1641: [
          "MSI: RESTART INITIATED",
          "The installer started a restart to finish.",
          "Let the PC restart.",
        ],
        3010: [
          "MSI: RESTART REQUIRED",
          "The installation worked, a restart is needed to finish.",
          "Restart Windows once; this is not a failure.",
        ],
        3221225477: [
          "ACCESS VIOLATION (0xC0000005)",
          "The program crashed reading or writing memory it should not.",
          "Update the program; a failing driver or antivirus hook can cause it.",
        ],
        3221225786: [
          "CTRL+C (0xC000013A)",
          "The process was ended with Ctrl+C or the console was closed.",
          "",
        ],
        3221225781: [
          "DLL NOT FOUND (0xC0000135)",
          "A required DLL was not found.",
          "Install the Visual C++ runtime or the missing component.",
        ],
        3221225794: [
          "DLL INIT FAILED (0xC0000142)",
          "A DLL could not start.",
          "Repair the Visual C++ runtime.",
        ],
      };

      // Unix style (Git Bash, WSL, Node on Linux, containers).
      const UNIX = {
        126: ["NOT EXECUTABLE", "The command was found but cannot be run.", ""],
        127: [
          "COMMAND NOT FOUND",
          "The command does not exist on PATH.",
          "Install it or fix PATH.",
        ],
        128: [
          "GIT FATAL / invalid exit",
          "git prints 'fatal:' and exits 128.",
          "Read the fatal: line.",
        ],
        130: ["SIGINT", "Stopped with Ctrl+C (128 + 2).", ""],
        137: [
          "SIGKILL",
          "Killed (128 + 9), often out of memory.",
          "Free memory or raise the limit.",
        ],
        143: ["SIGTERM", "Asked to stop (128 + 15).", ""],
      };

      const CURL = {
        6: "Could not resolve host (DNS).",
        7: "Failed to connect to the host.",
        22: "HTTP error status (curl --fail).",
        23: "Write error: cannot save the file (disk or permission).",
        28: "Operation timed out.",
        35: "TLS/SSL handshake failed.",
        56: "Failure receiving network data (connection reset).",
        60: "The server certificate could not be verified.",
      };

      const ROBOCOPY_BITS = [
        [1, "files were copied"],
        [2, "extra files exist in the destination"],
        [4, "mismatched files or folders were found"],
        [8, "some files failed to copy"],
        [16, "serious error, nothing was copied"],
      ];

      function parseNumbers(input) {
        const raw = String(input?.code ?? input?.codes ?? input?.text ?? input?.prompt ?? "");
        if (typeof (input?.code ?? input?.codes) === "number") {
          return { tokens: [String(input.code ?? input.codes)], near: new Map() };
        }
        // Every number counts, except one that names a product or version ("Windows 11", "Node 22", "v3").
        const out = [];
        const near = new Map();
        for (const m of raw.matchAll(/(?:^|[^\w.])(0x[0-9a-f]{1,8}|-?\d{1,10})\b/gi)) {
          const before = raw.slice(Math.max(0, m.index - 12), m.index + 1).toLowerCase();
          if (
            /\b(windows|win|version|node|python|py|npm|v)\s*$/.test(before.trimEnd()) &&
            !/^-|^0x/i.test(m[1])
          )
            continue;
          out.push(m[1]);
          if (!near.has(m[1]))
            near.set(m[1], raw.slice(Math.max(0, m.index - 30), m.index + 1).toLowerCase());
        }
        return { tokens: [...new Set(out)], near };
      }

      function decode(token, context = {}) {
        const hex = /^0x/i.test(token);
        let n = hex ? parseInt(token, 16) : Number(token);
        if (!Number.isFinite(n)) return null;
        const unsigned = n < 0 ? n + 2 ** 32 : n;
        const out = {
          input: token,
          decimal: n,
          hex: `0x${unsigned.toString(16).toUpperCase().padStart(8, "0")}`,
          matches: [],
        };
        if (HRESULT[unsigned])
          out.matches.push({
            family: "HRESULT / winget",
            name: HRESULT[unsigned][0],
            meaning: HRESULT[unsigned][1],
            tryThis: HRESULT[unsigned][2],
          });
        if (WIN32[unsigned]) {
          out.matches.push({
            family: "Windows / MSI",
            name: WIN32[unsigned][0],
            meaning: WIN32[unsigned][1],
            tryThis: WIN32[unsigned][2],
          });
        }
        if (UNIX[n])
          out.matches.push({
            family: "Unix / Git / Node",
            name: UNIX[n][0],
            meaning: UNIX[n][1],
            tryThis: UNIX[n][2],
          });
        if (context.curl && CURL[n])
          out.matches.push({ family: "curl", name: `CURL ${n}`, meaning: CURL[n], tryThis: "" });
        if (!hex && n > 128 && n < 256 && !UNIX[n]) {
          out.matches.push({
            family: "Signal",
            name: `SIGNAL ${n - 128}`,
            meaning: `The process was ended by signal ${n - 128} (128 + signal).`,
            tryThis: "",
          });
        }
        if (context.robocopy && n >= 0 && n <= 31 && !hex) {
          const bits = ROBOCOPY_BITS.filter(([bit]) => n & bit).map(([, text]) => text);
          if (bits.length)
            out.matches.push({
              family: "robocopy (bit flags)",
              name: `ROBOCOPY ${n}`,
              meaning: `${bits.join("; ")}. Under 8 is a success.`,
              tryThis: "",
            });
        }
        return out;
      }

      async function run(input = {}) {
        const { tokens, near } = parseNumbers(input);
        if (!tokens.length)
          return {
            ok: false,
            error: "Give an exit code such as 1603, 3010, -1978335189 or 0x8A15002B.",
          };
        const raw = String(input?.text ?? input?.prompt ?? "");
        const mentions = { curl: /\bcurl\b/i.test(raw), robocopy: /robocopy/i.test(raw) };
        const results = tokens
          .map((t) => {
            const before = near.get(t) ?? "";
            // A tool named right before the number owns it; one tool named anywhere owns the rest.
            const context = {
              curl: /curl/.test(before) || (mentions.curl && !mentions.robocopy),
              robocopy: /robocopy/.test(before) || (mentions.robocopy && !mentions.curl),
            };
            return decode(t, context);
          })
          .filter(Boolean);
        const known = results.filter((r) => r.matches.length);
        if (!known.length) {
          return {
            ok: false,
            error: `None of ${results.map((r) => r.input).join(", ")} is a documented exit code in this list. An unknown number is not guessed.`,
            unknown: results.map((r) => r.input),
          };
        }

        return {
          ok: true,
          answer: known.length
            ? known
                .map(
                  (r) =>
                    `${r.input} -> ${r.matches.map((m) => `${m.name}: ${m.meaning}`).join(" | ")}`,
                )
                .join("\n")
            : "None of these numbers is a documented code in this list.",
          results,
          unknown: results.filter((r) => !r.matches.length).map((r) => r.input),
          tip: "An exit code only says that something failed. The reason is in the lines the program printed just before it exited. winget can also explain its own codes: winget error 0x8A150014.",
        };
      }

      return run;
    })(),
  },
];

const PLAIN = new Set(["prompt", "text", "previous"]);

export async function run(input = {}) {
  const wanted = input?.part != null ? String(input.part) : "";
  const prompt = String(input?.prompt ?? input?.text ?? "").toLowerCase();
  const structured = Object.keys(input ?? {}).some((k) => !PLAIN.has(k));
  const chosen = wanted ? PARTS.filter((p) => p.id === wanted) : PARTS;
  if (wanted && !chosen.length) {
    return {
      ok: false,
      error: `Unknown part "${wanted}". Parts: ${PARTS.map((p) => p.id).join(", ")}.`,
    };
  }
  const hits = [];
  const misses = [];
  for (const p of chosen) {
    if (!wanted && p.gate && !structured && !p.gate.test(prompt)) continue;
    let r;
    try {
      r = await p.run(input);
    } catch (error) {
      r = { ok: false, error: String(error?.message ?? error) };
    }
    if (r && r.ok === true) hits.push({ part: p.id, result: r });
    else misses.push({ part: p.id, result: r });
  }
  if (!hits.length) {
    if (wanted) return { ...(misses[0]?.result ?? { ok: false }), ok: false, part: wanted };
    return {
      ok: false,
      error: misses.length
        ? misses.map((m) => `${m.part}: ${m.result?.error ?? "not for this request"}`).join(" | ")
        : `Nothing in this request fits: ${PARTS.map((p) => p.id).join(", ")}.`,
      parts: PARTS.map((p) => p.id),
    };
  }
  const [first, ...rest] = hits;
  const out = { ...first.result, part: first.part };
  if (rest.length) out.also = rest.map((h) => ({ part: h.part, answer: h.result.answer ?? null }));
  return out;
}

export default run;
