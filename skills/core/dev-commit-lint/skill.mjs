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

export async function run(input = {}) {
  let text = String(input?.message ?? input?.text ?? input?.prompt ?? "").replace(/\r\n/g, "\n");
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
  if (subject.length > 72) problems.push(`Subject is ${subject.length} characters; keep it to 72.`);
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
    answer: problems.length ? `Not valid: ${problems.join(" ")}` : "Valid Conventional Commit.",
  };
}

export default run;
