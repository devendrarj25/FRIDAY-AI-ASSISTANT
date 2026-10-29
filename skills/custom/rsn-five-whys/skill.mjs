// FRIDAY · skill: rsn-five-whys
// Runs inside the sandbox harness, which calls run(input).
// Deterministic, offline, no network.

function num(input, key, fallback = 0) {
  const n = Number(input?.[key]);
  return Number.isFinite(n) ? n : fallback;
}
function text(input) {
  return String(input?.text ?? input?.prompt ?? input?.code ?? "");
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
  const lines = rows(input);
  if (!lines.length) return { ok: false, error: "Paste the problem, optionally with why-answers." };
  const problem = lines[0];
  const answers = lines.slice(1).slice(0, 5);
  const ladder = [];
  for (let i = 0; i < 5; i += 1) ladder.push({ why: i + 1, answer: answers[i] || null });
  return { ok: true, problem, ladder, complete: ladder.every((step) => step.answer) };
}

export default run;
