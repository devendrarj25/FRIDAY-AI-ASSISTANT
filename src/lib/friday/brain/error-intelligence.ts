/**
 * FRIDAY · error intelligence
 *
 * Find -> understand -> fix -> guide, for a pasted error, a build log or a crash code.
 *
 *   1. Normalise: language, error type, stack frames, exit / HRESULT / NTSTATUS / errno codes, and a
 *      stable fingerprint, so the same fault is recognised again.
 *   2. Rank root-cause hypotheses with evidence from read-only probes the caller already has (disk
 *      space, clock, versions, recent changes, crash records) and say what is still unknown.
 *   3. Localise before patching: the stack trace first, then recent change history, then a bisect
 *      plan. Nothing is patched from a guess.
 *   4. A fix is a proposal: files, tests and a rollback are required, it is checked against the
 *      protected paths and filed on the existing governance queue. Nothing is applied here.
 *   5. Guide the owner in short Hinglish or English: what broke, why, the safest fix, what will
 *      change, how to undo it, and at most one question.
 *
 * It reuses the shared failure classifier (`failure-guard.ts`) and the curated corpus
 * (`expertise.ts`). It reads text and returns data: no file is opened, no command is run.
 */

import { classifyFailure, failureDomain, recoverFailure } from "../failure-guard";
import type { FailureDomain, FailureKind, Recovery } from "../failure-guard";
import { proposeDiff } from "../self/own-work";
import { proposeFabricLimitation } from "../self/limitation-loop";
import { diagnoseError, looksLikeError } from "./expertise";
import { latestReliability } from "../self-atlas";

/* ------------------------------------------------------------------- types */

export type ErrorLanguage =
  | "python"
  | "javascript"
  | "java"
  | "csharp"
  | "go"
  | "rust"
  | "cpp"
  | "powershell"
  | "windows"
  | "tooling"
  | "unknown";

/** One stack frame. Frames are always ordered innermost first. */
export type Frame = {
  file: string;
  line?: number;
  column?: number;
  fn?: string;
  /** False for library, runtime and system frames. */
  own: boolean;
};

export type CodeFamily = "ntstatus" | "hresult" | "win32" | "errno" | "msi" | "winget" | "exit";

export type DecodedCode = {
  code: string;
  family: CodeFamily;
  meaning: string;
  /** True when the code is not a failure (a restart is needed, nothing to update). */
  benign?: boolean;
};

export type NormalizedError = {
  language: ErrorLanguage;
  errorType: string;
  message: string;
  frames: Frame[];
  codes: DecodedCode[];
  /** Stable across paths, numbers and addresses: the same fault gives the same value. */
  fingerprint: string;
  lines: number;
};

export type Evidence = {
  diskFreeGb?: number;
  /** How far the PC clock is from a trusted time, in milliseconds. */
  clockSkewMs?: number;
  kernelUp?: boolean;
  nodeVersion?: string;
  nodeFloor?: string;
  pythonVersion?: string;
  pythonFloor?: string;
  /** `git log --name-only` style: files changed lately, newest first. */
  recentChanges?: { path: string; at?: string; subject?: string }[];
  advisories?: { name: string; severity: string }[];
  configDrift?: string[];
  portOwner?: string;
  /** Crash records from the PC reliability probe. */
  crashApps?: { app: string; count: number }[];
};

export type FixRisk = "none" | "low" | "needs-approval";

export type Hypothesis = {
  id: string;
  cause: string;
  confidence: number;
  evidence: string[];
  /** A read-only step that would confirm or rule this out. */
  check: string;
  fix: { summary: string; steps: string[]; risk: FixRisk };
};

export type Location = {
  file: string;
  line?: number;
  fn?: string;
  basis: "stack-trace" | "change-history";
  note: string;
};

export type Diagnosis = NormalizedError & {
  domain: FailureDomain;
  kind: FailureKind;
  recovery: Recovery;
  /** False for a disk-full, permission, clock or corruption fault: another try changes nothing. */
  retryable: boolean;
  hypotheses: Hypothesis[];
  location: Location | null;
  bisect: string | null;
  confidence: number;
  unknown: string[];
  expertise: string[];
};

/* ------------------------------------------------------------- code tables */

const NTSTATUS: Record<string, string> = {
  "0xc0000005": "access violation: the program read or wrote memory it does not own",
  "0xc0000022": "access denied",
  "0xc000001d": "illegal instruction (the CPU cannot run this build)",
  "0xc0000135": "a required DLL was not found",
  "0xc000007b": "bad image: a 32-bit and a 64-bit file are mixed, or a DLL is damaged",
  "0xc0000142": "a DLL failed to initialise",
  "0xc00000fd": "stack overflow",
  "0xc0000374": "heap corruption",
  "0xc0000409": "the program stopped itself after detecting a buffer overrun (fail-fast)",
  "0xc000013a": "the console window was closed or Ctrl+C was pressed",
  "0x80000003": "a breakpoint was hit",
};

const WIN32: Record<number, string> = {
  2: "file not found",
  3: "path not found",
  5: "access denied",
  32: "the file is in use by another process (sharing violation)",
  87: "an argument is invalid",
  112: "the disk is full",
  183: "the file or folder already exists",
  206: "the file name or path is too long",
  740: "this needs administrator rights (elevation required)",
  1223: "the operation was cancelled by the user",
  1314: "a required privilege is not held",
  1603: "the installer failed with a fatal error",
  1618: "another installation is already running",
  1638: "another version of this product is already installed",
  3010: "the install worked and a restart is needed",
};

const HRESULT: Record<string, string> = {
  "0x80004001": "not implemented",
  "0x80004002": "interface not supported",
  "0x80004003": "invalid pointer",
  "0x80004004": "the operation was aborted",
  "0x80004005": "unspecified failure (E_FAIL)",
  "0x8007000e": "out of memory",
  "0x80070057": "an argument is invalid",
  "0x80072ee7": "the server name could not be resolved",
  "0x80072efd": "a connection with the server could not be established",
  "0x80072f8f":
    "a secure connection failed, often because the PC clock or the certificate is wrong",
};

const WINGET: Record<string, { meaning: string; benign: boolean }> = {
  "0x8a15002b": { meaning: "winget: there is no newer version to apply", benign: true },
  "0x8a150014": { meaning: "winget: the package was not installed by winget", benign: true },
};

const ERRNO: Record<string, string> = {
  ENOENT: "no such file or folder",
  EACCES: "permission denied",
  EPERM: "operation not permitted",
  EBUSY: "the file or folder is in use",
  EADDRINUSE: "that network port is already in use",
  ENOSPC: "no space left on the device",
  EMFILE: "too many open files",
  ETIMEDOUT: "the connection timed out",
  ECONNREFUSED: "nothing is listening there (connection refused)",
  ECONNRESET: "the other side closed the connection",
  ENOTFOUND: "the host name could not be resolved",
  EEXIST: "it already exists",
  ENOTEMPTY: "the folder is not empty",
  EISDIR: "it is a folder, not a file",
  ENOTDIR: "it is a file, not a folder",
  EPIPE: "the other end of the pipe closed",
  ENAMETOOLONG: "the file name or path is too long",
};

const hex8 = (value: number): string => `0x${(value >>> 0).toString(16).padStart(8, "0")}`;

/** One code to words. An unknown code is returned as unknown: it is never guessed. */
export function decodeCode(raw: string, context = ""): DecodedCode | null {
  const text = String(raw).trim();
  if (/^E[A-Z]{3,12}$/.test(text)) {
    const meaning = ERRNO[text];
    return meaning ? { code: text, family: "errno", meaning } : null;
  }
  let value: number | null = null;
  if (/^0x[0-9a-f]+$/i.test(text)) value = Number.parseInt(text.slice(2), 16) >>> 0;
  else if (/^-?\d+$/.test(text)) value = Number(text) >>> 0;
  if (value === null || Number.isNaN(value)) return null;
  const hex = hex8(value);
  if (WINGET[hex]) {
    return {
      code: hex,
      family: "winget",
      meaning: WINGET[hex].meaning,
      benign: WINGET[hex].benign,
    };
  }
  if (NTSTATUS[hex]) return { code: hex, family: "ntstatus", meaning: NTSTATUS[hex] };
  if (HRESULT[hex]) return { code: hex, family: "hresult", meaning: HRESULT[hex] };
  if (value >>> 16 === 0x8007) {
    const win32 = value & 0xffff;
    if (WIN32[win32])
      return { code: hex, family: "hresult", meaning: `Windows error ${win32}: ${WIN32[win32]}` };
  }
  const win32Meaning = value <= 0xffff ? WIN32[value] : undefined;
  if (win32Meaning) {
    const msi =
      /\b(msiexec|\.msi|windows installer)\b/i.test(context) &&
      [1603, 1618, 1638, 3010].includes(value);
    return {
      code: String(value),
      family: msi ? "msi" : "win32",
      meaning: win32Meaning,
      ...(value === 3010 ? { benign: true } : {}),
    };
  }
  return null;
}

const CODE_PATTERNS: RegExp[] = [
  /\b0x[0-9a-f]{8}\b/gi,
  /\bexit(?:ed)?(?:\s+with)?(?:\s+(?:status|code))?\s*[:=]?\s*(-?\d{1,10})\b/gi,
  /\b(?:exitcode|errorlevel|returned|return code)\s*[:=]?\s*(-?\d{1,10})\b/gi,
  /\b(?:win32 |system )?error\s+(\d{1,5})\b/gi,
  /\bERROR_[A-Z_]+\b/g,
  /\bE(?:NOENT|ACCES|PERM|BUSY|ADDRINUSE|NOSPC|MFILE|TIMEDOUT|CONNREFUSED|CONNRESET|NOTFOUND|EXIST|NOTEMPTY|ISDIR|NOTDIR|PIPE|NAMETOOLONG)\b/g,
];

const WIN32_NAMES: Record<string, number> = {
  ERROR_FILE_NOT_FOUND: 2,
  ERROR_PATH_NOT_FOUND: 3,
  ERROR_ACCESS_DENIED: 5,
  ERROR_SHARING_VIOLATION: 32,
  ERROR_DISK_FULL: 112,
  ERROR_ALREADY_EXISTS: 183,
  ERROR_FILENAME_EXCED_RANGE: 206,
  ERROR_CANCELLED: 1223,
};

/** Every code in the text that this module can decode, once each. */
export function extractCodes(text: string): DecodedCode[] {
  const found = new Map<string, DecodedCode>();
  for (const pattern of CODE_PATTERNS) {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      const named = WIN32_NAMES[match[0]];
      const candidate = named !== undefined ? String(named) : (match[1] ?? match[0]);
      const decoded = decodeCode(candidate, text);
      if (decoded && !found.has(decoded.code)) found.set(decoded.code, decoded);
    }
  }
  return [...found.values()];
}

/* ------------------------------------------------------------------ frames */

const SYSTEM_FRAME =
  /node_modules|site-packages|dist-packages|node:internal|^<frozen|[\\/]lib[\\/]python|[\\/]Python\d*[\\/](?:Lib|DLLs)[\\/]|[\\/]Lib[\\/]site-packages|[\\/]usr[\\/]lib|[\\/]rustc[\\/]|^System\.|^Microsoft\.|^java\.|^javax\.|^jdk\.|^sun\.|^runtime[./]|[\\/]go[\\/]src[\\/]|^C:\\Windows|^internal[\\/]/i;

const frame = (file: string, line?: string, fn?: string, column?: string): Frame => ({
  file,
  ...(line ? { line: Number(line) } : {}),
  ...(column ? { column: Number(column) } : {}),
  ...(fn ? { fn: fn.trim() } : {}),
  own: !SYSTEM_FRAME.test(file) && !(fn && SYSTEM_FRAME.test(fn)),
});

type Parsed = { language: ErrorLanguage; errorType: string; message: string; frames: Frame[] };

function parsePython(text: string): Parsed | null {
  if (!/Traceback \(most recent call last\)|^\s*File ".+", line \d+/m.test(text)) return null;
  // Python lists the oldest call first; every parser here returns the innermost frame first.
  const frames = [...text.matchAll(/^\s*File "([^"]+)", line (\d+)(?:, in (.+))?$/gm)]
    .map((m) => frame(m[1] ?? "", m[2], m[3]))
    .reverse();
  const last = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse()
    .find((line) => /^[A-Za-z_][\w.]*(Error|Exception|Exit|Interrupt|Warning)\b/.test(line));
  const split = /^([A-Za-z_][\w.]*)(?::\s*(.*))?$/.exec(last ?? "");
  return {
    language: "python",
    errorType: split?.[1] ?? "Error",
    message: split?.[2] ?? "",
    frames,
  };
}

function parseJava(text: string): Parsed | null {
  if (!/^\s*at [\w.$<>]+\([\w.$]+\.java:\d+\)/m.test(text) && !/^Caused by:/m.test(text))
    return null;
  const frames = [...text.matchAll(/^\s*at ([\w.$<>]+)\(([^:()]+):(\d+)\)/gm)].map((m) =>
    frame(`${m[1]}`.replace(/\.[^.]+$/, "") + "/" + (m[2] ?? ""), m[3], m[1]),
  );
  const causes = [
    ...text.matchAll(
      /^(?:Caused by: |Exception in thread "[^"]+" )?([\w.$]+(?:Exception|Error))(?::\s*(.*))?$/gm,
    ),
  ];
  const root = causes[causes.length - 1];
  return {
    language: "java",
    errorType: root?.[1] ?? "Exception",
    message: root?.[2] ?? "",
    frames,
  };
}

function parseCsharp(text: string): Parsed | null {
  if (!/^\s*at [\w.`<>+]+\(.*\)(?: in .+:line \d+)?\s*$/m.test(text) || !/Exception/.test(text))
    return null;
  const frames = [
    ...text.matchAll(/^\s*at ([\w.`<>+]+)\(.*?\)(?: in (.+?):line (\d+))?\s*$/gm),
  ].map((m) => frame(m[2] ?? m[1] ?? "", m[3], m[1]));
  const head = /^([\w.]+Exception)(?::\s*(.*))?$/m.exec(text);
  return {
    language: "csharp",
    errorType: head?.[1] ?? "Exception",
    message: head?.[2] ?? "",
    frames,
  };
}

function parseGo(text: string): Parsed | null {
  if (!/^panic: |goroutine \d+ \[/m.test(text)) return null;
  const frames: Frame[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const at = /^\s+(\S+\.go):(\d+)/.exec(lines[i] ?? "");
    if (at) frames.push(frame(at[1] ?? "", at[2], /^([\w./()*]+)\(/.exec(lines[i - 1] ?? "")?.[1]));
  }
  const panic = /^panic: (.+)$/m.exec(text);
  const message = panic?.[1] ?? "";
  return {
    language: "go",
    errorType: /nil pointer/.test(message) ? "nil pointer dereference" : "panic",
    message,
    frames,
  };
}

function parseRust(text: string): Parsed | null {
  const modern = /thread '[^']*' panicked at ([^:\s]+):(\d+):(\d+):?\s*\n?([^\n]*)/.exec(text);
  const classic = /thread '[^']*' panicked at '([^']*)', ([^:\s]+):(\d+):(\d+)/.exec(text);
  if (!modern && !classic) return null;
  const frames = [...text.matchAll(/\bat (\S+\.rs):(\d+):(\d+)/g)].map((m) =>
    frame(m[1] ?? "", m[2], undefined, m[3]),
  );
  const first = modern
    ? frame(modern[1] ?? "", modern[2], undefined, modern[3])
    : frame(classic?.[2] ?? "", classic?.[3], undefined, classic?.[4]);
  return {
    language: "rust",
    errorType: "panic",
    message: (modern ? modern[4] : classic?.[1]) ?? "",
    frames: [first, ...frames.filter((f) => f.file !== first.file || f.line !== first.line)],
  };
}

function parseJavascript(text: string): Parsed | null {
  if (!/^\s*at (?:async )?(?:.+ \()?(?:node:)?(?:[A-Za-z]:)?[^():\s]+:\d+:\d+\)?\s*$/m.test(text))
    return null;
  const frames = [
    ...text.matchAll(
      /^\s*at (?:async )?(?:(.+?) \()?((?:node:)?(?:[A-Za-z]:)?[^():]+?):(\d+):(\d+)\)?\s*$/gm,
    ),
  ].map((m) => frame(m[2] ?? "", m[3], m[1], m[4]));
  const head = /^(?:Uncaught )?([A-Z][A-Za-z]*(?:Error|Exception)|[A-Z]+_[A-Z_]+):?\s*(.*)$/m.exec(
    text,
  );
  return {
    language: "javascript",
    errorType: head?.[1] ?? "Error",
    message: head?.[2] ?? "",
    frames,
  };
}

function parseCpp(text: string): Parsed | null {
  const gcc = [...text.matchAll(/^(\S.*?):(\d+):(\d+): (?:fatal )?(error|warning): (.+)$/gm)];
  const msvc = [
    ...text.matchAll(/^(.+?)\((\d+)(?:,(\d+))?\): (?:fatal )?error (C\d+|LNK\d+|CS\d+): (.+)$/gm),
  ];
  const link = /undefined reference to|unresolved external symbol|LNK\d{4}/.test(text);
  if (!gcc.length && !msvc.length && !link) return null;
  const frames = [
    ...gcc.map((m) => frame(m[1] ?? "", m[2], undefined, m[3])),
    ...msvc.map((m) => frame(m[1] ?? "", m[2], undefined, m[3])),
  ];
  const first = gcc.find((m) => m[4] === "error") ?? msvc[0];
  return {
    language: "cpp",
    errorType: msvc[0]?.[4] ?? (link ? "link error" : "compile error"),
    message: first?.[5] ?? "",
    frames,
  };
}

function parsePowershell(text: string): Parsed | null {
  if (!/CategoryInfo\s*:|FullyQualifiedErrorId\s*:|At (?:line:\d+|[^\n]+:\d+) char:\d+/.test(text))
    return null;
  const at = /At (?:line:(\d+)|(.+?):(\d+)) char:(\d+)/.exec(text);
  const id =
    /FullyQualifiedErrorId\s*:\s*(\S+)/.exec(text)?.[1] ??
    /CategoryInfo\s*:.*?,\s*(\w+Exception)/.exec(text)?.[1];
  const frames = at ? [frame(at[2] ?? "script", at[1] ?? at[3], undefined, at[4])] : [];
  return {
    language: "powershell",
    errorType: id ?? "PowerShell error",
    message:
      text
        .split(/\r?\n/)
        .find((line) => line.trim() && !/^\s*(At |\+|CategoryInfo|FullyQualified)/.test(line))
        ?.trim() ?? "",
    frames,
  };
}

const PARSERS = [
  parsePython,
  parseJava,
  parseCsharp,
  parseGo,
  parseRust,
  parsePowershell,
  parseCpp,
  parseJavascript,
];

/* ------------------------------------------------------------ fingerprint */

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** The message with what changes between runs taken out: paths, numbers, addresses, quoted names. */
export function normaliseMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/[a-z]:\\[^\s'"]+/g, "<path>")
    .replace(/(?:\/[\w.@-]+){2,}/g, "<path>")
    .replace(/0x[0-9a-f]+/g, "<hex>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
    .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "'?'")
    .replace(/\d+/g, "n")
    .replace(/\s+/g, " ")
    .trim();
}

const base = (file: string): string => file.replace(/\\/g, "/").split("/").pop() ?? file;

/* --------------------------------------------------------------- normalise */

export function normalizeError(input: string): NormalizedError {
  const text = String(input ?? "").slice(0, 60_000);
  let parsed: Parsed | null = null;
  for (const parse of PARSERS) {
    parsed = parse(text);
    if (parsed) break;
  }
  const codes = extractCodes(text);
  if (!parsed) {
    const first =
      text
        .split(/\r?\n/)
        .find((line) => /error|failed|fatal|exception|denied|cannot|unable/i.test(line)) ?? "";
    const tooling =
      /\b(npm|pnpm|yarn|pip|winget|msiexec|electron-builder|nsis|git|cargo|dotnet|msbuild)\b/i.test(
        text,
      );
    parsed = {
      language: codes.some((c) => c.family !== "errno" && c.family !== "exit")
        ? "windows"
        : tooling
          ? "tooling"
          : "unknown",
      errorType: codes[0]?.code ?? "",
      message: first.trim(),
      frames: [],
    };
  }
  const top = parsed.frames.find((f) => f.own) ?? parsed.frames[0];
  const key = [
    parsed.language,
    parsed.errorType.toLowerCase(),
    normaliseMessage(parsed.message || codes.map((c) => c.code).join(",")),
    top ? `${base(top.file)}:${top.fn ?? ""}`.toLowerCase() : "",
  ].join("|");
  return {
    language: parsed.language,
    errorType: parsed.errorType,
    message: parsed.message.slice(0, 400),
    frames: parsed.frames.slice(0, 40),
    codes,
    fingerprint: `fp-${fnv1a(key)}`,
    lines: text.split(/\r?\n/).length,
  };
}

/* ------------------------------------------------------------------- rules */

type Rule = {
  id: string;
  test: (n: NormalizedError, raw: string) => boolean;
  cause: string;
  base: number;
  check: string;
  fix: Hypothesis["fix"];
  adjust?: (e: Evidence, n: NormalizedError) => { delta: number; note: string } | null;
};

const hasCode = (n: NormalizedError, ...codes: string[]) =>
  n.codes.some((c) => codes.includes(c.code.toLowerCase()));

const RULES: Rule[] = [
  {
    id: "disk-full",
    test: (n, raw) =>
      /ENOSPC|no space left on device|not enough space on the disk|disk (is )?full/i.test(raw) ||
      hasCode(n, "112"),
    cause: "the disk this write goes to is full",
    base: 0.8,
    check:
      "read the free space of the drive in the path (Self Atlas or the Disks answer); nothing is changed",
    fix: {
      summary: "free space on that drive, then run the step again",
      steps: [
        "clear FRIDAY's temporary folder from Storage (it lists what it will remove)",
        "empty the Recycle Bin and old installers in Downloads",
        "run the failed step once more",
      ],
      risk: "low",
    },
    adjust: (e) =>
      e.diskFreeGb === undefined
        ? null
        : e.diskFreeGb < 1
          ? { delta: 0.15, note: `only ${e.diskFreeGb} GB free on the checked drive` }
          : e.diskFreeGb >= 20
            ? {
                delta: -0.5,
                note: `${e.diskFreeGb} GB is free on the checked drive, so another drive or a quota is involved`,
              }
            : null,
  },
  {
    id: "permission-denied",
    test: (n, raw) =>
      /EACCES|EPERM|permission denied|access is denied|operation not permitted/i.test(raw) ||
      hasCode(n, "5", "0x80070005", "0xc0000022"),
    cause: "the account running this has no right to that file, folder or key",
    base: 0.7,
    check: "read the rights on the path (icacls <path>); nothing is changed",
    fix: {
      summary: "run it in a folder you own, or ask for the right to be granted deliberately",
      steps: [
        "check whether the path is under Program Files, Windows or another account's profile",
        "if it is, move the work to a folder under your own profile or the FRIDAY folder",
        "only if the owner agrees: grant the right on that one path",
      ],
      risk: "needs-approval",
    },
  },
  {
    id: "file-in-use",
    test: (n, raw) =>
      /EBUSY|being used by another process|sharing violation|resource busy/i.test(raw) ||
      hasCode(n, "32", "0x80070020"),
    cause:
      "another program holds the file open (an editor, antivirus, a running FRIDAY process, or a previous run that did not exit)",
    base: 0.75,
    check:
      "list the programs using the path (Resource Monitor > Associated Handles); nothing is changed",
    fix: {
      summary: "close the program that holds it, then retry once",
      steps: [
        "close editors and previews showing the file",
        "stop a leftover process from the previous run",
        "retry the step once",
      ],
      risk: "low",
    },
  },
  {
    id: "port-in-use",
    test: (n, raw) =>
      /EADDRINUSE|address already in use|only one usage of each socket address/i.test(raw),
    cause: "another process already listens on that network port",
    base: 0.85,
    check: "find the owner of the port (netstat -ano, then the process name); nothing is changed",
    fix: {
      summary: "stop the process that owns the port, or move this service to a free port",
      steps: [
        "identify the process on that port",
        "if it is a leftover FRIDAY process, stop it from Services",
        "start the service again",
      ],
      risk: "low",
    },
    adjust: (e) =>
      e.portOwner ? { delta: 0.1, note: `the port is held by ${e.portOwner}` } : null,
  },
  {
    id: "module-missing-python",
    test: (_n, raw) =>
      /ModuleNotFoundError|No module named|ImportError: DLL load failed/i.test(raw),
    cause:
      "the Python package is not installed in the interpreter that ran this, or a DLL it needs is missing",
    base: 0.8,
    check:
      'run the interpreter that failed with -c "import <name>" and print sys.executable; nothing is installed',
    fix: {
      summary: "install the package into that interpreter's environment",
      steps: [
        "confirm which python ran (the venv, not the system one)",
        "install the package with that python -m pip",
        "retry",
      ],
      risk: "needs-approval",
    },
  },
  {
    id: "module-missing-node",
    test: (_n, raw) => /Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/i.test(raw),
    cause: "a Node package or file is missing, or node_modules does not match the lockfile",
    base: 0.8,
    check:
      "check that node_modules exists and the package is listed in package.json; nothing is installed",
    fix: {
      summary: "install exactly what the lockfile says",
      steps: ["run npm ci from the project root", "retry the command"],
      risk: "needs-approval",
    },
  },
  {
    id: "path-too-long",
    test: (n, raw) =>
      /ENAMETOOLONG|filename or extension is too long|path (is )?too long|MAX_PATH/i.test(raw) ||
      hasCode(n, "206"),
    cause:
      "the full path is longer than the 260 characters Windows allows without long-path support",
    base: 0.85,
    check: "count the characters in the full path; nothing is changed",
    fix: {
      summary: "work from a shorter folder, or turn on long paths",
      steps: [
        "move the project to a short path such as D:\\friday",
        "or enable LongPathsEnabled in the registry and restart (administrator)",
      ],
      risk: "needs-approval",
    },
  },
  {
    id: "crlf-script",
    test: (_n, raw) =>
      /\r': command not found|bad interpreter: .*\r|\^M/.test(raw) ||
      /\\r': command not found/.test(raw),
    cause:
      "a shell script was saved with Windows line endings (CRLF), so the shell reads a stray carriage return",
    base: 0.85,
    check:
      "look for carriage returns in the file (a hex view or git ls-files --eol); nothing is changed",
    fix: {
      summary: "store the script with LF endings and keep it that way",
      steps: [
        "convert the file to LF",
        "add a .gitattributes rule such as *.sh text eol=lf",
        "commit the change",
      ],
      risk: "needs-approval",
    },
  },
  {
    id: "clock-or-tls",
    test: (n, raw) =>
      /certificate (is )?(not yet valid|has expired)|CERT_E_EXPIRED|NotBefore|SSL certificate problem|unable to get local issuer|self[- ]signed/i.test(
        raw,
      ) || hasCode(n, "0x80072f8f"),
    cause:
      "the secure connection failed: the PC clock is wrong, or a certificate on the way is not trusted",
    base: 0.5,
    check: "compare the PC clock with a trusted time; nothing is changed",
    fix: {
      summary: "fix the clock first, then look at a proxy or security tool that re-signs traffic",
      steps: [
        "sync the Windows clock (Settings > Time & language)",
        "retry",
        "if it still fails, check for a company proxy or antivirus inspecting HTTPS",
      ],
      risk: "low",
    },
    adjust: (e) =>
      e.clockSkewMs === undefined
        ? null
        : Math.abs(e.clockSkewMs) > 5 * 60_000
          ? {
              delta: 0.35,
              note: `the PC clock is ${Math.round(Math.abs(e.clockSkewMs) / 60000)} minutes off`,
            }
          : { delta: -0.25, note: "the PC clock is within a few minutes of the real time" },
  },
  {
    id: "host-not-found",
    test: (_n, raw) =>
      /ENOTFOUND|getaddrinfo|could not resolve host|name or service not known|0x80072ee7/i.test(
        raw,
      ),
    cause: "the host name could not be resolved: no network, a DNS fault, or a typo in the address",
    base: 0.7,
    check: "resolve the name with nslookup and check the adapter is connected; nothing is changed",
    fix: {
      summary: "restore the connection or correct the address",
      steps: ["check Wi-Fi or cable", "check the host name for typos", "retry"],
      risk: "none",
    },
  },
  {
    id: "connection-refused",
    test: (_n, raw) => /ECONNREFUSED|connection refused|actively refused it/i.test(raw),
    cause: "nothing is listening at that address: the service is not running or is on another port",
    base: 0.7,
    check: "check whether the service is running and on which port; nothing is changed",
    fix: {
      summary: "start the service, or point the client at the right port",
      steps: ["start the service", "confirm its port", "retry"],
      risk: "low",
    },
    adjust: (e) =>
      e.kernelUp === false
        ? { delta: 0.2, note: "the FRIDAY kernel is not answering on this PC right now" }
        : e.kernelUp === true
          ? {
              delta: -0.2,
              note: "the FRIDAY kernel is answering, so the target is a different service",
            }
          : null,
  },
  {
    id: "rate-limited",
    test: (_n, raw) => /\b429\b|rate limit|too many requests|quota exceeded/i.test(raw),
    cause: "the provider is limiting requests (a rate limit or a daily quota)",
    base: 0.8,
    check: "read the Retry-After header or the provider's quota page; nothing is changed",
    fix: {
      summary: "wait for the window, or let FRIDAY route to another allowed model",
      steps: ["wait the stated time", "retry once", "otherwise use another provider"],
      risk: "none",
    },
  },
  {
    id: "pip-externally-managed",
    test: (_n, raw) => /externally-managed-environment/i.test(raw),
    cause: "pip refuses to install into a system Python that the OS manages (PEP 668)",
    base: 0.95,
    check: "check whether the python that ran is a virtual environment; nothing is changed",
    fix: {
      summary: "install into a virtual environment instead",
      steps: ["create or activate the .venv", "install with that python -m pip"],
      risk: "needs-approval",
    },
  },
  {
    id: "npm-peer-conflict",
    test: (_n, raw) => /ERESOLVE|unable to resolve dependency tree|peer dep/i.test(raw),
    cause:
      "two packages ask for versions that cannot both be installed (a peer dependency conflict)",
    base: 0.85,
    check: "read which two packages conflict in the npm output; nothing is changed",
    fix: {
      summary: "align the versions the lockfile allows, not --force",
      steps: [
        "find the two packages named in the message",
        "update or pin one so the ranges overlap",
        "run npm ci to confirm",
      ],
      risk: "needs-approval",
    },
  },
  {
    id: "engine-floor",
    test: (_n, raw) => /EBADENGINE|Unsupported engine|requires (a )?(node|python)/i.test(raw),
    cause: "the Node or Python on this PC is older than the version this project requires",
    base: 0.8,
    check:
      "compare node -v / python --version with config/toolchain-versions.json; nothing is changed",
    fix: {
      summary: "use a runtime that meets the floor",
      steps: ["install the required version", "open a new terminal so PATH refreshes", "retry"],
      risk: "needs-approval",
    },
    adjust: (e) =>
      e.nodeVersion && e.nodeFloor
        ? {
            delta:
              e.nodeVersion.localeCompare(e.nodeFloor, undefined, { numeric: true }) < 0
                ? 0.15
                : -0.4,
            note: `node ${e.nodeVersion} against a floor of ${e.nodeFloor}`,
          }
        : e.pythonVersion && e.pythonFloor
          ? {
              delta:
                e.pythonVersion.localeCompare(e.pythonFloor, undefined, { numeric: true }) < 0
                  ? 0.15
                  : -0.4,
              note: `python ${e.pythonVersion} against a floor of ${e.pythonFloor}`,
            }
          : null,
  },
  {
    id: "script-policy",
    test: (_n, raw) =>
      /running scripts is disabled|PSSecurityException|UnauthorizedAccess.*\.ps1|execution policy/i.test(
        raw,
      ),
    cause: "PowerShell's execution policy blocks the script",
    base: 0.85,
    check: "read Get-ExecutionPolicy -List; nothing is changed",
    fix: {
      summary: "run this one script with a process-only policy",
      steps: [
        "powershell -ExecutionPolicy Bypass -File <script> for this run only",
        "do not change the machine-wide policy",
      ],
      risk: "low",
    },
  },
  {
    id: "command-not-found",
    test: (_n, raw) =>
      /CommandNotFoundException|is not recognized as the name of a cmdlet|is not recognized as an internal or external command|command not found/i.test(
        raw,
      ),
    cause: "the program is not installed, or its folder is not on PATH in this terminal",
    base: 0.75,
    check: "run where.exe <name> in a new terminal; nothing is changed",
    fix: {
      summary: "install it, or open a fresh terminal so PATH refreshes",
      steps: ["check Install Manager for the tool", "open a new terminal", "retry"],
      risk: "low",
    },
  },
  {
    id: "encoding",
    test: (_n, raw) =>
      /UnicodeDecodeError|codec can't decode|invalid continuation byte|invalid start byte/i.test(
        raw,
      ),
    cause: "a file was read with the wrong text encoding (often cp1252 against UTF-8)",
    base: 0.8,
    check: "check the file's encoding and the open() call's encoding argument; nothing is changed",
    fix: {
      summary: "read it explicitly as UTF-8",
      steps: ['pass encoding="utf-8" to the read', "if the file is cp1252, convert it once"],
      risk: "needs-approval",
    },
  },
  {
    id: "syntax",
    test: (n) =>
      /SyntaxError|IndentationError|TabError|Unexpected token|Unexpected end of/i.test(
        n.errorType + " " + n.message,
      ),
    cause: "the file at the named line is not valid code (a missing bracket, quote or indent)",
    base: 0.9,
    check: "open the file at the named line and the line above it; nothing is changed",
    fix: {
      summary: "correct the line the error points at",
      steps: [
        "fix the syntax at the named file and line",
        "run the language's own check on that file",
        "run the tests that cover it",
      ],
      risk: "needs-approval",
    },
  },
  {
    id: "null-access",
    test: (n, raw) =>
      /Cannot read propert(y|ies) of (undefined|null)|undefined is not an object|NullPointerException|NullReferenceException|nil pointer dereference|called `Option::unwrap\(\)` on a `None`|AttributeError: 'NoneType'|TypeError: .*'NoneType'/i.test(
        raw,
      ) || /NullReference|NullPointer/.test(n.errorType),
    cause:
      "a value that should exist was empty (null, undefined, None or nil) where the code used it",
    base: 0.8,
    check: "read the named line and find where that value is set; nothing is changed",
    fix: {
      summary: "handle the empty case at the place the value is produced",
      steps: [
        "find where the value can be empty",
        "add the check or a default there",
        "add a test with the empty input",
      ],
      risk: "needs-approval",
    },
  },
  {
    id: "index-or-key",
    test: (_n, raw) =>
      /IndexError|KeyError|index out of range|index out of bounds|ArrayIndexOutOfBounds|KeyNotFoundException/i.test(
        raw,
      ),
    cause: "the code asked for an item that is not there (a list index or a dictionary key)",
    base: 0.75,
    check: "print the length or keys just before the failing line in a test; nothing is changed",
    fix: {
      summary: "check the bounds or use a lookup with a default",
      steps: ["guard the access", "add a test for the missing item"],
      risk: "needs-approval",
    },
  },
  {
    id: "missing-include",
    test: (_n, raw) =>
      /fatal error: .*: No such file or directory|Cannot open include file|C1083/i.test(raw),
    cause:
      "a header file the compiler needs is not found: the include path is wrong or the library is not installed",
    base: 0.8,
    check: "search the include paths for the header; nothing is changed",
    fix: {
      summary: "install the library or add its include folder",
      steps: ["install the development package", "add its include path to the build", "rebuild"],
      risk: "needs-approval",
    },
  },
  {
    id: "unresolved-symbol",
    test: (_n, raw) =>
      /undefined reference to|unresolved external symbol|LNK2019|LNK2001|LNK1120/i.test(raw),
    cause:
      "the code uses a function the linker cannot find: a library is not linked, or the order is wrong",
    base: 0.8,
    check: "find which library defines that symbol; nothing is changed",
    fix: {
      summary: "link the library that defines it",
      steps: [
        "add the library to the link line",
        "keep dependent libraries after the code that uses them",
        "rebuild",
      ],
      risk: "needs-approval",
    },
  },
  {
    id: "missing-runtime-dll",
    test: (n) => hasCode(n, "0xc0000135", "0xc000007b", "0xc0000142"),
    cause:
      "a runtime DLL is missing or does not match the program (often the Visual C++ runtime, or 32-bit against 64-bit)",
    base: 0.7,
    check:
      "note the program's bitness and look at the Application event log for the faulting module; nothing is changed",
    fix: {
      summary:
        "install the matching Visual C++ Redistributable, or the build of the program that matches this PC",
      steps: ["install the x64 (or x86) Redistributable from Microsoft", "run the program again"],
      risk: "needs-approval",
    },
  },
  {
    id: "native-crash",
    test: (n, raw) =>
      hasCode(n, "0xc0000005", "0xc0000374", "0xc0000409", "0xc00000fd") ||
      /segmentation fault|access violation|stack overflow/i.test(raw),
    cause: "the program crashed in native code (a bad memory access or a detected corruption)",
    base: 0.6,
    check:
      "read the Application event log entry for the faulting module and offset; nothing is changed",
    fix: {
      summary: "find the faulting module first, then update or reinstall that component",
      steps: [
        "note the faulting module from the crash record",
        "update the driver or program that owns it",
        "if it is our own code, localise with a debug build",
      ],
      risk: "needs-approval",
    },
    adjust: (e) => {
      const seen = e.crashApps?.[0];
      return seen
        ? {
            delta: 0.1,
            note: `${seen.app} appears in ${seen.count} recent crash record(s) on this PC`,
          }
        : null;
    },
  },
  {
    id: "needs-elevation",
    test: (n, raw) => hasCode(n, "740") || /requires elevation|run as administrator/i.test(raw),
    cause: "this step needs administrator rights",
    base: 0.85,
    check: "none: the prompt belongs to the owner",
    fix: {
      summary:
        "FRIDAY does not click the administrator prompt; approve it yourself when it appears",
      steps: ["start the step again and accept the Windows prompt yourself"],
      risk: "needs-approval",
    },
  },
  {
    id: "installer-busy",
    test: (n) => hasCode(n, "1618", "1638", "1603"),
    cause:
      "the Windows installer is busy, a copy is already installed, or the install hit a fatal error",
    base: 0.7,
    check: "read the installer log (msiexec /l*v) for the first error line; nothing is changed",
    fix: {
      summary: "wait for the other install, or uninstall the old copy first",
      steps: ["wait a few minutes and retry once", "check Apps & features for the older version"],
      risk: "low",
    },
  },
  {
    id: "benign-code",
    test: (n) => n.codes.length > 0 && n.codes.every((c) => c.benign),
    cause:
      "the code is not a failure: the tool is reporting that nothing needed doing, or that a restart is due",
    base: 0.9,
    check: "none: the meaning is in the code table",
    fix: {
      summary: "nothing to fix; treat this result as success",
      steps: ["continue with the next step"],
      risk: "none",
    },
  },
  {
    id: "git-ownership",
    test: (_n, raw) => /detected dubious ownership|safe\.directory/i.test(raw),
    cause: "Git refuses a repository owned by a different Windows account",
    base: 0.9,
    check: "compare the folder's owner with the current user; nothing is changed",
    fix: {
      summary: "mark that one folder as safe for this user",
      steps: ["git config --global --add safe.directory <that folder>"],
      risk: "needs-approval",
    },
  },
  {
    id: "merge-conflict",
    test: (_n, raw) =>
      /CONFLICT \(content\)|Automatic merge failed|fix conflicts and then commit/i.test(raw),
    cause: "two branches changed the same lines, so Git needs a person to choose",
    base: 0.95,
    check: "git status lists the files with conflicts; nothing is changed",
    fix: {
      summary: "resolve the marked lines, keeping both intents, then continue",
      steps: [
        "open each conflicted file",
        "choose the final text for each marked block",
        "run the tests, then continue the merge",
      ],
      risk: "needs-approval",
    },
  },
];

/* --------------------------------------------------------- hypotheses etc. */

const clamp = (value: number): number =>
  Math.max(0.02, Math.min(0.98, Math.round(value * 100) / 100));

function rankHypotheses(n: NormalizedError, raw: string, evidence: Evidence): Hypothesis[] {
  const rows: Hypothesis[] = [];
  for (const rule of RULES) {
    let matched = false;
    try {
      matched = rule.test(n, raw);
    } catch {
      matched = false;
    }
    if (!matched) continue;
    const notes: string[] = [];
    for (const code of n.codes.slice(0, 3)) notes.push(`${code.code}: ${code.meaning}`);
    if (n.errorType) notes.push(`error type ${n.errorType}`);
    let confidence = rule.base;
    const adjust = rule.adjust?.(evidence, n);
    if (adjust) {
      confidence += adjust.delta;
      notes.push(adjust.note);
    }
    rows.push({
      id: rule.id,
      cause: rule.cause,
      confidence: clamp(confidence),
      evidence: notes,
      check: rule.check,
      fix: rule.fix,
    });
  }
  rows.sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
  return rows.slice(0, 5);
}

/**
 * Where to look. A stack frame in the owner's code comes first, then a recently changed file that
 * appears in the trace, then a bisect plan. A guess without one of these is not offered.
 */
export function localize(
  n: NormalizedError,
  evidence: Evidence = {},
): { location: Location | null; bisect: string | null } {
  const own = n.frames.find((f) => f.own);
  const changed = evidence.recentChanges ?? [];
  const norm = (file: string) => file.replace(/\\/g, "/").toLowerCase();
  const touched = n.frames.find(
    (f) =>
      f.own &&
      changed.some(
        (c) => norm(f.file).endsWith(norm(c.path)) || norm(c.path).endsWith(norm(base(f.file))),
      ),
  );
  if (touched) {
    const change = changed.find(
      (c) =>
        norm(touched.file).endsWith(norm(c.path)) ||
        norm(c.path).endsWith(norm(base(touched.file))),
    );
    return {
      location: {
        file: touched.file,
        ...(touched.line ? { line: touched.line } : {}),
        ...(touched.fn ? { fn: touched.fn } : {}),
        basis: "stack-trace",
        note: `the trace points here, and this file changed recently${change?.subject ? ` ("${change.subject}")` : ""}`,
      },
      bisect: null,
    };
  }
  if (own) {
    return {
      location: {
        file: own.file,
        ...(own.line ? { line: own.line } : {}),
        ...(own.fn ? { fn: own.fn } : {}),
        basis: "stack-trace",
        note: "the innermost frame in code that is not a library or the runtime",
      },
      bisect: null,
    };
  }
  const suspect = changed.find((c) => c.path);
  if (suspect) {
    return {
      location: {
        file: suspect.path,
        basis: "change-history",
        note: "no usable frame; this is the most recently changed file and only a lead, not a finding",
      },
      bisect:
        "git bisect start; git bisect bad HEAD; git bisect good <last known good commit>; git bisect run <the failing test command>",
    };
  }
  return {
    location: null,
    bisect: n.frames.length
      ? null
      : "no stack frame and no change history were given: send the full trace, or the last good commit so a bisect can be planned (git bisect start; git bisect bad HEAD; git bisect good <commit>)",
  };
}

/** Evidence the app already holds, from the cached reliability probe. Nothing is read here. */
export function evidenceFromProbes(): Evidence {
  const crashes = latestReliability()?.items.find((item) => item.id === "crashes");
  return crashes?.apps?.length ? { crashApps: crashes.apps } : {};
}

export function diagnose(input: { text: string; evidence?: Evidence }): Diagnosis {
  const raw = String(input.text ?? "");
  const evidence = { ...evidenceFromProbes(), ...(input.evidence ?? {}) };
  const normalized = normalizeError(raw);
  const kind = classifyFailure(raw);
  const domain = failureDomain(raw);
  const recovery = recoverFailure(kind);
  const hypotheses = rankHypotheses(normalized, raw, evidence);
  const { location, bisect } = localize(normalized, evidence);
  const noRetry =
    ["stop", "restore", "expire"].includes(recovery.action) ||
    [
      "disk-full",
      "permission-denied",
      "port-in-use",
      "path-too-long",
      "syntax",
      "script-policy",
      "needs-elevation",
      "pip-externally-managed",
    ].includes(hypotheses[0]?.id ?? "");
  const unknown: string[] = [];
  if (!hypotheses.length) unknown.push("no known cause matches this text");
  if (!normalized.frames.length) unknown.push("no stack frames, so the failing line is not known");
  if (normalized.codes.length === 0 && /0x[0-9a-f]{8}|exit code/i.test(raw))
    unknown.push("a code in the text is not in the decode tables");
  if (hypotheses.length && hypotheses[0] && hypotheses[0].confidence < 0.6)
    unknown.push("the best cause is below 60% sure, so check before acting");
  if (hypotheses[0]?.id === "disk-full" && evidence.diskFreeGb === undefined)
    unknown.push("the free space of the drive was not read");
  return {
    ...normalized,
    domain,
    kind,
    recovery,
    retryable: !noRetry,
    hypotheses,
    location,
    bisect,
    confidence: hypotheses[0]?.confidence ?? 0,
    unknown,
    expertise: diagnoseError(raw).map((entry) => entry.id),
  };
}

/** A pasted error, or a crash code with a word that says it failed. */
export function looksLikeFailure(text: string): boolean {
  if (looksLikeError(text)) return true;
  return (
    extractCodes(text).length > 0 &&
    /\b(exit|exited|failed|failure|crash|crashed|error)\b/i.test(text)
  );
}

/* ---------------------------------------------------------------- guidance */

const HINGLISH =
  /\b(hai|hain|kya|kaise|kyun|kyu|nahi|nahin|mujhe|mera|meri|karo|kar do|batao|samajh|dikkat|problem aa|aa rahi|aa raha|ho raha|ho rahi|ye error|yeh error)\b/i;

export function prefersHinglish(text: string): boolean {
  return HINGLISH.test(String(text ?? ""));
}

const pct = (value: number) => `${Math.round(value * 100)}%`;
const RISK_HI: Record<FixRisk, string> = {
  none: "kuch badalta nahi",
  low: "chhota aur wapas hone wala badlaav",
  "needs-approval": "isme aapki ijazat chahiye",
};
const RISK_EN: Record<FixRisk, string> = {
  none: "nothing changes",
  low: "a small change that can be undone",
  "needs-approval": "this needs your approval first",
};

/** Short guidance: what broke, why, the safest fix, what changes, how to undo it, one question at most. */
export function guidance(diagnosis: Diagnosis, style: "hinglish" | "english" = "english"): string {
  const hi = style === "hinglish";
  const top = diagnosis.hypotheses[0];
  const what =
    [diagnosis.errorType, diagnosis.message].filter(Boolean).join(": ") ||
    diagnosis.codes[0]?.meaning ||
    "an error";
  const lines: string[] = [
    hi ? `Kya hua: ${what.slice(0, 200)}` : `What broke: ${what.slice(0, 200)}`,
  ];
  for (const code of diagnosis.codes.slice(0, 2)) {
    lines.push(
      hi
        ? `Code ${code.code} ka matlab: ${code.meaning}.`
        : `Code ${code.code} means: ${code.meaning}.`,
    );
  }
  if (diagnosis.location) {
    const where = `${diagnosis.location.file}${diagnosis.location.line ? `:${diagnosis.location.line}` : ""}${diagnosis.location.fn ? ` (${diagnosis.location.fn})` : ""}`;
    lines.push(
      hi
        ? `Jagah: ${where} — ${diagnosis.location.note}.`
        : `Where: ${where} — ${diagnosis.location.note}.`,
    );
  }
  if (!top) {
    lines.push(
      hi
        ? "Is error ki pehchaan nahi ho payi, isliye andaza nahi lagaya. Poora error ya pichhla kaam kiya hua commit bhejiye."
        : "I could not recognise this one, so I will not guess. Send the full error, or the last commit that worked.",
    );
    if (diagnosis.bisect)
      lines.push(hi ? `Agla kadam: ${diagnosis.bisect}` : `Next step: ${diagnosis.bisect}`);
    return lines.join("\n");
  }
  lines.push(
    hi
      ? `Sabse sambhav wajah (${pct(top.confidence)}): ${top.cause}.`
      : `Most likely cause (${pct(top.confidence)}): ${top.cause}.`,
  );
  for (const note of top.evidence.slice(-2))
    lines.push(hi ? `Saboot: ${note}.` : `Evidence: ${note}.`);
  lines.push(
    hi ? `Pehle yeh dekho (sirf padhna): ${top.check}.` : `Check first (read only): ${top.check}.`,
  );
  lines.push(
    hi ? `Safe fix: ${top.fix.summary}.` : `Safest fix: ${top.fix.summary}.`,
    ...top.fix.steps.map((step, index) => `${index + 1}. ${step}`),
  );
  lines.push(
    hi
      ? `Kya badlega: ${RISK_HI[top.fix.risk]}. Undo: badalne se pehle backup banta hai, aur wapas lene ka tareeka dikhaya jaata hai.`
      : `What changes: ${RISK_EN[top.fix.risk]}. Undo: a backup is taken before any change and the way back is shown.`,
  );
  if (!diagnosis.retryable) {
    lines.push(
      hi
        ? "Dobara chalane se fark nahi padega, isliye retry nahi kar rahe."
        : "Running it again will not help, so I will not retry blindly.",
    );
  }
  if (diagnosis.hypotheses[1] && top.confidence - diagnosis.hypotheses[1].confidence < 0.15) {
    lines.push(
      hi
        ? `Ek sawaal: kya yeh "${diagnosis.hypotheses[1].cause}" bhi ho sakta hai? Upar wala check batayega.`
        : `One question: could it be "${diagnosis.hypotheses[1].cause}" instead? The check above will tell.`,
    );
  } else if (diagnosis.unknown.length) {
    lines.push(
      hi ? `Abhi pata nahi: ${diagnosis.unknown[0]}.` : `Still unknown: ${diagnosis.unknown[0]}.`,
    );
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------- fix proposal */

export type FixProposalInput = {
  diagnosis: Diagnosis;
  /** The reviewable diff, produced elsewhere and checked in a sandbox. */
  diff: string;
  files: string[];
  tests: string[];
  rollback: string;
  level?: "strict" | "balanced" | "trusted" | "full";
  /** Check the proposal through the gate without queueing it (the eval harness never touches the owner's queue). */
  dryRun?: boolean;
};

export type FixProposalResult = {
  filed: boolean;
  id: string | null;
  allow: "refuse" | "ask" | "stage" | "incomplete";
  reason: string;
  applied: false;
};

/**
 * A fix is filed, never applied. It must name its files, the tests that cover it and how to undo
 * it; a protected path is refused; the item goes to the existing governance queue, always-ask.
 */
export function fileFixProposal(input: FixProposalInput): FixProposalResult {
  const missing = [
    !input.files.length ? "the files it changes" : "",
    !input.tests.length ? "the tests that cover it" : "",
    !input.rollback.trim() ? "how to undo it" : "",
    !input.diff.trim() ? "the diff" : "",
  ].filter(Boolean);
  if (missing.length) {
    return {
      filed: false,
      id: null,
      allow: "incomplete",
      reason: `a fix proposal needs ${missing.join(", ")}`,
      applied: false,
    };
  }
  const gate = proposeDiff({
    paths: input.files,
    diff: input.diff,
    level: input.level ?? "balanced",
  });
  if (gate.allow === "refuse") {
    return { filed: false, id: null, allow: "refuse", reason: gate.reason, applied: false };
  }
  if (input.dryRun) {
    return { filed: false, id: null, allow: gate.allow, reason: gate.reason, applied: false };
  }
  const top = input.diagnosis.hypotheses[0];
  const filed = proposeFabricLimitation({
    id: `fix-${input.diagnosis.fingerprint}`,
    title: `Fix: ${(input.diagnosis.errorType || input.diagnosis.codes[0]?.code || "error").slice(0, 60)}`,
    rationale: top
      ? `${top.cause} (${pct(top.confidence)} sure)`
      : "an unrecognised failure with a located cause",
    evidence: [
      `fingerprint ${input.diagnosis.fingerprint}`,
      ...input.files.map((file) => `file ${file}`),
      ...input.tests.map((test) => `test ${test}`),
      `rollback ${input.rollback.trim().slice(0, 160)}`,
    ],
    kind: "code-change",
    risk: "review",
  });
  return {
    filed: filed.queued,
    id: filed.id,
    allow: gate.allow,
    reason: gate.reason,
    applied: false,
  };
}

/* ------------------------------------------------------------- risk scanner */

export type RiskSeverity = "high" | "medium" | "low";

export type RiskFinding = {
  rule: string;
  severity: RiskSeverity;
  path: string;
  line: number;
  /** The line with any secret replaced. */
  excerpt: string;
  remedy: string;
};

type RiskRule = {
  id: string;
  severity: RiskSeverity;
  pattern: RegExp;
  remedy: string;
  secret?: boolean;
  skip?: RegExp;
};

const RISK_RULES: RiskRule[] = [
  {
    id: "private-key-block",
    severity: "high",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
    remedy: "remove the key from the file, rotate it, and keep it in the OS credential store",
    secret: true,
  },
  {
    id: "aws-access-key",
    severity: "high",
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    remedy: "rotate the key and load it from the environment or the credential store",
    secret: true,
  },
  {
    id: "github-token",
    severity: "high",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
    remedy: "revoke the token on GitHub and store a new one in safeStorage",
    secret: true,
  },
  {
    id: "api-key-literal",
    severity: "high",
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/,
    remedy: "revoke the key and store the new one in safeStorage",
    secret: true,
  },
  {
    id: "slack-token",
    severity: "high",
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
    remedy: "revoke the token and store a new one in safeStorage",
    secret: true,
  },
  {
    id: "password-literal",
    severity: "medium",
    pattern: /\b(?:password|passwd|secret|api[_-]?key)\b\s*[:=]\s*['"][^'"\s]{8,}['"]/i,
    remedy: "read it from the environment or the credential store, not from the file",
    secret: true,
    skip: /example|placeholder|changeme|your[_-]|<.+>|\*{3,}|process\.env|os\.environ/i,
  },
  {
    id: "shell-from-input",
    severity: "high",
    pattern:
      /\bsubprocess\.[a-z_]+\([^)]*shell\s*=\s*True|\bos\.system\(\s*f?["'][^"']*[{%]|\bchild_process\.exec(?:Sync)?\(\s*[`"'][^`"']*\$\{|\bchild_process\.exec(?:Sync)?\(\s*[A-Za-z_$][\w$.]*\s*\+/,
    remedy:
      "pass an argument list, not one string built from input, and never use shell=True with a variable",
  },
  {
    id: "eval-call",
    severity: "medium",
    pattern: /(?<![\w.])eval\(\s*[^'")\s]/,
    remedy: "parse the data instead of evaluating it",
  },
  {
    id: "powershell-iex",
    severity: "medium",
    pattern: /\b(?:Invoke-Expression|iex)\b\s+[$(]/i,
    remedy: "call the command directly with parameters instead of building a string to run",
  },
  {
    id: "recursive-delete-variable",
    severity: "medium",
    pattern:
      /\brm\s+-rf?\s+["']?\$|\bshutil\.rmtree\(\s*[A-Za-z_][\w.]*\s*[,)]|\bRemove-Item\b[^\n]*-Recurse[^\n]*\$/i,
    remedy:
      "check the path is inside the folder you mean, and move to the trash instead of deleting",
  },
  {
    id: "sql-without-where",
    severity: "medium",
    pattern: /\b(?:DELETE FROM|UPDATE)\s+\w+\s*(?:;|$)(?![\s\S]*\bWHERE\b)/i,
    remedy: "add a WHERE clause, or take a backup and say that the whole table is meant",
  },
  {
    id: "tls-verify-off",
    severity: "high",
    pattern:
      /\bverify\s*=\s*False\b|rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|-SkipCertificateCheck/,
    remedy: "keep certificate checks on; fix the trust store or the clock instead",
  },
  {
    id: "http-unguarded-fetch",
    severity: "low",
    pattern:
      /\b(?:requests\.(?:get|post)|urllib\.request\.urlopen|fetch)\(\s*(?:request|req|params|args|input|url)\b/,
    remedy:
      "screen the host first so a private, loopback or link-local address cannot be reached (the kernel has guard_public_url)",
  },
];

const redact = (text: string, pattern: RegExp): string =>
  text.replace(
    new RegExp(pattern.source, pattern.flags.replace("g", "") + "g"),
    (hit) => `${hit.slice(0, 4)}…[redacted]`,
  );

/** Risks in the given files. Pure: the caller decides what to hand in and reads nothing from disk. */
export function scanRisks(files: { path: string; text: string }[]): RiskFinding[] {
  const findings: RiskFinding[] = [];
  for (const file of files) {
    const lines = file.text.split(/\r?\n/).slice(0, 20_000);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (line.length > 2000) continue;
      for (const rule of RISK_RULES) {
        if (!rule.pattern.test(line)) continue;
        if (rule.skip?.test(line)) continue;
        findings.push({
          rule: rule.id,
          severity: rule.severity,
          path: file.path,
          line: index + 1,
          excerpt: (rule.secret ? redact(line.trim(), rule.pattern) : line.trim()).slice(0, 160),
          remedy: rule.remedy,
        });
      }
    }
  }
  const order: Record<RiskSeverity, number> = { high: 0, medium: 1, low: 2 };
  return findings.sort(
    (a, b) =>
      order[a.severity] - order[b.severity] || a.path.localeCompare(b.path) || a.line - b.line,
  );
}

/** File the high and medium findings on the existing governance queue: discovery only, always-ask. */
export function fileRiskFindings(findings: RiskFinding[]): { filed: number; ids: string[] } {
  const ids: string[] = [];
  for (const finding of findings.filter((row) => row.severity !== "low")) {
    const result = proposeFabricLimitation({
      id: `risk-${finding.rule}-${fnv1a(`${finding.path}:${finding.line}`)}`,
      title: `${finding.rule} in ${base(finding.path)}:${finding.line}`,
      rationale: finding.remedy,
      evidence: [
        `${finding.path}:${finding.line}`,
        `severity ${finding.severity}`,
        finding.excerpt,
      ],
      kind: "security",
      risk: finding.severity === "high" ? "risky" : "review",
    });
    if (result.queued) ids.push(result.id);
  }
  return { filed: ids.length, ids };
}
