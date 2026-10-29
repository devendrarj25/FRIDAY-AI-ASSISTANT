// FRIDAY · skill: hlt-sleep-debt
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
  const hours = numbers(input);
  const target = num(input, "target", 8);
  if (!hours.length) return { ok: false, error: "Paste hours slept per night." };
  const debt = hours.map((h) => ({ slept: h, gap: target - h }));
  const total = debt.reduce((n, d) => n + d.gap, 0);
  return {
    ok: true,
    disclaimer:
      "Education and templates only — not medical advice, diagnosis, or treatment. Ask a clinician for personal health decisions.",
    target,
    debt,
    totalGap: total,
  };
}

export default run;
