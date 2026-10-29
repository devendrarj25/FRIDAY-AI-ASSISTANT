// FRIDAY · skill: mkt-allocation-mix
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
const SCOPE =
  "Informational analysis, education, or calculation only. FRIDAY has no brokerage or exchange connection and cannot place, execute, or automate a real trade.";
export async function run(input = {}) {
  const parsed = [];
  for (const line of rows(input)) {
    const match = line.match(/^(.+?)[,:\s]+([0-9.]+)\s*%?$/);
    if (!match) continue;
    parsed.push({ name: match[1].trim(), weight: Number(match[2]) });
  }
  if (!parsed.length) return { ok: false, error: "Need lines like 'equity 60'." };
  const sum = parsed.reduce((n, row) => n + row.weight, 0);
  const mix = parsed.map((row) => ({
    ...row,
    normalised: sum ? row.weight / sum : 0,
  }));
  return {
    ok: true,
    scope: SCOPE,
    sum,
    balanced: Math.abs(sum - 100) < 0.05 || Math.abs(sum - 1) < 0.0001,
    mix,
  };
}

export default run;
