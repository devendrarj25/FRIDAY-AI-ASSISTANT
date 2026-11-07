// FRIDAY · skill: dev-project-checks
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Env file audit, commit message lint and version compare. Quality checks for the files and messages of a code project.
// It holds 3 small tools (parts). A request that names one runs it; otherwise every tool whose topic matches the
// request runs, the first answer is the main result and the others are listed under "also". Pass part to pick one.

const PARTS = [
  {
    id: "dev-env-audit",
    gate: /env|dotenv|\w+=/,
    run: (() => {
      // FRIDAY · skill: dev-env-audit
      // Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
      // Check the text of a .env file: duplicate or malformed lines, empty values, placeholders and real-looking secrets.
      // It never repeats a value, only the key names and the length.

      const SECRET_KEY =
        /(?:^|_)(?:key|secret|token|password|passwd|pwd|credential|private|auth)(?:_|$)/i;
      const PLACEHOLDER =
        /^(?:changeme|change_me|xxx+|your[_-].*|<.*>|todo|tbd|example|replace.?me|\*+|none|null)$/i;

      async function run(input = {}) {
        const text = String(input?.text ?? input?.prompt ?? "");
        const lines = text.split(/\r?\n/);
        const seen = new Map();
        const issues = [];
        const secrets = [];
        let assignments = 0;
        lines.forEach((raw, idx) => {
          const n = idx + 1;
          const line = raw.trim();
          if (!line || line.startsWith("#")) return;
          const m = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(line);
          if (!m) {
            if (/^[A-Za-z_][A-Za-z0-9_]*\s*:/.test(line)) return; // a leading prompt such as "check this env:"
            issues.push({ line: n, rule: "no-equals", message: "Line is not KEY=VALUE." });
            return;
          }
          assignments++;
          const key = m[1];
          let value = m[2].trim();
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            issues.push({
              line: n,
              key,
              rule: "bad-name",
              message:
                "Names should be letters, digits and underscores, not starting with a digit.",
            });
          }
          if (seen.has(key)) {
            issues.push({
              line: n,
              key,
              rule: "duplicate",
              message: `Already set on line ${seen.get(key)}; the later one wins.`,
            });
          } else seen.set(key, n);
          const quoted = /^(["']).*\1$/.test(value);
          if (/^["']/.test(value) && !quoted) {
            issues.push({ line: n, key, rule: "unclosed-quote", message: "Quote is not closed." });
          }
          if (quoted) value = value.slice(1, -1);
          if (m[2] !== m[2].trimEnd()) {
            issues.push({
              line: n,
              key,
              rule: "trailing-space",
              message: "Trailing spaces are part of the value.",
            });
          }
          if (value === "")
            issues.push({ line: n, key, rule: "empty", message: "Value is empty." });
          else if (PLACEHOLDER.test(value)) {
            issues.push({
              line: n,
              key,
              rule: "placeholder",
              message: "Still a placeholder value.",
            });
          } else if (SECRET_KEY.test(key)) secrets.push({ line: n, key, length: value.length });
        });
        if (!assignments) return { ok: false, error: "No KEY=VALUE lines found." };
        return {
          ok: true,
          variables: seen.size,
          issues,
          secretLooking: secrets,
          safeToCommit: secrets.length === 0,
          answer: `${seen.size} variable(s), ${issues.length} issue(s), ${secrets.length} secret-looking value(s)${secrets.length ? " (keep this file out of git)" : ""}.`,
        };
      }

      return run;
    })(),
  },
  {
    id: "dev-commit-lint",
    gate: /commit/,
    run: (() => {
      // FRIDAY · skill: dev-commit-lint
      // Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
      // Check a commit message against the Conventional Commits form this project uses, and flag attribution trailers.

      const TYPES = [
        "feat",
        "fix",
        "refactor",
        "perf",
        "docs",
        "test",
        "chore",
        "build",
        "ci",
        "style",
        "revert",
      ];

      async function run(input = {}) {
        let text = String(input?.message ?? input?.text ?? input?.prompt ?? "").replace(
          /\r\n/g,
          "\n",
        );
        text = text
          .replace(
            /^\s*(?:please\s+)?(?:check|lint|validate|review)\s+(?:this\s+|my\s+)?commit(?:\s+message)?\s*[:\-]\s*/i,
            "",
          )
          .replace(/^["'`]|["'`]$/g, "")
          .trim();
        if (!text) return { ok: false, error: "Give the commit message to check." };
        const lines = text.split("\n");
        const subject = lines[0];
        const problems = [];
        const m = /^([A-Za-z]+)(?:\(([^)]*)\))?(!)?:(\s*)(.*)$/.exec(subject);
        if (!m) {
          problems.push("Subject must look like type(scope): summary.");
        } else {
          const [, type, scope, , space, summary] = m;
          if (type !== type.toLowerCase()) problems.push("Type must be lower case.");
          if (!TYPES.includes(type.toLowerCase()))
            problems.push(`Unknown type "${type}"; use ${TYPES.join(", ")}.`);
          if (scope !== undefined && (scope.trim() === "" || /\s/.test(scope)))
            problems.push("Scope must be one word, or leave the brackets out.");
          if (space !== " ") problems.push("Put exactly one space after the colon.");
          if (!summary.trim()) problems.push("Summary is empty.");
          if (/\.$/.test(summary.trim())) problems.push("Summary should not end with a full stop.");
        }
        if (subject.length > 72)
          problems.push(`Subject is ${subject.length} characters; keep it to 72.`);
        if (lines.length > 1 && lines[1].trim() !== "")
          problems.push("Leave a blank line between the subject and the body.");
        const attribution = lines
          .slice(1)
          .filter((l) =>
            /^\s*co-authored-by\s*:|generated\s+(?:with|by)\b|\/code\/session|\bsession[_-]?id\b/i.test(
              l,
            ),
          );
        if (attribution.length) {
          problems.push(
            "Remove attribution trailers or session links: this project signs every commit as its owner only.",
          );
        }
        return {
          ok: true,
          valid: problems.length === 0,
          type: m ? m[1].toLowerCase() : null,
          scope: m && m[2] ? m[2] : null,
          breaking: Boolean(m && m[3]) || /^BREAKING[ -]CHANGE:/m.test(text),
          subjectLength: subject.length,
          problems,
          answer: problems.length
            ? `Not valid: ${problems.join(" ")}`
            : "Valid Conventional Commit.",
        };
      }

      return run;
    })(),
  },
  {
    id: "ops-version-compare",
    gate: null,
    run: (() => {
      // FRIDAY · skill: ops-version-compare
      // Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
      // Compares version numbers (semver, four-part FRIDAY versions, Python, Node), sorts a list and checks a minimum.

      const PATTERN =
        /\bv?\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z.-]+)?/g;

      function parseVersion(text) {
        const m = String(text)
          .trim()
          .match(
            /^v?(\d+(?:\.\d+){0,3})(?:-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?(?:\+[0-9A-Za-z.-]+)?$/,
          );
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

      function compareVersions(a, b) {
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

      async function run(input = {}) {
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
          out.answer =
            out.relation + (out.differsAt ? ` (first difference: ${out.differsAt})` : "");
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
