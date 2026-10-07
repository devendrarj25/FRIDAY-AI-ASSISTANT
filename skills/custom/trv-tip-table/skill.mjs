// FRIDAY · skill: trv-tip-table
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
  const amount = num(input, "amount");
  if (!(amount > 0)) return { ok: false, error: "Type the bill amount." };
  const pcts = [10, 12, 15, 18, 20];
  return {
    ok: true,
    amount,
    tips: pcts.map((p) => ({
      pct: p,
      tip: Math.round(amount * p) / 100,
      total: Math.round(amount * (1 + p / 100) * 100) / 100,
    })),
  };
}

export default run;
