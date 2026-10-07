// FRIDAY · skill: off-checklist-from-text
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
  const bits = text(input)
    .split(/\r?\n|,|;|(?<=\.)\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
  if (!bits.length) return { ok: false, error: "Paste the items to check off." };
  const markdown = bits.map((b, i) => i + 1 + ". [ ] " + b.replace(/^[-*\d.\s]+/, "")).join("\n");
  return { ok: true, count: bits.length, markdown };
}

export default run;
