// FRIDAY · skill: law-nda-outline
// Runs inside the sandbox harness, which calls run(input).
// Deterministic, offline, no network.

function num(input, key, fallback = 0) {
  const n = Number(input?.[key]);
  return Number.isFinite(n) ? n : fallback;
}
function text(input) {
  return String(input?.text ?? input?.prompt ?? input?.code ?? input?.notes ?? "");
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
  const sections = [
    "Parties",
    "Purpose / definition of confidential information",
    "Exclusions (public, independently developed, required by law)",
    "Use limits",
    "Term and return/destruction",
    "Remedies reminder (jurisdiction to be filled by counsel)",
  ];
  return {
    ok: true,
    disclaimer:
      "Template / education only — not legal advice. Have a licensed lawyer review anything you will sign.",
    markdown: sections.map((s, i) => i + 1 + ". " + s).join("\n"),
  };
}

export default run;
