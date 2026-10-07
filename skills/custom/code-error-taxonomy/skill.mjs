// FRIDAY · skill: code-error-taxonomy
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
  const code = String(input.code || input.text || "");
  if (!code.trim()) return { ok: false, error: "Paste source." };
  const throws = (code.match(/\bthrow\b|raise /g) || []).length;
  const catches = (code.match(/\bcatch\b|except /g) || []).length;
  const retries = (code.match(/retry|backoff/gi) || []).length;
  const emptyCatch = (code.match(/catch\s*(\([^)]*\))?\s*\{\s*\}/g) || []).length;
  return {
    ok: true,
    throws,
    catches,
    retries,
    emptyCatch,
    advice: emptyCatch
      ? "Empty catch blocks hide failures — log or rethrow."
      : "No empty catch blocks in this paste.",
  };
}

export default run;
