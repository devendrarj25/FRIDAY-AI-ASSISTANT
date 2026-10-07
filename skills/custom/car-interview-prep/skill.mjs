// FRIDAY · skill: car-interview-prep
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
  const role = String(input.role || "the role");
  const terms = text(input)
    .split(/[^a-zA-Z0-9+#]+/)
    .filter((w) => w.length > 4)
    .slice(0, 6);
  const canned = [
    "Tell me about a time you disagreed.",
    "Walk me through a piece of work you are proud of.",
    "What would the first 30 days look like in " + role + "?",
  ];
  const custom = terms.map((t) => "How have you used " + t + "?");
  return { ok: true, questions: [...canned, ...custom] };
}

export default run;
