// FRIDAY · skill: dat-histogram-bins
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
  const vals = numbers(input);
  const bins = Math.max(2, Math.min(20, Math.round(num(input, "bins", 5))));
  if (!vals.length) return { ok: false, error: "Paste numbers to bin." };
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const width = (max - min) / bins || 1;
  const counts = Array.from({ length: bins }, () => 0);
  for (const v of vals) {
    const i = Math.min(bins - 1, Math.floor((v - min) / width));
    counts[i] += 1;
  }
  const table = counts.map((c, i) => ({
    from: min + i * width,
    to: min + (i + 1) * width,
    count: c,
  }));
  return { ok: true, bins, min, max, table };
}

export default run;
