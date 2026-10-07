// FRIDAY · skill: dat-moving-average
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
  const window = Math.max(2, Math.round(num(input, "window", 3)));
  if (vals.length < window)
    return { ok: false, error: "Need at least as many numbers as the window." };
  const sma = [];
  for (let i = window - 1; i < vals.length; i += 1) {
    const slice = vals.slice(i - window + 1, i + 1);
    sma.push({ i, value: slice.reduce((n, v) => n + v, 0) / window });
  }
  return { ok: true, window, sma };
}

export default run;
