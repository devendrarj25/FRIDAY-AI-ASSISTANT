// FRIDAY · skill: car-cover-letter
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
  const notes = rows(input);
  const letter = [
    "Dear Hiring Team,",
    "",
    "I am writing about " + role + ".",
    notes[0] || "Here is the match in one sentence.",
    "",
    notes[1] || "Proof point.",
    notes[2] || "Second proof point.",
    "",
    "I would welcome a conversation.",
    "",
    "Thank you,",
    "[Name]",
  ].join("\n");
  return { ok: true, letter };
}

export default run;
