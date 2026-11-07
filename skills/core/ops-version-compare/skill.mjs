// FRIDAY · skill: ops-version-compare
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Compares version numbers (semver, four-part FRIDAY versions, Python, Node), sorts a list and checks a minimum.

const PATTERN = /\bv?\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z.-]+)?/g;

export function parseVersion(text) {
  const m = String(text)
    .trim()
    .match(/^v?(\d+(?:\.\d+){0,3})(?:-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!m) return null;
  return {
    raw: String(text).trim(),
    parts: m[1].split(".").map(Number),
    pre: m[2] ? m[2].split(".") : [],
  };
}

function comparePre(a, b) {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1; // a release is newer than its pre-release
  if (!b.length) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const an = /^\d+$/.test(a[i]);
    const bn = /^\d+$/.test(b[i]);
    if (an && bn) {
      if (Number(a[i]) !== Number(b[i])) return Number(a[i]) < Number(b[i]) ? -1 : 1;
    } else if (an !== bn) return an ? -1 : 1;
    else if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

export function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i += 1) {
    const x = a.parts[i] ?? 0;
    const y = b.parts[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return comparePre(a.pre, b.pre);
}

const LEVELS = ["major", "minor", "patch", "build"];
function firstDifference(a, b) {
  for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i += 1) {
    if ((a.parts[i] ?? 0) !== (b.parts[i] ?? 0)) return LEVELS[i] ?? `part ${i + 1}`;
  }
  return comparePre(a.pre, b.pre) !== 0 ? "pre-release" : null;
}

export async function run(input = {}) {
  const raw = Array.isArray(input?.versions) ? input.versions.map(String) : null;
  const text = String(input?.text ?? input?.prompt ?? "");
  const tokens = raw ?? text.match(PATTERN) ?? [];
  // Bare whole numbers (18, 5000) are not versions unless a dotted version or a version word is present.
  const dotted = tokens.some((t) => /\d\.\d/.test(t));
  const wordy =
    /\b(version|versions|newer|older|latest|upgrade|release|semver|minimum)\b/i.test(text) ||
    Boolean(input?.minimum);
  const versions = raw || dotted || wordy ? tokens.map(parseVersion).filter(Boolean) : [];
  if (versions.length < 1 || (versions.length < 2 && !input?.minimum)) {
    return {
      ok: false,
      error:
        "Give two or more versions, for example: is 22.19.0 at least 22.4.1, or sort 1.1.5.7 1.1.5.10 1.1.4.",
    };
  }
  const minimum = input?.minimum ? parseVersion(input.minimum) : null;
  const sorted = [...versions].sort(compareVersions);
  const out = {
    ok: true,
    sortedOldestFirst: sorted.map((v) => v.raw),
    newest: sorted[sorted.length - 1].raw,
    oldest: sorted[0].raw,
  };
  if (versions.length === 2) {
    const [a, b] = versions;
    const c = compareVersions(a, b);
    out.relation =
      c === 0
        ? "equal"
        : c > 0
          ? `${a.raw} is newer than ${b.raw}`
          : `${a.raw} is older than ${b.raw}`;
    out.differsAt = firstDifference(a, b);
    out.answer = out.relation + (out.differsAt ? ` (first difference: ${out.differsAt})` : "");
  } else {
    out.answer = `Newest ${out.newest}, oldest ${out.oldest}; oldest to newest: ${out.sortedOldestFirst.join(" < ")}.`;
  }
  if (minimum) {
    out.minimum = minimum.raw;
    out.meetsMinimum = versions.map((v) => ({
      version: v.raw,
      ok: compareVersions(v, minimum) >= 0,
    }));
    out.answer += ` Against minimum ${minimum.raw}: ${out.meetsMinimum.map((m) => `${m.version} ${m.ok ? "meets" : "is below"}`).join(", ")}.`;
  }
  out.note =
    "Missing parts count as 0 (22.19 = 22.19.0). A pre-release (-rc.1) is older than its release. Parts are compared as numbers: 1.10 is newer than 1.9.";
  return out;
}

export default run;
