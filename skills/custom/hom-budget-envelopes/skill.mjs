// FRIDAY · skill: hom-budget-envelopes
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
  const names = rows(input);
  if (!(amount > 0) || !names.length)
    return { ok: false, error: "Need a positive amount and envelope names." };
  const share = amount / names.length;
  const envelopes = names.map((name) => ({
    name: name.replace(/[:].*$/, ""),
    amount: Math.round(share * 100) / 100,
  }));
  return { ok: true, amount, envelopes };
}

export default run;
