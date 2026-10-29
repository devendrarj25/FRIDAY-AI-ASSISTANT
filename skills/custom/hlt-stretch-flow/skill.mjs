// FRIDAY · skill: hlt-stretch-flow
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
  const minutes = Math.max(5, Math.round(num(input, "minutes", 10)));
  const each = Math.max(30, Math.floor((minutes * 60) / 6));
  const steps = [
    "neck rolls",
    "shoulder opens",
    "hip flexor lunge",
    "hamstring fold",
    "figure-four",
    "easy breath",
  ].map((name) => ({ name, seconds: each }));
  return {
    ok: true,
    disclaimer:
      "Education and templates only — not medical advice, diagnosis, or treatment. Ask a clinician for personal health decisions.",
    minutes,
    steps,
  };
}

export default run;
