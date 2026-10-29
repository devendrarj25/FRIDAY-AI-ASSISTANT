// FRIDAY · skill: law-rfp-questions
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
  const lines = rows(input);
  if (!lines.length) return { ok: false, error: "Paste RFP fragments." };
  const flagged = lines.filter(
    (l) => /\b(tbd|n\/a|missing|to be confirmed|\?\?\?)\b/i.test(l) || l.length < 8,
  );
  const questions = (flagged.length ? flagged : lines.slice(0, 5)).map(
    (l) => "Please clarify: " + l,
  );
  return {
    ok: true,
    disclaimer:
      "Template / education only — not legal advice. Have a licensed lawyer review anything you will sign.",
    questions,
  };
}

export default run;
