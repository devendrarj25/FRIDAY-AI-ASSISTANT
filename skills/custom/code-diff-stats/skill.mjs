// FRIDAY · skill: code-diff-stats
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
  const lines = String(input.text || input.code || "").split(/\n/);
  if (!lines.some((l) => l.startsWith("+++") || l.startsWith("@@") || l.startsWith("diff "))) {
    return { ok: false, error: "Paste a unified diff." };
  }
  const files = lines.filter((l) => l.startsWith("+++ ")).map((l) => l.slice(4).trim());
  const plus = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  const minus = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
  return { ok: true, files, plus, minus, net: plus - minus };
}

export default run;
