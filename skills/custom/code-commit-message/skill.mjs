// FRIDAY · skill: code-commit-message
// Runs inside the sandbox harness, which calls run(input).
// Deterministic, offline, no network.

function num(input, key, fallback = 0) {
  const n = Number(input?.[key]);
  return Number.isFinite(n) ? n : fallback;
}
function text(input) {
  return String(input?.text ?? input?.prompt ?? input?.code ?? "");
}
function rows(input) {
  return text(input)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}
function numbers(input, key) {
  const raw = input?.[key] ?? input?.text ?? "";
  return String(raw)
    .split(/[,\s]+/)
    .map(Number)
    .filter((v) => Number.isFinite(v));
}
export async function run(input = {}) {
  const type =
    String(input.type || "chore")
      .replace(/[^a-z]/gi, "")
      .toLowerCase() || "chore";
  const lines = rows(input);
  if (!lines.length) return { ok: false, error: "Paste a diff summary or bullets." };
  const subject = lines[0].replace(/^#\s*/, "").slice(0, 72);
  const body = lines
    .slice(1)
    .map((l) => l.replace(/^[-*]\s*/, ""))
    .join("\n");
  return {
    ok: true,
    message: `${type}: ${subject}`,
    body,
    filesHint: lines.filter((l) => /\.(ts|js|py|cjs|mjs|go)\b/.test(l)),
  };
}

export default run;
