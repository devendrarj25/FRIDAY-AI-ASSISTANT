// FRIDAY · skill: hlt-hydration-plan
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
  const kg = num(input, "kg");
  if (!(kg > 0)) return { ok: false, error: "Type a body-weight kg figure." };
  const ml = Math.round(kg * 30);
  return {
    ok: true,
    disclaimer:
      "Education and templates only — not medical advice, diagnosis, or treatment. Ask a clinician for personal health decisions.",
    kg,
    ml,
    glasses250ml: Math.round(ml / 250),
    note: "Rule-of-thumb education, not a medical fluid order.",
  };
}

export default run;
