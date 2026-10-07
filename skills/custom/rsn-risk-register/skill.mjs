// FRIDAY · skill: rsn-risk-register
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
  const rowsOut = [];
  for (const line of rows(input)) {
    const parts = line.split("|").map((s) => s.trim());
    if (parts.length < 2) continue;
    const likelihood = Number(parts[1]);
    const impact = Number(parts[2]);
    const score =
      Number.isFinite(likelihood) && Number.isFinite(impact) ? likelihood * impact : null;
    rowsOut.push({
      risk: parts[0],
      likelihood: parts[1] || null,
      impact: parts[2] || null,
      mitigation: parts[3] || null,
      score,
    });
  }
  if (!rowsOut.length)
    return { ok: false, error: "Paste rows as risk | likelihood | impact | mitigation." };
  return { ok: true, rows: rowsOut.sort((a, b) => (b.score || 0) - (a.score || 0)) };
}

export default run;
