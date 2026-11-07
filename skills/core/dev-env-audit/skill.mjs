// FRIDAY · skill: dev-env-audit
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Check the text of a .env file: duplicate or malformed lines, empty values, placeholders and real-looking secrets.
// It never repeats a value, only the key names and the length.

const SECRET_KEY =
  /(?:^|_)(?:key|secret|token|password|passwd|pwd|credential|private|auth)(?:_|$)/i;
const PLACEHOLDER =
  /^(?:changeme|change_me|xxx+|your[_-].*|<.*>|todo|tbd|example|replace.?me|\*+|none|null)$/i;

export async function run(input = {}) {
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
        message: "Names should be letters, digits and underscores, not starting with a digit.",
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
    if (value === "") issues.push({ line: n, key, rule: "empty", message: "Value is empty." });
    else if (PLACEHOLDER.test(value)) {
      issues.push({ line: n, key, rule: "placeholder", message: "Still a placeholder value." });
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

export default run;
