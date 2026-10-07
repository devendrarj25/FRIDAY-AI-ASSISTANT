// FRIDAY · skill: car-reference-ask
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
  const role = String(input.role || "a role I am discussing");
  const why = String(input.why || text(input) || "we worked together");
  const body = [
    "Hi,",
    "",
    "Would you be willing to be a reference for " + role + "?",
    "I asked because " + why + ".",
    "I can send a short brief of the work if useful.",
    "",
    "Thank you",
  ].join("\n");
  return { ok: true, body };
}

export default run;
