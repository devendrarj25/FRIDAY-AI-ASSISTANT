// FRIDAY · skill: con-rfi-checklist
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
const DISCLAIMER =
  "This is a planning aid, not a substitute for a licensed engineer's calculations or sign-off, and it is not professional certification.";
const FIELDS = ["drawing", "spec", "question", "options", "needed-by", "impact"];
export async function run(input = {}) {
  const blob = text(input).toLowerCase();
  const present = FIELDS.filter(
    (field) => blob.includes(field) || (field === "needed-by" && /\bby\s+\d/.test(blob)),
  );
  const drawings = Array.from(
    text(input).matchAll(/\b(?:dwg|drawing)\s*[:#]?\s*([A-Z0-9._-]+)/gi),
  ).map((m) => m[1]);
  return {
    ok: true,
    disclaimer: DISCLAIMER,
    present,
    missing: FIELDS.filter((f) => !present.includes(f)),
    drawings,
  };
}

export default run;
