// FRIDAY · skill: hlt-food-label
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
  const src = text(input);
  if (!src.trim()) return { ok: false, error: "Paste label lines." };
  const n = (re) => {
    const m = src.match(re);
    return m ? Number(m[1]) : null;
  };
  const kcal = n(/(\d+(?:\.\d+)?)\s*kcal/i) ?? n(/calories[^\d]*(\d+)/i);
  const protein = n(/protein[^\d]*(\d+(?:\.\d+)?)/i);
  const sugar = n(/sugars?[^\d]*(\d+(?:\.\d+)?)/i);
  const salt = n(/(?:salt|sodium)[^\d]*(\d+(?:\.\d+)?)/i);
  return {
    ok: true,
    disclaimer:
      "Education and templates only — not medical advice, diagnosis, or treatment. Ask a clinician for personal health decisions.",
    kcal,
    protein,
    sugar,
    salt,
  };
}

export default run;
