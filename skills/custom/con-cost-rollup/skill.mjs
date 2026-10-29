// FRIDAY · skill: con-cost-rollup
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
const DISCLAIMER =
  "This is a planning aid, not a substitute for a licensed engineer's calculations or sign-off, and it is not professional certification.";
export async function run(input = {}) {
  const items = [];
  for (const line of rows(input)) {
    const match = line.match(/^([0-9.]+)\s+([0-9.]+)\s+(.+)$/);
    if (!match) continue;
    const qty = Number(match[1]);
    const unitCost = Number(match[2]);
    items.push({ qty, unitCost, label: match[3].trim(), total: qty * unitCost });
  }
  if (!items.length) return { ok: false, error: "Need lines like '12 8.5 plywood 18mm'." };
  const subtotal = items.reduce((n, item) => n + item.total, 0);
  return { ok: true, disclaimer: DISCLAIMER, items, subtotal };
}

export default run;
