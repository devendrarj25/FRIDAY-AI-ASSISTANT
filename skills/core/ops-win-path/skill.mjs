// FRIDAY · skill: ops-win-path
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Checks Windows paths for the problems that break installs and file tools, and converts to and from WSL paths.

const RESERVED = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);
const PROTECTED = [
  /\\Windows(\\|$)/i,
  /\\Program Files( \(x86\))?(\\|$)/i,
  /\\ProgramData(\\|$)/i,
  /^[A-Za-z]:\\?$/,
];
const SYNCED = [/\\OneDrive[^\\]*(\\|$)/i, /\\Dropbox(\\|$)/i, /\\Google Drive(\\|$)/i];

function pathsOf(input) {
  const direct = input?.path ?? input?.paths;
  if (Array.isArray(direct)) return direct.map(String);
  if (typeof direct === "string" && direct.trim()) return [direct.trim()];
  const raw = String(input?.text ?? input?.prompt ?? "");
  const quoted = [...raw.matchAll(/"([^"\r\n]+)"/g)].map((m) => m[1].trim());
  if (quoted.length) return quoted;
  // A path may hold spaces ("Program Files") and a bad character, so it runs from its start to the next
  // path start, a line end, a comma, a semicolon or " and " / " or ".
  const starts = [...raw.matchAll(/(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|\/mnt\/[a-z](?:\/|\b))/g)].map(
    (m) => m.index,
  );
  const out = starts.map((at, i) => {
    let seg = raw.slice(at, starts[i + 1] ?? raw.length);
    seg = seg.split(/\r?\n|,\s|;\s|\s+(?:and|or|vs)\s+/i)[0];
    return seg.trim();
  });
  return out.filter(Boolean);
}

function toWsl(p) {
  const drive = p.match(/^([A-Za-z]):[\\/]?(.*)$/);
  if (drive)
    return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, "/")}`.replace(/\/$/, "");
  return null;
}
function fromWsl(p) {
  const m = p.match(/^\/mnt\/([a-z])(?:\/(.*))?$/);
  return m ? `${m[1].toUpperCase()}:\\${(m[2] ?? "").replace(/\//g, "\\")}` : null;
}

function check(original) {
  const problems = [];
  const warnings = [];
  let p = original;
  const wslForm = fromWsl(p);
  if (wslForm) {
    warnings.push("This is a WSL path; the Windows form is shown below.");
    p = wslForm;
  }
  const unc = /^\\\\/.test(p);
  const drive = /^[A-Za-z]:/.test(p);
  const longPrefix = /^\\\\\?\\/.test(p);
  if (!unc && !drive)
    warnings.push("Relative path: it depends on the folder the program starts in.");
  const body = longPrefix ? p.slice(4) : p;
  const rest = drive ? body.slice(2) : body;
  if (/[<>"|?*]/.test(rest.replace(/^\\\\\?\\/, "")))
    problems.push('Contains a character Windows forbids in names: < > " | ? *');
  if (/:/.test(rest))
    problems.push(
      "A colon is only allowed right after the drive letter (it creates an alternate data stream otherwise).",
    );
  if (/[\u0000-\u001f]/.test(p)) problems.push("Contains a control character.");
  if (/\//.test(p) && /\\/.test(p)) warnings.push("Mixes / and \\ separators.");
  const parts = body.split(/[\\/]+/).filter((x, i) => x || i === 0);
  for (const part of parts.slice(drive ? 1 : 0)) {
    if (!part) continue;
    const stem = part.split(".")[0].toUpperCase();
    if (RESERVED.has(stem)) problems.push(`"${part}" is a reserved device name (${stem}).`);
    if (/[. ]$/.test(part) && part !== "." && part !== "..")
      problems.push(`"${part}" ends with a dot or a space, which Windows silently drops.`);
    if (part.length > 255) problems.push(`A name is ${part.length} characters; the limit is 255.`);
  }
  if (!longPrefix && p.length >= 260) {
    problems.push(
      `The path is ${p.length} characters; the classic limit is 260 (MAX_PATH). Use the \\\\?\\ prefix or enable long paths.`,
    );
  } else if (!longPrefix && p.length >= 200) {
    warnings.push(`${p.length} characters is close to the 260 limit once a file name is added.`);
  }
  if (PROTECTED.some((re) => re.test(p)))
    warnings.push("A protected location: writing here needs administrator rights.");
  if (SYNCED.some((re) => re.test(p)))
    warnings.push(
      "A cloud-synced folder: sync clients can lock files while a build or install runs.",
    );
  if (/\s/.test(p)) warnings.push("The path has spaces: quote it on the command line.");
  if (/[^\u0000-\u007f]/.test(p))
    warnings.push("Non-ASCII characters: some older tools mishandle them.");
  const suggestion = original
    .replace(/[<>"|?*]/g, "_")
    .replace(/(?<=[\\/])([^\\/]*?)[. ]+(?=[\\/]|$)/g, "$1");
  return {
    path: original,
    ok: problems.length === 0,
    problems,
    warnings,
    windows: wslForm ?? (drive || unc ? p : null),
    wsl: toWsl(p),
    ...(problems.length && suggestion !== original ? { suggestion } : {}),
  };
}

export async function run(input = {}) {
  const paths = pathsOf(input);
  if (!paths.length)
    return { ok: false, error: "Give a path such as C:\\Users\\me\\FRIDAY or /mnt/d/FRIDAY." };
  const results = paths.map(check);
  const bad = results.filter((r) => !r.ok);
  return {
    ok: true,
    answer: bad.length
      ? `${bad.length} of ${results.length} path(s) have a problem: ${bad[0].problems[0]}`
      : `${results.length} path(s) are valid.`,
    results,
  };
}

export default run;
