// FRIDAY · skill: wrt-tighten
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
  const src = text(input);
  if (!src.trim()) return { ok: false, error: "Paste the draft to tighten." };
  const filler =
    /\b(very|really|actually|basically|in order to|due to the fact that|it is important to note that)\b/gi;
  const out = src
    .replace(filler, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .trim();
  return { ok: true, before: src.split(/\s+/).length, after: out.split(/\s+/).length, text: out };
}

export default run;
