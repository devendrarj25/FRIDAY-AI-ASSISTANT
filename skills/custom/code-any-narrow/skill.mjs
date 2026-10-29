// FRIDAY · skill: code-any-narrow
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
  const lines = String(input.code || input.text || "").split(/\n/);
  const hits = [];
  lines.forEach((line, index) => {
    if (/\bas any\b|:\s*any\b|<any>/.test(line))
      hits.push({ line: index + 1, text: line.trim().slice(0, 200) });
  });
  return { ok: true, count: hits.length, hits };
}

export default run;
