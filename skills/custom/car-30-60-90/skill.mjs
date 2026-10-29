// FRIDAY · skill: car-30-60-90
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
  const role = String(input.role || "this role");
  const plan = {
    d30: [
      "learn how " + role + " actually runs",
      "meet the people you depend on",
      "one small delivery",
    ],
    d60: ["own a recurring slice", "write down what is broken"],
    d90: ["propose one improvement", "show a before/after"],
  };
  return { ok: true, role, plan };
}

export default run;
