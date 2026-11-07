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
  5: ["ACCESS DENIED", "Access is denied.", "Run as administrator or choose a folder you own."],
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
  127: ["COMMAND NOT FOUND", "The command does not exist on PATH.", "Install it or fix PATH."],
  128: ["GIT FATAL / invalid exit", "git prints 'fatal:' and exits 128.", "Read the fatal: line."],
  130: ["SIGINT", "Stopped with Ctrl+C (128 + 2).", ""],
  137: ["SIGKILL", "Killed (128 + 9), often out of memory.", "Free memory or raise the limit."],
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

export async function run(input = {}) {
  const { tokens, near } = parseNumbers(input);
  if (!tokens.length)
    return { ok: false, error: "Give an exit code such as 1603, 3010, -1978335189 or 0x8A15002B." };
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
  return {
    ok: true,
    answer: known.length
      ? known
          .map(
            (r) => `${r.input} -> ${r.matches.map((m) => `${m.name}: ${m.meaning}`).join(" | ")}`,
          )
          .join("\n")
      : "None of these numbers is a documented code in this list.",
    results,
    unknown: results.filter((r) => !r.matches.length).map((r) => r.input),
    tip: "An exit code only says that something failed. The reason is in the lines the program printed just before it exited. winget can also explain its own codes: winget error 0x8A150014.",
  };
}

export default run;
