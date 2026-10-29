// FRIDAY · skill: trv-daily-budget
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
  const days = Math.max(1, num(input, "days"));
  if (!(amount > 0)) return { ok: false, error: "Need a positive amount and days." };
  const daily = amount / days;
  return {
    ok: true,
    disclaimer: "Planning helper only. FRIDAY does not book tickets, hotels, or visas.",
    amount,
    days,
    daily,
    sketch: { stay: daily * 0.45, food: daily * 0.3, local: daily * 0.15, buffer: daily * 0.1 },
  };
}

export default run;
