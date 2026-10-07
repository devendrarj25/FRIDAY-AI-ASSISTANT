// FRIDAY · skill: hom-meal-slots
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
  const leftover = rows(input);
  const days = Math.max(1, Math.min(5, Math.round(num(input, "days", 3))));
  if (!leftover.length) return { ok: false, error: "List leftover dishes." };
  const slots = [];
  for (let d = 1; d <= days; d += 1) {
    slots.push({
      day: d,
      lunch: leftover[(d - 1) % leftover.length],
      dinner: leftover[d % leftover.length],
    });
  }
  return { ok: true, slots };
}

export default run;
