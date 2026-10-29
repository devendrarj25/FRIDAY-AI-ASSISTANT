// FRIDAY · skill: ckn-baker-ratio
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
  const flour = num(input, "flourGrams") || numbers(input)[0];
  const others = numbers(input).slice(flour === numbers(input)[0] ? 1 : 0);
  if (!(flour > 0)) return { ok: false, error: "Need flour grams plus other weights." };
  const pct = others.map((g) => ({ grams: g, bakerPct: Math.round((g / flour) * 1000) / 10 }));
  return { ok: true, flour, pct };
}

export default run;
