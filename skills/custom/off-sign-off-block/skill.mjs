// FRIDAY · skill: off-sign-off-block
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
  const name = String(input.name || "Name");
  const tone = String(input.tone || "neutral").toLowerCase();
  const all = {
    formal: ["Yours sincerely,", "Respectfully,"],
    neutral: ["Best regards,", "Kind regards,"],
    warm: ["Thanks so much,", "Warmly,"],
  };
  const picks = all[tone] || all.neutral;
  return { ok: true, tone, options: picks.map((p) => p + "\n" + name) };
}

export default run;
