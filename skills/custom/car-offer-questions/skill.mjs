// FRIDAY · skill: car-offer-questions
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
  const extra = rows(input);
  const qs = [
    "What does success look like at 90 days?",
    "What is the pay cadence and any variable piece?",
    "Equipment / expenses?",
    "Who do I actually work with day to day?",
    "What is the notice / probation?",
    ...extra,
  ];
  return { ok: true, questions: qs };
}

export default run;
