// FRIDAY · skill: hlt-workout-split
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
  const days = Math.max(2, Math.min(6, Math.round(num(input, "days", 3))));
  const splits = {
    2: ["full body", "full body"],
    3: ["push", "pull", "legs"],
    4: ["upper", "lower", "upper", "lower"],
    5: ["push", "pull", "legs", "upper", "lower"],
    6: ["push", "pull", "legs", "push", "pull", "legs"],
  };
  return {
    ok: true,
    disclaimer:
      "Education and templates only — not medical advice, diagnosis, or treatment. Ask a clinician for personal health decisions.",
    days,
    split: splits[days],
  };
}

export default run;
