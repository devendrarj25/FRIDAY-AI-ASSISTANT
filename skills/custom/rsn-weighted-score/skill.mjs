// FRIDAY · skill: rsn-weighted-score
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
  const totals = new Map();
  const detail = [];
  for (const line of rows(input)) {
    const parts = line.split(",").map((s) => s.trim());
    if (parts.length < 4) continue;
    const [option, criterion, w, s] = parts;
    const weight = Number(w);
    const score = Number(s);
    if (!Number.isFinite(weight) || !Number.isFinite(score)) continue;
    const add = weight * score;
    totals.set(option, (totals.get(option) || 0) + add);
    detail.push({ option, criterion, weight, score, add });
  }
  if (!detail.length) return { ok: false, error: "Need lines: option, criterion, weight, score." };
  const ranked = [...totals.entries()]
    .map(([option, total]) => ({ option, total }))
    .sort((a, b) => b.total - a.total);
  return { ok: true, detail, ranked };
}

export default run;
