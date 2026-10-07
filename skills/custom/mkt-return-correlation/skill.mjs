// FRIDAY · skill: mkt-return-correlation
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
  const a = numbers(input, "seriesA");
  const b = numbers(input, "seriesB");
  const nObs = Math.min(a.length, b.length);
  if (nObs < 3)
    return { ok: false, error: "Need at least three paired returns in seriesA and seriesB." };
  const aa = a.slice(0, nObs);
  const bb = b.slice(0, nObs);
  const ma = aa.reduce((x, y) => x + y, 0) / nObs;
  const mb = bb.reduce((x, y) => x + y, 0) / nObs;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < nObs; i += 1) {
    cov += (aa[i] - ma) * (bb[i] - mb);
    va += (aa[i] - ma) ** 2;
    vb += (bb[i] - mb) ** 2;
  }
  cov /= nObs - 1;
  va /= nObs - 1;
  vb /= nObs - 1;
  const corr = va && vb ? cov / Math.sqrt(va * vb) : null;
  return { ok: true, scope: SCOPE, n: nObs, correlation: corr };
}

export default run;
