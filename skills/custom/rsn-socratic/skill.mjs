// FRIDAY · skill: rsn-socratic
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
  const claim = text(input).trim() || rows(input)[0];
  if (!claim) return { ok: false, error: "Paste a claim or problem." };
  return {
    ok: true,
    claim,
    questions: [
      `What exactly do you mean by the key terms in: ${claim.slice(0, 80)}?`,
      "What evidence would change your mind?",
      "What is the strongest contrary explanation?",
      "Who is affected if this is wrong?",
      "What would you do in the next hour if this were already decided?",
    ],
  };
}

export default run;
