// FRIDAY · skill: std-quiz-mcq
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
  const facts = rows(input);
  if (!facts.length) return { ok: false, error: "Paste fact bullets." };
  const quiz = facts.slice(0, 10).map((fact) => ({
    q: "About: " + fact.slice(0, 80),
    correct: fact,
    distractors: ["[wrong option]", "[wrong option]"],
  }));
  return { ok: true, count: quiz.length, quiz };
}

export default run;
